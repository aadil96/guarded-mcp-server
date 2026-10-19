import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callerFromEnv } from '../src/audit/log.js';
import { closeAppDb, connectAsApp, queryRows } from '../src/db/index.js';
import { seed, seedId } from '../src/db/seed.js';
import type { AppDb } from '../src/db/types.js';
import { callTool, createServer } from '../src/server.js';
import { AuditTracker, auditingTransport } from '../src/audit/transport.js';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import type { readTools } from '../src/tools/read.js';
import { freshDb, startServer } from './helpers.js';

// The server's own db handle: on real PG (CI) the production connectAsApp(); on PGlite the
// same SET ROLE issued on the single connection. Seeding happens first, as the owner.
let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: AppDb;
let close = async () => {};

beforeAll(async () => {
  ctx = await freshDb();
  await seed(ctx.db);
  if (ctx.url) {
    const appDb = await connectAsApp(ctx.url);
    db = appDb;
    close = () => closeAppDb(appDb);
  } else {
    await ctx.client.query('SET ROLE meridian_app');
    db = ctx.db as unknown as AppDb;
  }
});
afterAll(async () => { await close(); });

const run = (q: string) => db.execute(sql.raw(q));

describe('server db connection runs as meridian_app', () => {
  it('is the app role, not the owner', async () => {
    const r = await run('select current_user as u');
    expect((r as unknown as { rows: { u: string }[] }).rows[0].u).toBe('meridian_app');
  });

  it('every read tool and its audit insert work under the app role', async () => {
    const caller = callerFromEnv({});
    const calls: [keyof typeof readTools, Record<string, unknown>][] = [
      ['list_customers', {}], ['get_customer', { customer_id: seedId('customer:1') }],
      ['list_orders', { status: 'pending' }], ['get_order', { order_id: seedId('order:1') }],
      ['list_invoices', {}], ['get_invoice', { invoice_id: seedId('invoice:1') }],
      ['search_orders', { query: 'ORD-00%' }], ['list_pending_approvals', {}],
    ];
    for (const [name, args] of calls) {
      const r = await callTool(db, caller, name, args);
      expect(r.isError, `${name}: ${r.content[0].text}`).not.toBe(true);
    }
    const n = await run('select count(*)::int as n from audit_events');
    expect((n as unknown as { rows: { n: number }[] }).rows[0].n).toBe(calls.length);
  });

  it('the transport hook audits an SDK-rejected call under the app role, even with a NUL in the tool name', async () => {
    const caller = callerFromEnv({});
    const count = async () => (await queryRows<{ n: number }>(db, sql`select count(*)::int n from audit_events`))[0].n;
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const tracker = new AuditTracker();
    await createServer(db, caller, tracker).connect(auditingTransport(serverT, db, caller, tracker));
    const pending = new Map<number, (m: JSONRPCMessage) => void>();
    clientT.onmessage = (m) => { if ('id' in m && typeof m.id === 'number') pending.get(m.id)?.(m); };
    await clientT.start();
    let id = 0;
    const rpc = (method: string, params: unknown) => new Promise<{ result?: Record<string, unknown>; error?: unknown }>((res) => {
      const k = ++id;
      pending.set(k, res as (m: JSONRPCMessage) => void);
      void clientT.send({ jsonrpc: '2.0', id: k, method, params } as JSONRPCMessage);
    });
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
    const before = await count();
    const bad = await rpc('tools/call', { name: 'get_invoice', arguments: { invoice_id: 'nope', password: 'hunter2' } });
    expect(bad.result?.isError).toBe(true);
    expect(await count()).toBe(before + 1);
    const odd = await rpc('tools/call', { name: 'get\u0000order\uD800', arguments: {} });
    expect(odd.result?.isError === true || odd.error !== undefined).toBe(true);
    expect(await count()).toBe(before + 2);
    const rows = await queryRows<{ tool: string; outcome: string; error_code: string; role: string }>(db,
      sql`select tool, outcome::text, error_code, role::text from audit_events order by created_at desc, ctid desc limit 2`);
    expect(new Set(rows.map((r) => r.tool))).toEqual(new Set(['get_invoice', 'get\uFFFDorder\uFFFD']));
    expect(rows.every((r) => r.outcome === 'error' && r.error_code === 'invalid_args' && r.role === 'reader')).toBe(true);
    await clientT.close();
  });

  it('cannot UPDATE or DELETE audit_events', async () => {
    await expect(run(`update audit_events set tool = 'tampered'`)).rejects.toThrow();
    await expect(run('delete from audit_events')).rejects.toThrow();
  });

  it('cannot change order totals or insert customers', async () => {
    await expect(run('update orders set total_paise = 1')).rejects.toThrow();
    await expect(run(`insert into customers (id, name, city, gstin, phone, email) values (gen_random_uuid(), 'x', 'x', 'x', 'x', 'x')`)).rejects.toThrow();
  });
});

// Real PG only: PGlite is a single in-process session with no separate login roles.
describe.runIf(process.env.DATABASE_URL)('fails closed when SET ROLE is not allowed', () => {
  const login = `t_nomember_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let dbName = '';
  let loginUrl = '';

  beforeAll(async () => {
    dbName = new URL(ctx.url as string).pathname.slice(1);
    await ctx.client.query(`CREATE ROLE ${login} LOGIN PASSWORD 'pw'`);
    await ctx.client.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${login}`);
    // Give the login direct read access, so a silent fallback to the login user WOULD succeed.
    await ctx.client.query(`GRANT USAGE ON SCHEMA public TO ${login}`);
    await ctx.client.query(`GRANT SELECT ON orders TO ${login}`);
    const u = new URL(ctx.url as string);
    u.username = login;
    u.password = 'pw';
    loginUrl = u.toString();
  });
  afterAll(async () => {
    await ctx.client.query(`REVOKE ALL ON orders FROM ${login}`);
    await ctx.client.query(`REVOKE ALL ON SCHEMA public FROM ${login}`);
    await ctx.client.query(`REVOKE ALL ON DATABASE ${dbName} FROM ${login}`);
    await ctx.client.query(`DROP ROLE ${login}`);
  });

  it('connectAsApp rejects a login without meridian_app membership', async () => {
    await expect(connectAsApp(loginUrl)).rejects.toThrow(/permission denied to set role/);
  });

  it('the server refuses to start as that login and exits 1', async () => {
    const { code, stderr } = await startServer({ DATABASE_URL: loginUrl });
    expect(code).toBe(1);
    expect(stderr).toMatch(/refusing to start, could not run as meridian_app: permission denied to set role/);
  });
});
