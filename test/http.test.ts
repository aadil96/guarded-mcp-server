import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApprovals } from '../src/approvals/index.js';
import { runApprovalsCli } from '../src/approvals/cli.js';
import { mintToken, parseTokenConfig, type TokenEntry } from '../src/auth/tokens.js';
import { closeAppDb, connectAsApp } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';
import type { AppDb } from '../src/db/types.js';
import { RejectionAuditor } from '../src/http/rejections.js';
import { startHttpServer } from '../src/http/server.js';
import { serverTools } from '../src/server.js';
import { approvalHandlers } from '../src/tools/framework.js';
import { freshDb, mcpClient } from './helpers.js';

let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: AppDb;
let srv: Awaited<ReturnType<typeof startHttpServer>>;
let invoiceId = '';
const logs: string[] = [];
const reader = mintToken('reader-bot', ['read']);
const operator = mintToken('alice', ['refund:request']);
const raws = [reader.token, operator.token];
let tokens: TokenEntry[];

const rows = async <T>(q: string, p: unknown[] = []) => (await ctx.client.query<T>(q, p)).rows;
const auditCount = async () => (await rows<{ n: number }>('select count(*)::int n from audit_events'))[0].n;
const lastAudit = async () => (await rows<Record<string, unknown>>(
  'select actor, role, tool, outcome, error_code, arguments from audit_events order by created_at desc, id desc limit 1'))[0];

async function connect(token: string) {
  const client = new Client({ name: 'http-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(srv.url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
const post = (headers: Record<string, string>, body: BodyInit = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), url = srv.url) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body });
const text = (r: { content: unknown }) => JSON.parse((r.content as { text: string }[])[0].text);

/** Key-sorted JSON, so two tools/list payloads compare by content, not key order. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);

beforeAll(async () => {
  for (const m of ['log', 'error', 'warn', 'info'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  }
  ctx = await freshDb();
  await seed(ctx.db);
  invoiceId = (await rows<{ id: string }>(`select id from invoices where status = 'paid' order by invoice_number limit 1`))[0].id;
  if (ctx.url) db = await connectAsApp(ctx.url);
  else { await ctx.client.query('set role meridian_app'); db = ctx.db as unknown as AppDb; }
  tokens = parseTokenConfig(`# test tokens\n${reader.line}\n${operator.line}\n`);
  srv = await startHttpServer({ db, tokens, allowedOrigins: ['console.example.test'], rejectionLimits: { burst: 1000, refillPerSecond: 1000, maxTrackedIps: 100 } });
});
afterAll(async () => {
  await srv.close();
  if (ctx.url) await closeAppDb(db);
  await ctx.client.close();
  vi.restoreAllMocks();
});

describe('HTTP transport: authentication', () => {
  it('binds to 127.0.0.1 by default', () => {
    expect(srv.url.hostname).toBe('127.0.0.1');
  });

  it('no token: 401 with a Bearer challenge, audited as anonymous', async () => {
    const before = await auditCount();
    const r = await post({});
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/^Bearer realm="guarded-mcp-server"/);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect(await auditCount()).toBe(before + 1);
    expect(await lastAudit()).toMatchObject({ actor: 'anonymous', role: 'invalid', tool: 'http', outcome: 'denied', error_code: 'missing_token' });
  });

  it('wrong token or malformed header: 401 invalid_token', async () => {
    for (const h of [`Bearer ${reader.token}x`, `Basic ${reader.token}`, 'Bearer ']) {
      const r = await post({ authorization: h });
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toContain('error="invalid_token"');
    }
    expect(await lastAudit()).toMatchObject({ actor: 'anonymous', error_code: 'invalid_token' });
  });
});

describe('HTTP transport: scopes', () => {
  it('tools/list over HTTP is identical to stdio for every token', async () => {
    const stdio = await mcpClient(db, { actor: 'stdio', role: 'reader' });
    try {
      const expected = canonical((await stdio.send('tools/list', {})).result);
      for (const t of raws) {
        const c = await connect(t);
        try { expect(canonical(await c.listTools())).toBe(expected); } finally { await c.close(); }
      }
    } finally { await stdio.close(); }
  });

  it('read token: read tools work; issue_refund is refused with insufficient_scope, audited once', async () => {
    const c = await connect(reader.token);
    try {
      const ok = await c.callTool({ name: 'get_invoice', arguments: { invoice_id: invoiceId } });
      expect(ok.isError).toBeFalsy();
      expect(await lastAudit()).toMatchObject({ actor: 'reader-bot', role: 'reader', tool: 'get_invoice', outcome: 'ok' });
      const before = await auditCount();
      const r = await c.callTool({ name: 'issue_refund', arguments: { invoice_id: invoiceId, amount_paise: 100, reason: 'x', idempotency_key: 'http-read' } });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatchObject({ error: 'insufficient_scope', requiredScope: 'refund:request' });
      expect(await auditCount()).toBe(before + 1);
      expect(await lastAudit()).toMatchObject({ actor: 'reader-bot', role: 'reader', tool: 'issue_refund', outcome: 'denied', error_code: 'insufficient_scope' });
      expect(await rows('select 1 from approvals where idempotency_key = $1', ['http-read'])).toEqual([]);
    } finally { await c.close(); }
  });

  it('refund:request token: the refund is pending, requested by the token actor; args cannot change the actor', async () => {
    const c = await connect(operator.token);
    try {
      const r = await c.callTool({ name: 'issue_refund', arguments: { invoice_id: invoiceId, amount_paise: 250, reason: 'damaged', idempotency_key: 'http-op' } });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toMatchObject({ status: 'pending_approval', approvalId: expect.any(String) });
      expect(await lastAudit()).toMatchObject({ actor: 'alice', role: 'operator', tool: 'issue_refund', outcome: 'pending_approval' });
      expect(await rows('select requested_by, status from approvals where idempotency_key = $1', ['http-op'])).toEqual([{ requested_by: 'alice', status: 'pending' }]);
      const forged = await c.callTool({ name: 'issue_refund', arguments: { invoice_id: invoiceId, amount_paise: 250, reason: 'x', idempotency_key: 'http-forge', actor: 'admin', role: 'admin' } });
      expect(forged.isError).toBe(true);
      expect(await rows('select 1 from approvals where idempotency_key = $1', ['http-forge'])).toEqual([]);
    } finally { await c.close(); }
  });

  it('no token can approve: no approval tool exists and no scope maps to admin', async () => {
    const c = await connect(operator.token);
    try {
      const names = (await c.listTools()).tools.map((t) => t.name);
      expect(names.filter((n) => /approve|resolve|execute|deny/.test(n))).toEqual([]);
      const r = await c.callTool({ name: 'resolve_approval', arguments: {} }).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify(e.message) }] }));
      expect(r.isError).toBe(true);
    } finally { await c.close(); }
    expect(() => parseTokenConfig(`sha256:${'a'.repeat(64)} root admin`)).toThrow(/unknown scope "admin"/);
  });

  it('the token actor cannot approve their own request through the console either', async () => {
    const [{ id }] = await rows<{ id: string }>('select id from approvals where idempotency_key = $1', ['http-op']);
    const res = await runApprovalsCli(['approve', id], {
      db, caller: { actor: 'alice', role: 'admin' }, approvals: createApprovals({ singleOperator: false }), handlers: approvalHandlers(serverTools),
    });
    expect(res.code).not.toBe(0);
    expect(res.output).toMatchObject({ kind: 'denied', reason: 'self_approval_forbidden' });
    expect(await rows('select status from approvals where id = $1', [id])).toEqual([{ status: 'pending' }]);
  });
});

describe('HTTP transport: request guards', () => {
  it('rejects a foreign Origin (DNS rebinding) and a foreign Host with 403, even with a valid token', async () => {
    const auth = { authorization: `Bearer ${operator.token}` };
    expect((await post({ ...auth, origin: 'https://evil.example' })).status).toBe(403);
    expect(await lastAudit()).toMatchObject({ actor: 'anonymous', error_code: 'forbidden_origin' });
    expect((await post({ ...auth, origin: 'null' })).status).toBe(403);
    expect((await post({ ...auth, origin: `http://localhost:${srv.url.port}` })).status).toBe(200);
    expect((await post({ ...auth, origin: 'https://console.example.test' })).status).toBe(200);
    const rebound = await new Promise<number>((resolve, reject) => {
      // fetch() won't let a script set Host, so use node:http for the rebinding case.
      import('node:http').then(({ request }) => {
        const req = request(srv.url, { method: 'POST', headers: { host: 'attacker.example', ...auth, 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on('error', reject);
        req.end('{}');
      }, reject);
    });
    expect(rebound).toBe(403);
    expect(await lastAudit()).toMatchObject({ error_code: 'invalid_host' });
  });

  it('caps the body at 1 MiB with 413, declared or streamed, before parsing', async () => {
    const big = 'x'.repeat(1024 * 1024 + 1);
    const declared = await post({ authorization: `Bearer ${operator.token}` }, big);
    expect(declared.status).toBe(413);
    // The declared size is checked before authentication, so an anonymous oversized request never gets read.
    expect((await post({}, big)).status).toBe(413);
    expect(await lastAudit()).toMatchObject({ actor: 'anonymous', role: 'invalid', error_code: 'body_too_large' });
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    const streamed = await fetch(srv.url, {
      method: 'POST', body: stream, duplex: 'half',
      headers: { authorization: `Bearer ${operator.token}`, 'content-type': 'application/json' },
    } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(await lastAudit()).toMatchObject({ actor: 'alice', role: 'operator', error_code: 'body_too_large' });
  });

  it('refuses GET and DELETE (stateless: no session streams)', async () => {
    const before = await auditCount();
    const r = await fetch(srv.url, { method: 'GET', headers: { authorization: `Bearer ${reader.token}` } });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('POST');
    // The SDK client sends this GET probe on every connection, so it is not a security event.
    expect(await auditCount()).toBe(before);
  });
});

describe('HTTP transport: bounded rejection audit', () => {
  it('a flood of bad-token requests writes at most the burst, then one summary row for the rest', async () => {
    let t = 0;
    const flood = await startHttpServer({ db, tokens, rejectionLimits: { burst: 5, refillPerSecond: 1, maxTrackedIps: 100 }, now: () => t });
    try {
      const before = await rows<{ n: number }>(`select count(*)::int n from audit_events where tool = 'http'`);
      const statuses = await Promise.all(Array.from({ length: 40 }, () => post({ authorization: 'Bearer nope' }, undefined, flood.url).then((r) => r.status)));
      expect(new Set(statuses)).toEqual(new Set([401]));
      const after = await rows<{ n: number }>(`select count(*)::int n from audit_events where tool = 'http'`);
      expect(after[0].n - before[0].n).toBe(5);
      expect(await flood.rejections.flush()).toBe(35);
      expect(await lastAudit()).toMatchObject({ tool: 'http', error_code: 'rejections_dropped', arguments: { total: 35 } });
      t += 2000;
      expect((await post({ authorization: 'Bearer nope' }, undefined, flood.url)).status).toBe(401);
      expect(await lastAudit()).toMatchObject({ error_code: 'invalid_token' });
      expect(await flood.rejections.flush()).toBe(0);
    } finally { await flood.close(); }
  });
});

describe('HTTP transport: rejection limiter memory', () => {
  it('tracks at most maxTrackedIps buckets; new IPs past the cap share one overflow bucket instead of evicting', async () => {
    const auditor = new RejectionAuditor(db, { burst: 1, refillPerSecond: 0, maxTrackedIps: 2 }, () => 0);
    const hit = (ip: string) => auditor.record({ ip, status: 401, errorCode: 'invalid_token', method: 'POST' });
    expect(await hit('10.0.0.1')).toBe(true);
    expect(await hit('10.0.0.1')).toBe(false);
    expect(await hit('10.0.0.2')).toBe(true);
    expect(await hit('10.0.0.3')).toBe(true);
    expect(await hit('10.0.0.4')).toBe(false);
    expect(await hit('10.0.0.1')).toBe(false);
    expect(await hit('10.0.0.2')).toBe(false);
    await auditor.close();
  });

  it('a round-robin flood from more IPs than are tracked still writes a bounded number of rows', async () => {
    const auditor = new RejectionAuditor(db, { burst: 1, refillPerSecond: 0, maxTrackedIps: 3 }, () => 0);
    let written = 0;
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 10; i++) if (await auditor.record({ ip: `10.1.0.${i}`, status: 401, errorCode: 'invalid_token', method: 'POST' })) written++;
    }
    expect(written).toBe(4);
    expect(await auditor.flush()).toBe(46);
    await auditor.close();
  });

  it('forgets a fully refilled bucket to make room, since a fresh one would be the same', async () => {
    let t = 0;
    const auditor = new RejectionAuditor(db, { burst: 1, refillPerSecond: 1, maxTrackedIps: 1 }, () => t);
    const hit = (ip: string) => auditor.record({ ip, status: 401, errorCode: 'invalid_token', method: 'POST' });
    expect(await hit('10.2.0.1')).toBe(true);
    expect(await hit('10.2.0.2')).toBe(true);
    expect(await hit('10.2.0.3')).toBe(false);
    t = 2000;
    expect(await hit('10.2.0.3')).toBe(true);
    expect(await hit('10.2.0.3')).toBe(false);
    await auditor.close();
  });

  it('keeps dropped counts when the summary row fails to write, so the next flush reports them', async () => {
    let down = true;
    const flaky = new Proxy(db, {
      get(t, p) {
        if (p === 'transaction' && down) return async () => { throw new Error('db down'); };
        const v = Reflect.get(t, p);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const auditor = new RejectionAuditor(flaky, { burst: 0, refillPerSecond: 0, maxTrackedIps: 10 }, () => 0);
    const hit = (ip: string) => auditor.record({ ip, status: 401, errorCode: 'invalid_token', method: 'POST' });
    await hit('10.0.0.1');
    await hit('10.0.0.2');
    await expect(auditor.flush()).rejects.toThrow('db down');
    await hit('10.0.0.1');
    down = false;
    expect(await auditor.flush()).toBe(3);
    expect(await lastAudit()).toMatchObject({ error_code: 'rejections_dropped', arguments: { total: 3, byIp: { '10.0.0.1': 2, '10.0.0.2': 1 } } });
    await auditor.close();
  });

  it('counts a refusal whose own audit row fails to write, so the next flush reports it', async () => {
    let down = true;
    const flaky = new Proxy(db, {
      get(t, p) {
        if (p === 'transaction' && down) return async () => { throw new Error('db down'); };
        const v = Reflect.get(t, p);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const auditor = new RejectionAuditor(flaky, { burst: 5, refillPerSecond: 0, maxTrackedIps: 10 }, () => 0);
    const hit = (ip: string) => auditor.record({ ip, status: 401, errorCode: 'invalid_token', method: 'POST' });
    await expect(hit('10.0.0.4')).rejects.toThrow('db down');
    await expect(hit('10.0.0.4')).rejects.toThrow('db down');
    down = false;
    expect(await auditor.flush()).toBe(2);
    expect(await lastAudit()).toMatchObject({ error_code: 'rejections_dropped', arguments: { total: 2, byIp: { '10.0.0.4': 2 } } });
    await auditor.close();
  });

  it('server close resolves even if the final rejection summary cannot be written', async () => {
    let down = false;
    const flaky = new Proxy(db, {
      get(t, p) {
        if (p === 'transaction' && down) return async () => { throw new Error('db down'); };
        const v = Reflect.get(t, p);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const s2 = await startHttpServer({ db: flaky, tokens, rejectionLimits: { burst: 0, refillPerSecond: 0, maxTrackedIps: 10 } });
    expect((await post({ authorization: 'Bearer nope' }, undefined, s2.url)).status).toBe(401);
    down = true;
    await expect(s2.close()).resolves.toBeUndefined();
  });
});

describe('HTTP transport: no token material anywhere', () => {
  it('raw tokens and their hashes never appear in audit rows or logs', async () => {
    const dump = (await rows<{ t: string }>('select coalesce(string_agg(a::text, chr(10)), \'\') t from audit_events a'))[0].t;
    const hashes = tokens.map((e) => e.hash.toString('hex'));
    for (const secret of [...raws, ...hashes]) {
      expect(dump).not.toContain(secret);
      expect(logs.join('\n')).not.toContain(secret);
    }
    expect(dump).not.toMatch(/Bearer/i);
  });
});
