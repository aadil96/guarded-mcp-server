import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seed, seedId } from '../src/db/seed.js';
import type { AppDb } from '../src/db/types.js';
import { AuditTracker, auditingTransport } from '../src/audit/transport.js';
import { callTool, createServer } from '../src/server.js';
import { escapeLike, type readTools } from '../src/tools/read.js';
import { freshDb } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof freshDb>>;
let ctx: Ctx;
const caller = { actor: 'test-actor', role: 'reader' as const };
const auditCount = async () => (await ctx.client.query<{ n: number }>('select count(*)::int n from audit_events')).rows[0].n;

async function call(name: keyof typeof readTools, args: unknown = {}) {
  const r = await callTool(ctx.db as unknown as AppDb, caller, name, args);
  return { isError: r.isError === true, data: JSON.parse(r.content[0].text) };
}

beforeAll(async () => {
  ctx = await freshDb();
  await seed(ctx.db);
});

let before = 0;
beforeEach(async () => { before = await auditCount(); });

describe('read tools return seed data', () => {
  it('list_customers / get_customer', async () => {
    const { data } = await call('list_customers', { limit: 5 });
    expect(data).toHaveLength(5);
    expect(data[0].name).toBe('Konkan Coastal Traders');
    const one = await call('get_customer', { customer_id: seedId('customer:2') });
    expect(one.data).toMatchObject({ name: 'Dadar Hardware Mart', city: 'Mumbai' });
  });

  it('list_orders filters by customer and status', async () => {
    const cust = seedId('customer:1');
    const { data } = await call('list_orders', { customer_id: cust });
    expect(data.map((o: { orderNumber: string }) => o.orderNumber).sort()).toEqual(['ORD-0001', 'ORD-0013', 'ORD-0025', 'ORD-0037']);
    const pending = await call('list_orders', { status: 'pending' });
    expect(pending.data).toHaveLength(8);
    expect(pending.data.every((o: { status: string }) => o.status === 'pending')).toBe(true);
    const both = await call('list_orders', { customer_id: cust, status: 'pending' });
    expect(both.data.map((o: { orderNumber: string }) => o.orderNumber)).toEqual(['ORD-0001']);
  });

  it('get_order returns the Order shape with line items that add up', async () => {
    const { data } = await call('get_order', { order_id: seedId('order:4') });
    expect(Object.keys(data).sort()).toEqual(['createdAt', 'customerId', 'id', 'items', 'orderNumber', 'status', 'totalPaise', 'updatedAt']);
    expect(data.orderNumber).toBe('ORD-0004');
    expect(data.items.length).toBeGreaterThan(0);
    for (const it of data.items) {
      expect(Object.keys(it).sort()).toEqual(['lineTotalPaise', 'productId', 'qty', 'sku', 'unitPricePaise']);
      expect(it.lineTotalPaise).toBe(it.qty * it.unitPricePaise);
    }
    expect(data.items.reduce((t: number, i: { lineTotalPaise: number }) => t + i.lineTotalPaise, 0)).toBe(data.totalPaise);
  });

  it('list_invoices / get_invoice', async () => {
    expect((await call('list_invoices', { limit: 50 })).data).toHaveLength(30);
    const paid = await call('list_invoices', { status: 'paid', limit: 50 });
    expect(paid.data).toHaveLength(10);
    const inv = await call('get_invoice', { invoice_id: seedId('invoice:1') });
    expect(inv.data).toMatchObject({ invoiceNumber: 'INV-0001', status: 'unpaid', paidPaise: 0 });
  });

  it('list_pending_approvals shows only pending rows', async () => {
    expect((await call('list_pending_approvals')).data).toEqual([]);
    await ctx.client.query(
      `insert into approvals (id, tool, idempotency_key, args_hash, arguments, summary, requested_by, status) values
       ($1, 'issue_refund', 'k1', $3, '{}', 'Refund 100', 'local-dev', 'pending'),
       ($2, 'issue_refund', 'k2', $3, '{}', 'Refund 200', 'local-dev', 'pending')`,
      [seedId('t-appr-1'), seedId('t-appr-2'), 'a'.repeat(64)],
    );
    await ctx.client.query(`update approvals set status = 'denied', resolved_by = 'admin', resolved_at = now() where id = $1`, [seedId('t-appr-2')]);
    const { data } = await call('list_pending_approvals');
    expect(data.map((a: { summary: string }) => a.summary)).toEqual(['Refund 100']);
  });
});

describe('limits and search safety', () => {
  it('clamps limits at 50', async () => {
    expect((await call('list_orders', { limit: 1000 })).data).toHaveLength(40);
    await ctx.client.query(
      `insert into customers (id, name, city, gstin, phone, email)
       select gen_random_uuid(), 'Bulk ' || g, 'Pune', 'BULK' || g, '0', 'x@example.invalid' from generate_series(1, 60) g`,
    );
    expect((await call('list_customers', { limit: 1000 })).data).toHaveLength(50);
    expect((await call('search_orders', { query: 'ORD', limit: 999 })).data).toHaveLength(40);
  });

  it('search matches order number and customer name', async () => {
    expect((await call('search_orders', { query: 'ord-0007' })).data.map((o: { orderNumber: string }) => o.orderNumber)).toEqual(['ORD-0007']);
    const byName = await call('search_orders', { query: 'konkan' });
    expect(byName.data).toHaveLength(4);
    expect(byName.data.every((o: { customerName: string }) => o.customerName === 'Konkan Coastal Traders')).toBe(true);
  });

  it('treats % _ and SQL-ish input literally', async () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    for (const q of ['%', '_', '%%', "' OR 1=1 --", "'; drop table orders; --", 'ORD-000_']) {
      const r = await call('search_orders', { query: q });
      expect(r.isError).toBe(false);
      expect(r.data).toEqual([]);
    }
    expect((await ctx.client.query<{ n: number }>('select count(*)::int n from orders')).rows[0].n).toBe(40);
  });
});

describe('audit', () => {
  it('every call writes exactly one row, including errors', async () => {
    await call('list_customers', { limit: 1 });
    expect(await auditCount()).toBe(before + 1);
    const missing = await call('get_order', { order_id: '00000000-0000-4000-8000-000000000000' });
    expect(missing).toMatchObject({ isError: true, data: { error: 'not_found' } });
    expect(await auditCount()).toBe(before + 2);
    const bad = await call('get_invoice', { invoice_id: 'not-a-uuid' });
    expect(bad.data.error).toBe('invalid_args');
    expect(await auditCount()).toBe(before + 3);
    const rows = (await ctx.client.query<Record<string, unknown>>(
      'select actor, role, tool, arguments, outcome, duration_ms, correlation_id, error_code from audit_events order by created_at desc, tool limit 3',
    )).rows;
    const nf = rows.find((r) => r.tool === 'get_order');
    expect(nf).toMatchObject({ actor: 'test-actor', role: 'reader', outcome: 'error', error_code: 'not_found' });
    expect(nf?.arguments).toEqual({ order_id: '00000000-0000-4000-8000-000000000000' });
    const ok = rows.find((r) => r.tool === 'list_customers');
    expect(ok).toMatchObject({ outcome: 'ok', error_code: null });
    expect(Number(ok?.duration_ms)).toBeGreaterThanOrEqual(0);
    expect(new Set(rows.map((r) => r.correlation_id)).size).toBe(3);
  });
});

describe('MCP server over in-memory transport', () => {
  it('lists exactly the 8 read tools and serves get_order', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const tracker = new AuditTracker();
    const db = ctx.db as unknown as AppDb; // owner handle stands in: these tests cover tool behaviour, not grants
    await createServer(db, caller, tracker).connect(auditingTransport(serverT, db, caller, tracker));
    const pending = new Map<number, (m: JSONRPCMessage) => void>();
    clientT.onmessage = (m) => { if ('id' in m && typeof m.id === 'number') pending.get(m.id)?.(m); };
    await clientT.start();
    let id = 0;
    const rpc = (method: string, params: unknown) => new Promise<{ result?: Record<string, unknown> }>((res) => {
      const n = ++id;
      pending.set(n, res as (m: JSONRPCMessage) => void);
      clientT.send({ jsonrpc: '2.0', id: n, method, params } as JSONRPCMessage);
    });
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
    const list = await rpc('tools/list', {});
    const tools = list.result?.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_customer', 'get_invoice', 'get_order', 'list_customers', 'list_invoices', 'list_orders', 'list_pending_approvals', 'search_orders',
    ]);
    expect(tools.every((t) => t.annotations.readOnlyHint === true)).toBe(true);
    const r = await rpc('tools/call', { name: 'get_order', arguments: { order_id: seedId('order:1') } });
    const content = r.result?.content as { text: string }[];
    expect(JSON.parse(content[0].text).orderNumber).toBe('ORD-0001');
    expect(await auditCount()).toBe(before + 1);

    // Handler-level error (not found): still exactly one row, no double audit from the transport.
    const nf = await rpc('tools/call', { name: 'get_order', arguments: { order_id: '00000000-0000-4000-8000-000000000000' } });
    expect(nf.result?.isError).toBe(true);
    expect(await auditCount()).toBe(before + 2);

    // SDK rejects this against the strict zod schema before the handler runs: audited by the transport wrapper.
    const bad = await rpc('tools/call', { name: 'get_invoice', arguments: { invoice_id: 'nope', password: 'hunter2' } });
    expect(bad.result?.isError).toBe(true);
    expect(JSON.stringify(bad.result)).toContain('Input validation error');
    expect(await auditCount()).toBe(before + 3);
    const row = (await ctx.client.query<Record<string, unknown>>(
      `select tool, arguments, outcome, error_code, actor, role from audit_events where error_code = 'invalid_args' and tool = 'get_invoice' and arguments ? 'password'`,
    )).rows;
    expect(row).toEqual([{ tool: 'get_invoice', arguments: { invoice_id: 'nope', password: '[redacted]' }, outcome: 'error', error_code: 'invalid_args', actor: 'test-actor', role: 'reader' }]);

    // Unknown key with otherwise valid arguments: rejected by the strict schema, audited once by the hook.
    const extra = await rpc('tools/call', { name: 'get_order', arguments: { order_id: seedId('order:1'), api_token: 'shh', note: 'x' } });
    expect(extra.result?.isError).toBe(true);
    expect(JSON.stringify(extra.result)).toContain('Input validation error');
    expect(await auditCount()).toBe(before + 4);
    const extraRows = (await ctx.client.query<Record<string, unknown>>(
      `select tool, arguments, outcome, error_code from audit_events where tool = 'get_order' and arguments ? 'note'`,
    )).rows;
    expect(extraRows).toEqual([{ tool: 'get_order', arguments: { order_id: seedId('order:1'), api_token: '[redacted]', note: 'x' }, outcome: 'error', error_code: 'invalid_args' }]);

    // NUL / unpaired surrogates in rejected arguments: Postgres jsonb would reject them; the row must still be written.
    const nul = await rpc('tools/call', { name: 'get_order', arguments: { order_id: seedId('order:1'), nul_note: 'a\u0000b', ['k\uD800']: 'c\uDC00' } });
    expect(nul.result?.isError).toBe(true);
    expect(await auditCount()).toBe(before + 5);
    const nulRows = (await ctx.client.query<Record<string, unknown>>(
      `select arguments, outcome, error_code from audit_events where tool = 'get_order' and arguments ? 'nul_note'`,
    )).rows;
    expect(nulRows).toEqual([{ arguments: { order_id: seedId('order:1'), nul_note: 'a\uFFFDb', ['k\uFFFD']: 'c\uFFFD' }, outcome: 'error', error_code: 'invalid_args' }]);

    // Deeply nested unexpected argument: the bounded redactor must not overflow the stack; one row is still written.
    let deep: unknown = 'leaf';
    for (let i = 0; i < 5000; i++) deep = [deep];
    const nested = await rpc('tools/call', { name: 'get_order', arguments: { order_id: seedId('order:1'), deep_note: deep } });
    expect(nested.result?.isError).toBe(true);
    expect(await auditCount()).toBe(before + 6);
    expect((await ctx.client.query(`select 1 from audit_events where tool = 'get_order' and arguments ? 'deep_note'`)).rows).toHaveLength(1);

    // tools/list is not a tool call and writes nothing; schemas advertise no extra keys.
    const listed = await rpc('tools/list', {});
    expect(await auditCount()).toBe(before + 6);
    for (const t of (listed.result?.tools ?? []) as { inputSchema: { additionalProperties?: unknown } }[]) {
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
    await clientT.close();
  });
});
