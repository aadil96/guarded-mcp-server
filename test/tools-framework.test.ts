import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { executeApproval, resolveApproval } from '../src/approvals/index.js';
import type { RequestWriteResult } from '../src/approvals/types.js';
import { closeAppDb, connectAsApp } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';
import type { AppDb } from '../src/db/types.js';
import { createServer, serverTools } from '../src/server.js';
import { approvalHandlers, assertStrict, defineReadTool, defineWriteTool, mapRequestWriteResult } from '../src/tools/framework.js';
import { issueRefund, issueRefundSchema } from '../src/approvals/refund.js';
import { issueRefundTool } from '../src/tools/write.js';
import { freshDb, mcpClient } from './helpers.js';

const parse = (r: { content: { type: string; text?: string }[]; isError?: boolean }) =>
  ({ isError: r.isError === true, type: r.content[0].type, data: JSON.parse(r.content[0].text as string) });

describe('strictness is enforced when a tool is defined', () => {
  const run = async () => null;
  it('rejects a non-strict top-level schema', () => {
    expect(() => defineReadTool({ name: 'x', description: 'x', input: z.object({ a: z.string() }), run })).toThrow(/x.input must be a strict object/);
    expect(() => defineReadTool({ name: 'x', description: 'x', input: z.looseObject({ a: z.string() }), run })).toThrow(/strict object/);
    expect(() => defineReadTool({ name: 'x', description: 'x', input: z.object({ a: z.string() }).catchall(z.string()), run })).toThrow(/strict object/);
  });
  it('rejects a non-strict nested schema, including inside optional and array', () => {
    expect(() => assertStrict(z.strictObject({ n: z.object({ a: z.string() }) }))).toThrow(/input.n must be a strict object/);
    expect(() => assertStrict(z.strictObject({ n: z.object({}).optional() }))).toThrow(/input.n must be/);
    expect(() => assertStrict(z.strictObject({ n: z.array(z.object({})) }))).toThrow(/input.n\[\] must be/);
  });
  it('rejects a non-strict write tool schema and a schema that declares idempotency_key itself', () => {
    const base = { name: 'issue_refund' as const, description: 'x', summarize: async () => 's', execute: async () => ({ ok: true as const, result: {} }) };
    expect(() => defineWriteTool({ ...base, input: z.object({ a: z.string() }) })).toThrow(/strict object/);
    expect(() => defineWriteTool({ ...base, input: z.strictObject({ idempotency_key: z.string() }) })).toThrow(/must not declare idempotency_key/);
  });
  it('accepts strict schemas, and every registered tool is strict', () => {
    expect(() => assertStrict(z.strictObject({ n: z.strictObject({ a: z.string() }).optional() }))).not.toThrow();
    for (const t of serverTools) expect(() => assertStrict(t.inputSchema, t.name)).not.toThrow();
  });
});

describe('strictness reaches every container', () => {
  it('rejects a non-strict object behind intersection, tuple, record, set or pipe, and refuses lazy', () => {
    const loose = z.object({ a: z.string() });
    const strict = z.strictObject({ a: z.string() });
    for (const inner of [z.intersection(strict, loose), z.tuple([z.string(), loose]), z.tuple([z.string()], loose), z.record(z.string(), loose), z.set(loose), strict.pipe(loose as never)]) {
      expect(() => assertStrict(z.strictObject({ x: inner as z.ZodType }))).toThrow(/must be a strict object/);
    }
    expect(() => assertStrict(z.strictObject({ x: z.lazy(() => strict) }))).toThrow(/lazy schema/);
    // Codecs decode during parsing; the SDK's decoded output would fail the framework's second parse.
    expect(() => assertStrict(z.strictObject({ n: z.codec(z.string(), z.number(), { decode: Number, encode: String }) }))).toThrow(/codec/);
    // Types JSON Schema can't express would make tools/list throw for every tool, so they fail at definition.
    for (const unrepresentable of [z.date(), z.bigint(), z.symbol(), z.undefined(), z.void(), z.nan()]) {
      expect(() => defineReadTool({ name: 'u', description: 'u', input: z.strictObject({ v: unrepresentable }), run: async () => null })).toThrow(/JSON Schema/);
    }
    for (const permissive of [z.any(), z.unknown(), z.custom<object>(() => true)]) {
      expect(() => assertStrict(z.strictObject({ payload: permissive }))).toThrow(/schema, which strictness can't be checked/);
    }
    expect(() => assertStrict(z.strictObject({ x: z.intersection(strict, z.strictObject({ b: z.number() })), t: z.tuple([strict]), r: z.record(z.string(), strict) }))).not.toThrow();
  });
});

describe('registration only through the framework', () => {
  it('createServer refuses a tool not built by defineReadTool/defineWriteTool, and duplicate names', () => {
    const forged = { name: 'forged', kind: 'read', description: 'x', inputSchema: z.strictObject({}), annotations: {}, call: async () => ({ content: [] }) };
    expect(() => createServer({} as AppDb, { actor: 'a', role: 'reader' }, undefined, [forged as never])).toThrow(/defineReadTool or defineWriteTool/);
    expect(() => createServer({} as AppDb, { actor: 'a', role: 'reader' }, undefined, [issueRefundTool, issueRefundTool])).toThrow(/duplicate tool name issue_refund/);
  });
});

describe('mapRequestWriteResult keeps every field per outcome', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const cases: [RequestWriteResult, boolean, Record<string, unknown>][] = [
    [{ kind: 'pending', approvalId: id, summary: 'Refund ₹1.00 on INV-1', approval: {} as never }, false, { status: 'pending_approval', approvalId: id, summary: 'Refund ₹1.00 on INV-1' }],
    [{ kind: 'duplicate', approvalId: id, status: 'executed', result: { refundId: 'r' } }, false, { status: 'duplicate', approvalId: id, approvalStatus: 'executed', result: { refundId: 'r' } }],
    [{ kind: 'duplicate', approvalId: id, status: 'failed', result: { error: 'amount_exceeds_remaining' } }, true, { status: 'duplicate', approvalId: id, approvalStatus: 'failed', result: { error: 'amount_exceeds_remaining' } }],
    [{ kind: 'conflict', approvalId: id }, true, { error: 'conflict', reason: 'idempotency_key_reused', approvalId: id }],
    [{ kind: 'denied', reason: 'previously_denied' }, true, { error: 'denied', reason: 'previously_denied' }],
    [{ kind: 'invalid_args', issues: [{ code: 'custom', path: ['card'], message: 'bad', input: '4111-secret' } as never] }, true, { error: 'invalid_args', issues: [{ code: 'custom', path: ['card'], message: 'bad' }] }],
  ];
  for (const [r, isError, data] of cases) {
    it(`${r.kind}${r.kind === 'duplicate' ? ` (${r.status})` : ''}`, () => {
      const out = parse(mapRequestWriteResult(r) as never);
      expect(out.type).toBe('text');
      expect(out.isError).toBe(isError);
      expect(out.data).toMatchObject(data);
      expect(JSON.stringify(out.data)).not.toContain('4111-secret');
    });
  }
});

describe('defineWriteTool over MCP on the approvals module', () => {
  let ctx: Awaited<ReturnType<typeof freshDb>>;
  let db: AppDb;
  let cli: Awaited<ReturnType<typeof mcpClient>>;
  let invoiceId = '';
  const op = { actor: 'op-mcp', role: 'operator' as const };
  const admin = { actor: 'admin-mcp', role: 'admin' as const };
  const audits = async () => (await ctx.client.query<{ n: number }>('select count(*)::int n from audit_events')).rows[0].n;

  beforeAll(async () => {
    ctx = await freshDb();
    await seed(ctx.db);
    invoiceId = (await ctx.client.query<{ id: string }>(`select id from invoices where status = 'paid' order by invoice_number limit 1`)).rows[0].id;
    if (ctx.url) db = await connectAsApp(ctx.url);
    else { await ctx.client.query('set role meridian_app'); db = ctx.db as unknown as AppDb; }
    cli = await mcpClient(db, op, serverTools);
  });
  afterAll(async () => { await cli.close(); await closeAppDb(db); await ctx.client.close(); });

  const args = (amount: number, key: string) => ({ invoice_id: invoiceId, amount_paise: amount, reason: 'damaged in transit', idempotency_key: key });
  const step = async (fn: () => Promise<{ isError: boolean; data: Record<string, unknown> }>) => {
    const before = await audits();
    const r = await fn();
    expect(await audits()).toBe(before + 1);
    return r;
  };

  it('tools/list shows the write tool with idempotency_key required and no unknown keys', async () => {
    const t = (await cli.list()).find((x) => x.name === 'issue_refund');
    expect(t?.inputSchema).toMatchObject({ required: expect.arrayContaining(['invoice_id', 'amount_paise', 'reason', 'idempotency_key']), additionalProperties: false });
    expect(t?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('pending: text result with status, approvalId and summary', async () => {
    const r = await step(() => cli.call('issue_refund', args(100, 'mcp-1')));
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({ status: 'pending_approval', approvalId: expect.any(String), summary: expect.stringMatching(/^Refund ₹1\.00 on INV-/) });
  });

  it('repeat while pending is still pending with the same approvalId', async () => {
    const first = await cli.call('issue_refund', args(100, 'mcp-1'));
    const again = await step(() => cli.call('issue_refund', args(100, 'mcp-1')));
    expect(again.data).toMatchObject({ status: 'pending_approval', approvalId: first.data.approvalId });
  });

  it('conflict: isError with the existing approvalId', async () => {
    const first = await cli.call('issue_refund', args(100, 'mcp-1'));
    const r = await step(() => cli.call('issue_refund', args(101, 'mcp-1')));
    expect(r).toMatchObject({ isError: true, data: { error: 'conflict', reason: 'idempotency_key_reused', approvalId: first.data.approvalId } });
  });

  it('duplicate (executed): the stored result and approvalStatus, via the same handler executeApproval runs', async () => {
    const { data } = await cli.call('issue_refund', args(100, 'mcp-1'));
    const id = data.approvalId as string;
    expect((await resolveApproval(db, { ...admin, approvalId: id, decision: 'approve' })).kind).toBe('resolved');
    const ex = await executeApproval(db, id, admin, approvalHandlers([issueRefundTool]));
    if (ex.kind !== 'executed') throw new Error(ex.kind);
    const r = await step(() => cli.call('issue_refund', args(100, 'mcp-1')));
    expect(r).toEqual({ isError: false, data: { status: 'duplicate', approvalId: id, approvalStatus: 'executed', result: ex.result }, raw: expect.anything() });
  });

  it('duplicate (failed): isError, with approvalStatus failed and the stored error', async () => {
    const { data } = await cli.call('issue_refund', args(999_999_999, 'mcp-fail'));
    const id = data.approvalId as string;
    await resolveApproval(db, { ...admin, approvalId: id, decision: 'approve' });
    expect((await executeApproval(db, id, admin, approvalHandlers([issueRefundTool]))).kind).toBe('failed');
    const r = await step(() => cli.call('issue_refund', args(999_999_999, 'mcp-fail')));
    expect(r.data).toEqual({ status: 'duplicate', approvalId: id, approvalStatus: 'failed', result: { error: 'amount_exceeds_remaining' } });
    expect(r.isError).toBe(true);
  });

  it('denied (previously_denied): isError with the reason', async () => {
    const { data } = await cli.call('issue_refund', args(100, 'mcp-deny'));
    await resolveApproval(db, { ...admin, approvalId: data.approvalId as string, decision: 'deny' });
    const r = await step(() => cli.call('issue_refund', args(100, 'mcp-deny')));
    expect(r).toMatchObject({ isError: true, data: { error: 'denied', reason: 'previously_denied' } });
  });

  it('denied (role_not_permitted): a reader cannot request a write', async () => {
    const reader = await mcpClient(db, { actor: 'reader-mcp', role: 'reader' }, [issueRefundTool]);
    try {
      const r = await step(() => reader.call('issue_refund', args(100, 'mcp-reader')));
      expect(r).toMatchObject({ isError: true, data: { error: 'denied', reason: 'role_not_permitted' } });
    } finally { await reader.close(); }
  });

  it('a transforming schema is refused at definition; an async-refined one requests, is approved and executes', async () => {
    const execute = (tx: Parameters<typeof issueRefund.execute>[0], _a: unknown, approval: Parameters<typeof issueRefund.execute>[1]) => issueRefund.execute(tx, approval);
    expect(() => defineWriteTool({
      name: 'issue_refund', description: 'x', input: z.strictObject({ amount_paise: z.string().transform(Number) }),
      summarize: async () => 's', execute,
    })).toThrow(/uses a transform/);
    let seen: unknown;
    const asyncRefined = defineWriteTool({
      name: 'issue_refund', description: 'x',
      input: z.strictObject({ invoice_id: z.uuid(), amount_paise: z.number().int().positive(), reason: z.string().refine(async (v) => v.length >= 3) }),
      summarize: async (_db, a) => `refund ${a.amount_paise} paise`,
      execute: async (tx, a, approval) => { seen = a; return issueRefund.execute(tx, approval); },
    });
    const c = await mcpClient(db, op, [asyncRefined]);
    try {
      const r = await step(() => c.call('issue_refund', args(100, 'mcp-async')));
      expect(r).toMatchObject({ isError: false, data: { status: 'pending_approval', summary: 'refund 100 paise' } });
      const id = r.data.approvalId as string;
      expect((await resolveApproval(db, { ...admin, approvalId: id, decision: 'approve' })).kind).toBe('resolved');
      expect((await executeApproval(db, id, admin, approvalHandlers([asyncRefined]))).kind).toBe('executed');
      expect(seen).toEqual({ invoice_id: invoiceId, amount_paise: 100, reason: 'damaged in transit' });
    } finally { await c.close(); }
  });

  it('a summarize that throws is still audited (internal_error) and creates no approval', async () => {
    const broken = defineWriteTool({
      name: 'issue_refund', description: 'x', input: issueRefundSchema,
      summarize: async () => { throw new Error('lookup failed'); },
      execute: (tx, _a, approval) => issueRefund.execute(tx, approval),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = await mcpClient(db, op, [broken]);
    try {
      const approvals = async () => (await ctx.client.query<{ n: number }>('select count(*)::int n from approvals')).rows[0].n;
      const before = await approvals();
      const r = await step(() => c.call('issue_refund', args(100, 'mcp-summarize-throws')));
      expect(r).toMatchObject({ isError: true, data: { error: 'internal_error', correlationId: expect.any(String) } });
      expect(await approvals()).toBe(before);
      const rows = (await ctx.client.query<{ tool: string; error_code: string }>('select tool, error_code from audit_events where correlation_id = $1', [r.data.correlationId])).rows;
      expect(rows).toEqual([{ tool: 'issue_refund', error_code: 'internal_error' }]);
    } finally { vi.restoreAllMocks(); await c.close(); }
  });

  it('invalid_args: isError with the zod issues when the framework rejects', async () => {
    // Over 200 UTF-8 bytes but under 200 chars, so the SDK schema passes and the approvals module rejects.
    const r = await step(() => cli.call('issue_refund', args(100, 'é'.repeat(150))));
    expect(r).toMatchObject({ isError: true, data: { error: 'invalid_args', issues: [expect.objectContaining({ path: ['idempotencyKey'] })] } });
  });
});

describe('read tool failures are audited in the same transaction', () => {
  it('a query PostgreSQL rejects, or a result JSON cannot encode, writes exactly one audit row (internal_error)', async () => {
    const ctx = await freshDb();
    let db: AppDb;
    if (ctx.url) db = await connectAsApp(ctx.url);
    else { await ctx.client.query('set role meridian_app'); db = ctx.db as unknown as AppDb; }
    const boom = defineReadTool({ name: 'boom', description: 'fails in SQL', input: z.strictObject({}), run: (tx) => tx.execute(sql`select 1 / 0`) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cli = await mcpClient(db, { actor: 'r', role: 'reader' }, [boom]);
    try {
      const r = await cli.call('boom', {});
      expect(r).toMatchObject({ isError: true, data: { error: 'internal_error' } });
      const rows = (await ctx.client.query<{ tool: string; error_code: string }>('select tool, error_code from audit_events')).rows;
      expect(rows).toEqual([{ tool: 'boom', error_code: 'internal_error' }]);
      // A result JSON can't encode fails before the success audit, so the log holds one row, not ok + error.
      const big = defineReadTool({ name: 'big', description: 'returns a bigint', input: z.strictObject({}), run: async () => ({ n: 1n }) });
      const c2 = await mcpClient(db, { actor: 'r', role: 'reader' }, [big]);
      try {
        expect(await c2.call('big', {})).toMatchObject({ isError: true, data: { error: 'internal_error' } });
      } finally { await c2.close(); }
      // An async refinement parses instead of throwing; the valid call and the rejected one each leave one audit row.
      const asyncTool = defineReadTool({ name: 'async_ref', description: 'async refine', input: z.strictObject({ q: z.string().refine(async (v) => v === 'ok') }), run: async () => ({ ok: true }) });
      const c3 = await mcpClient(db, { actor: 'r', role: 'reader' }, [asyncTool]);
      try {
        expect(await c3.call('async_ref', { q: 'ok' })).toMatchObject({ isError: false, data: { ok: true } });
        expect(await c3.call('async_ref', { q: 'no' })).toMatchObject({ isError: true });
      } finally { await c3.close(); }
      const asyncRows = (await ctx.client.query<{ outcome: string }>(`select outcome from audit_events where tool = 'async_ref' order by created_at`)).rows;
      expect(asyncRows.map((r) => r.outcome)).toEqual(['ok', 'error']);
      const undef = defineReadTool({ name: 'undef', description: 'returns undefined', input: z.strictObject({}), run: async () => undefined });
      const c4 = await mcpClient(db, { actor: 'r', role: 'reader' }, [undef]);
      try {
        expect(await c4.call('undef', {})).toMatchObject({ isError: true, data: { error: 'internal_error' } });
      } finally { await c4.close(); }
      expect((await ctx.client.query(`select error_code from audit_events where tool = 'undef'`)).rows).toEqual([{ error_code: 'internal_error' }]);
      const bigRows = (await ctx.client.query<{ tool: string; error_code: string | null }>(`select tool, error_code from audit_events where tool = 'big'`)).rows;
      expect(bigRows).toEqual([{ tool: 'big', error_code: 'internal_error' }]);
    } finally {
      vi.restoreAllMocks();
      await cli.close();
      await closeAppDb(db);
      await ctx.client.close();
    }
  });
});
