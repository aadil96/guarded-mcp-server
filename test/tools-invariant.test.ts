import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { seed, seedId } from '../src/db/seed.js';
import type { AppDb } from '../src/db/types.js';
import { AuditTracker, auditingTransport } from '../src/audit/transport.js';
import { createServer } from '../src/server.js';
import { freshDb } from './helpers.js';

let ctx: Awaited<ReturnType<typeof freshDb>>;
const caller = { actor: 'inv-test', role: 'reader' as const };
const auditN = async () => (await ctx.client.query<{ n: number }>('select count(*)::int n from audit_events')).rows[0].n;

function rpcClient(db: AppDb) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const tracker = new AuditTracker();
  const pending = new Map<number, (m: JSONRPCMessage) => void>();
  let id = 0;
  return {
    async start() {
      await createServer(db, caller, tracker).connect(auditingTransport(serverT, db, caller, tracker));
      clientT.onmessage = (m) => { if ('id' in m && typeof m.id === 'number') pending.get(m.id)?.(m); };
      await clientT.start();
      await this.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'inv', version: '0' } });
      await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
    },
    async send(method: string, params: unknown) {
      const n = ++id;
      const p = new Promise<Record<string, unknown>>((res) => pending.set(n, res as (m: JSONRPCMessage) => void));
      clientT.send({ jsonrpc: '2.0', id: n, method, params } as JSONRPCMessage);
      const m = await p;
      return (m as { result: Record<string, unknown> }).result;
    },
    async close() { await clientT.close(); },
  };
}

beforeAll(async () => {
  ctx = await freshDb();
  await seed(ctx.db);
});

describe.runIf(process.env.DATABASE_URL)('registry-driven audit invariants (read tools)', () => {
  it('valid, invalid-args, unknown-key and not-found add exactly one audit row each', async () => {
    const db = ctx.db as unknown as AppDb;
    const cli = rpcClient(db);
    await cli.start();
    const list = await cli.send('tools/list', {});
    const tools = (list.tools as { name: string }[]).map((t) => t.name);
    const samples: Record<string, { ok?: unknown; notFound?: unknown; bad?: unknown; extra?: unknown }> = {
      list_customers: { ok: {}, bad: { limit: 'x' }, extra: { limit: 1, extra: true } },
      get_customer: { ok: { customer_id: seedId('customer:1') }, notFound: { customer_id: '00000000-0000-4000-8000-000000000000' }, bad: { customer_id: 1 }, extra: { customer_id: seedId('customer:1'), extra: 1 } },
      list_orders: { ok: {}, bad: { limit: 'x' }, extra: { status: 'pending', extra: 1 } },
      get_order: { ok: { order_id: seedId('order:1') }, notFound: { order_id: '00000000-0000-4000-8000-000000000000' }, bad: { order_id: 'nope' }, extra: { order_id: seedId('order:1'), note: 'x' } },
      list_invoices: { ok: {}, bad: { status: 'nope' }, extra: { limit: 1, extra: 1 } },
      get_invoice: { ok: { invoice_id: seedId('invoice:1') }, notFound: { invoice_id: '00000000-0000-4000-8000-000000000000' }, bad: { invoice_id: 1 }, extra: { invoice_id: seedId('invoice:1'), extra: true } },
      search_orders: { ok: { query: 'ORD-0001' }, bad: { query: '' }, extra: { query: 'ORD', note: 'x' } },
      list_pending_approvals: { ok: {}, bad: { limit: 'x' }, extra: { limit: 1, unknown: 'y' } },
    };
    for (const name of tools) {
      const s = samples[name] ?? {};
      const n0 = await auditN();
      if (s.ok) await cli.send('tools/call', { name, arguments: s.ok });
      if (s.ok) expect(await auditN()).toBe(n0 + 1);
      const n1 = await auditN();
      if (s.bad) await cli.send('tools/call', { name, arguments: s.bad });
      if (s.bad) expect(await auditN()).toBe(n1 + 1);
      const n2 = await auditN();
      if (s.extra) await cli.send('tools/call', { name, arguments: s.extra });
      if (s.extra) expect(await auditN()).toBe(n2 + 1);
      const n3 = await auditN();
      if (s.notFound) await cli.send('tools/call', { name, arguments: s.notFound });
      if (s.notFound) expect(await auditN()).toBe(n3 + 1);
    }
    await cli.close();
  });
});

