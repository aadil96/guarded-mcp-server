import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAppDb, connectAsApp } from '../src/db/index.js';
import { seed, seedId } from '../src/db/seed.js';
import type { AppDb } from '../src/db/types.js';
import { serverTools } from '../src/server.js';
import type { DefinedTool } from '../src/tools/framework.js';
import { auditFailing, freshDb, mcpClient } from './helpers.js';

// Every registered tool. A tool without samples fails the test.
const tools: readonly DefinedTool[] = serverTools;
const missing = '00000000-0000-4000-8000-000000000000';

type Samples = { ok: Record<string, unknown>; bad: Record<string, unknown>; extra: Record<string, unknown>; notFound?: Record<string, unknown> };
const samples = (invoiceId: string): Record<string, Samples> => ({
  list_customers: { ok: {}, bad: { limit: 'x' }, extra: { limit: 1, extra: true } },
  get_customer: { ok: { customer_id: seedId('customer:1') }, notFound: { customer_id: missing }, bad: { customer_id: 1 }, extra: { customer_id: seedId('customer:1'), extra: 1 } },
  list_orders: { ok: {}, bad: { limit: 'x' }, extra: { status: 'pending', extra: 1 } },
  get_order: { ok: { order_id: seedId('order:1') }, notFound: { order_id: missing }, bad: { order_id: 'nope' }, extra: { order_id: seedId('order:1'), note: 'x' } },
  list_invoices: { ok: {}, bad: { status: 'nope' }, extra: { limit: 1, extra: 1 } },
  get_invoice: { ok: { invoice_id: seedId('invoice:1') }, notFound: { invoice_id: missing }, bad: { invoice_id: 1 }, extra: { invoice_id: seedId('invoice:1'), extra: true } },
  search_orders: { ok: { query: 'ORD-0001' }, bad: { query: '' }, extra: { query: 'ORD', note: 'x' } },
  list_pending_approvals: { ok: {}, bad: { limit: 'x' }, extra: { limit: 1, unknown: 'y' } },
  issue_refund: {
    ok: { invoice_id: invoiceId, amount_paise: 100, reason: 'damaged', idempotency_key: 'inv-ok' },
    bad: { invoice_id: invoiceId, amount_paise: -1, reason: 'damaged', idempotency_key: 'inv-bad' },
    extra: { invoice_id: invoiceId, amount_paise: 100, reason: 'damaged', idempotency_key: 'inv-extra', note: 'x' },
    notFound: { invoice_id: missing, amount_paise: 100, reason: 'damaged', idempotency_key: 'inv-nf' },
  },
});

let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: AppDb;
let invoiceId = '';
const count = async (table: string) => (await ctx.client.query<{ n: number }>(`select count(*)::int n from ${table}`)).rows[0].n;

beforeAll(async () => {
  ctx = await freshDb();
  await seed(ctx.db);
  invoiceId = (await ctx.client.query<{ id: string }>(`select id from invoices where status = 'paid' order by invoice_number limit 1`)).rows[0].id;
  if (ctx.url) db = await connectAsApp(ctx.url);
  else { await ctx.client.query('set role meridian_app'); db = ctx.db as unknown as AppDb; }
});
afterAll(async () => { await closeAppDb(db); await ctx.client.close(); });

describe('registry-driven audit invariants (every registered tool, as meridian_app)', () => {
  it('the registry and the samples cover the same tools', () => {
    expect(Object.keys(samples(invoiceId)).sort()).toEqual(tools.map((t) => t.name).sort());
  });

  it('valid, invalid, unknown-key and not-found calls each add exactly one audit row', async () => {
    const cli = await mcpClient(db, { actor: 'inv-op', role: 'operator' }, tools);
    try {
      const all = samples(invoiceId);
      for (const tool of tools) {
        const s = all[tool.name];
        for (const [label, args] of [['ok', s.ok], ['bad', s.bad], ['extra', s.extra], ['notFound', s.notFound]] as const) {
          if (!args) continue;
          const before = await count('audit_events');
          const r = await cli.call(tool.name, args);
          expect(r.isError, `${tool.name} ${label}: ${JSON.stringify(r.data)}`).toBe(label === 'bad' || label === 'extra' || (label === 'notFound' && tool.kind === 'read'));
          expect(await count('audit_events'), `${tool.name} ${label}`).toBe(before + 1);
        }
      }
    } finally { await cli.close(); }
  });

  it('a forced failure between the write and its audit leaves neither, for every tool', async () => {
    const cli = await mcpClient(auditFailing(db), { actor: 'inv-op', role: 'operator' }, tools);
    try {
      const all = samples(invoiceId);
      for (const tool of tools) {
        const args = tool.kind === 'write' ? { ...all[tool.name].ok, idempotency_key: `forced-${tool.name}` } : all[tool.name].ok;
        const [auditsBefore, approvalsBefore] = [await count('audit_events'), await count('approvals')];
        const r = await cli.call(tool.name, args);
        expect(r.isError, tool.name).toBe(true);
        expect(await count('audit_events'), tool.name).toBe(auditsBefore);
        expect(await count('approvals'), tool.name).toBe(approvalsBefore);
      }
    } finally { await cli.close(); }
  });
});
