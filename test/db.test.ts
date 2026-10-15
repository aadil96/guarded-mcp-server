import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { argsHash } from '../src/db/args-hash.js';
import { seed, seedId } from '../src/db/seed.js';
import { freshDb } from './helpers.js';

const TABLES = ['customers', 'products', 'orders', 'order_items', 'invoices', 'refunds', 'credit_notes', 'notes', 'approvals', 'audit_events'];
type Ctx = Awaited<ReturnType<typeof freshDb>>;
let ctx: Ctx;

async function counts() {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = (await ctx.client.query<{ n: number }>(`select count(*)::int as n from ${t}`)).rows[0].n;
  return out;
}
async function snapshot() {
  return (await ctx.client.query(`select md5(string_agg(o::text, '|' order by o.id)) h from (select * from orders) o`)).rows;
}
const rejects = (q: string, params: unknown[] = []) => expect(ctx.client.query(q, params)).rejects;

function insertApproval(key: string, args: Record<string, unknown> = { invoice_id: 'x', amount_paise: 100 }) {
  return ctx.client.query(
    `insert into approvals (id, tool, idempotency_key, args_hash, arguments, summary, requested_by)
     values ($1, 'issue_refund', $2, $3, $4, 'Refund', 'local-dev') returning id`,
    [seedId(`test-approval:${key}:${Math.random()}`), key, argsHash(args), JSON.stringify(args)],
  );
}

beforeAll(async () => { ctx = await freshDb(); });

describe('seed', () => {
  it('is idempotent: two runs give identical counts and rows', async () => {
    await seed(ctx.db);
    const first = await counts();
    const snap = await snapshot();
    await seed(ctx.db);
    expect(await counts()).toEqual(first);
    expect(await snapshot()).toEqual(snap);
    expect(first).toMatchObject({ customers: 12, products: 20, orders: 40, invoices: 30, refunds: 0, credit_notes: 0, approvals: 0, audit_events: 0 });
    expect(first.order_items).toBeGreaterThanOrEqual(90);
    expect(first.notes).toBe(15);
    console.log('seed counts', first);
  });
  it('has part_paid invoices and injection notes', async () => {
    const pp = await ctx.client.query<{ n: number }>(`select count(*)::int n from invoices where status = 'part_paid'`);
    expect(pp.rows[0].n).toBeGreaterThan(0);
    const inj = await ctx.client.query<{ n: number }>(`select count(*)::int n from notes where body ilike '%ignore previous instructions%'`);
    expect(inj.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});

describe('order_items', () => {
  it('rejects line_total <> qty * unit_price', async () => {
    const o = seedId('order:1'), p = seedId('product:1');
    await rejects(`insert into order_items values ($1,$2,$3,'MRD-001',2,100,201)`, [seedId('bad-line'), o, p]).toThrow(/order_items_line_total/);
  });
  it('rejects negative money', async () => {
    await rejects(`update products set unit_price_paise = -1 where id = $1`, [seedId('product:1')]).toThrow(/products_price_nonneg/);
  });
});

describe('audit_events append-only', () => {
  const id = seedId('audit:1');
  beforeAll(async () => {
    await ctx.client.query(
      `insert into audit_events (id, actor, role, tool, arguments, outcome, duration_ms, correlation_id)
       values ($1, 'local-dev', 'reader', 'get_order', '{}', 'ok', 3, 'corr-1')`, [id]);
  });
  it('rejects UPDATE', async () => { await rejects(`update audit_events set outcome = 'error' where id = $1`, [id]).toThrow(/append-only/); });
  it('rejects DELETE', async () => { await rejects(`delete from audit_events where id = $1`, [id]).toThrow(/append-only/); });
  it('rejects TRUNCATE', async () => { await rejects(`truncate audit_events`).toThrow(/append-only/); });
  it('app role has only INSERT and SELECT on audit_events', async () => {
    const r = await ctx.client.query<{ p: string }>(
      `select privilege_type p from information_schema.role_table_grants
       where grantee = 'meridian_app' and table_name = 'audit_events' order by 1`);
    expect(r.rows.map((x) => x.p)).toEqual(['INSERT', 'SELECT']);
  });
});

describe('column-level UPDATE grants', () => {
  it('app role can update only status/updated_at on orders and status on invoices', async () => {
    const r = await ctx.client.query<{ t: string; c: string }>(
      `select table_name t, column_name c from information_schema.column_privileges
       where grantee = 'meridian_app' and privilege_type = 'UPDATE' and table_name in ('orders','invoices') order by 1, 2`);
    expect(r.rows.map((x) => `${x.t}.${x.c}`)).toEqual(['invoices.status', 'orders.status', 'orders.updated_at']);
  });
});

describe('approvals', () => {
  it('rejects a duplicate (tool, idempotency_key)', async () => {
    await insertApproval('dup-1');
    await rejects(
      `insert into approvals (id, tool, idempotency_key, args_hash, arguments, summary, requested_by)
       values ($1, 'issue_refund', 'dup-1', $2, '{}', 'Refund', 'local-dev')`, [seedId('dup-2'), argsHash({})],
    ).toThrow(/approvals_tool_key_uq/);
  });
  it('allows pending -> approved -> executed', async () => {
    const { rows } = await insertApproval('ok-path');
    const id = (rows[0] as { id: string }).id;
    await ctx.client.query(`update approvals set status='approved', resolved_by='local-dev', resolved_at=now() where id=$1`, [id]);
    await ctx.client.query(`update approvals set status='executed', executed_at=now() where id=$1`, [id]);
  });
  it.each([
    ['pending', 'executed'], ['pending', 'failed'], ['approved', 'denied'], ['approved', 'pending'],
    ['denied', 'approved'], ['executed', 'approved'],
  ])('rejects %s -> %s', async (from, to) => {
    const { rows } = await insertApproval(`bad-${from}-${to}`);
    const id = (rows[0] as { id: string }).id;
    const path: Record<string, string[]> = { pending: [], approved: ['approved'], denied: ['denied'], executed: ['approved', 'executed'] };
    for (const st of path[from]) await ctx.client.query(`update approvals set status=$2 where id=$1`, [id, st]);
    await rejects(`update approvals set status=$2 where id=$1`, [id, to]).toThrow(/invalid approval transition/);
  });
  it('only executes once under a guarded single UPDATE', async () => {
    const { rows } = await insertApproval('race');
    const id = (rows[0] as { id: string }).id;
    await ctx.client.query(`update approvals set status='approved' where id=$1`, [id]);
    const a = await ctx.client.query(`update approvals set status='executed' where id=$1 and status='approved'`, [id]);
    const b = await ctx.client.query(`update approvals set status='executed' where id=$1 and status='approved'`, [id]);
    expect([a.affectedRows, b.affectedRows]).toEqual([1, 0]);
  });
  it('rejects creating a non-pending approval and changing frozen arguments', async () => {
    await rejects(
      `insert into approvals (id, tool, idempotency_key, args_hash, arguments, summary, requested_by, status)
       values ($1, 'issue_refund', 'np', $2, '{}', 's', 'local-dev', 'approved')`, [seedId('np'), argsHash({})],
    ).toThrow(/created as pending/);
    const { rows } = await insertApproval('frozen');
    await rejects(`update approvals set arguments='{"amount_paise":999999}' where id=$1`, [(rows[0] as { id: string }).id]).toThrow(/frozen/);
  });
});
