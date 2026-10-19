import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db, executeApproval, type HandlerMap, requestWrite, resolveApproval } from '../src/approvals/index.js';
import { issueRefund } from '../src/approvals/refund.js';
import { seed } from '../src/db/seed.js';
import { approvalsDb } from './approvals-db.js';
import { freshDb } from './helpers.js';

// drizzle/0003_approvals_column_grants.sql: meridian_app may UPDATE only the columns the approval
// code writes (src/approvals/index.ts resolve + execute). Everything else is refused by the GRANT
// (SQLSTATE 42501) before the approvals_guard trigger runs; the trigger's frozen-field error is 23514.
const WRITABLE = ['executed_at', 'resolved_at', 'resolved_by', 'result', 'status'];

let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: Db & { close(): Promise<void> };
const op = { actor: 'op-1', role: 'operator' as const };
const admin = { actor: 'admin-1', role: 'admin' as const };
const used = new Set<string>();

// Unique invoice for flows that execute; requests that are never executed may share one.
async function paidInvoice(unique = true) {
  const r = await db.query<{ id: string; paid_paise: string }>(`select id, paid_paise from invoices where status = 'paid' order by invoice_number`);
  const row = unique ? r.rows.find((x) => !used.has(x.id)) : r.rows[r.rows.length - 1];
  if (!row) throw new Error('no unused paid invoice in seed');
  if (unique) used.add(row.id);
  return { id: row.id, paid: Number(row.paid_paise) };
}
const refundArgs = (invoice_id: string, amount_paise: number) => ({ invoice_id, amount_paise, reason: 'damaged in transit' });
async function pending(key: string, amount = 100, unique = true) {
  const inv = await paidInvoice(unique);
  const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, amount), idempotencyKey: key });
  if (r.kind !== 'pending') throw new Error(`expected pending, got ${r.kind}`);
  return r.approvalId;
}
async function approved(key: string, amount = 100) {
  const id = await pending(key, amount, true);
  expect(await resolveApproval(db, { ...admin, approvalId: id, decision: 'approve' })).toMatchObject({ kind: 'resolved', status: 'approved' });
  return id;
}
const row = async (id: string) => (await db.query<Record<string, unknown>>('select * from approvals where id = $1', [id])).rows[0];
async function sqlState(q: string, p: unknown[]): Promise<{ code?: string; message: string }> {
  try {
    await db.query(q, p);
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error(`expected "${q}" to be refused`);
}

beforeAll(async () => {
  ctx = await freshDb();
  await seed(ctx.db);
  db = approvalsDb(ctx.client, ctx.url);
});
afterAll(async () => { await db.close(); await ctx.client.close(); });

describe('meridian_app UPDATE on approvals is column-level', () => {
  it('runs as meridian_app with no table-wide UPDATE, and UPDATE on exactly the written columns', async () => {
    const r = await db.query<{ u: string; table_update: boolean }>(
      `select current_user as u, has_table_privilege('meridian_app', 'approvals', 'UPDATE') as table_update`);
    expect(r.rows[0]).toEqual({ u: 'meridian_app', table_update: false });
    const cols = await db.query<{ column_name: string; can_update: boolean }>(
      `select column_name, has_column_privilege('meridian_app', 'approvals', column_name, 'UPDATE') as can_update
         from information_schema.columns where table_schema = 'public' and table_name = 'approvals' order by column_name`);
    expect(cols.rows.length).toBeGreaterThan(WRITABLE.length);
    expect(cols.rows.filter((c) => c.can_update).map((c) => c.column_name)).toEqual(WRITABLE);
  });

  // Same-value updates pass the trigger (IS DISTINCT FROM is false), so a refusal here is the grant alone.
  for (const col of ['arguments', 'args_hash', 'idempotency_key', 'tool', 'requested_by', 'summary', 'created_at', 'id']) {
    it(`UPDATE ${col} (even to its current value) is refused with 42501 by the grant`, async () => {
      const id = await pending(`grant-${col}`, 100, false);
      const before = await row(id);
      for (const st of ['pending', 'approved']) {
        if (st === 'approved') await resolveApproval(db, { ...admin, approvalId: id, decision: 'approve' });
        const err = await sqlState(`update approvals set ${col} = ${col} where id = $1`, [id]);
        expect(err.code).toBe('42501');
        expect(err.message).toMatch(/permission denied for table approvals/);
      }
      expect((await row(id))[col]).toEqual(before[col]);
    });
  }

  it('a changed frozen value is also refused by the grant (42501), not reaching the trigger (23514)', async () => {
    const id = await pending('grant-swap', 100, false);
    const cases: [string, unknown][] = [
      ['arguments', JSON.stringify(refundArgs('00000000-0000-4000-8000-000000000000', 999999))],
      ['args_hash', 'f'.repeat(64)],
      ['idempotency_key', 'swapped'],
      ['tool', 'add_customer_note'],
    ];
    for (const [col, v] of cases) {
      const err = await sqlState(`update approvals set ${col} = $2 where id = $1`, [id, v]);
      expect(err.code, col).toBe('42501');
    }
    const after = await row(id);
    expect(after).toMatchObject({ idempotency_key: 'grant-swap', tool: 'issue_refund', status: 'pending' });
  });
});

describe('approval flow still works under the narrowed grant', () => {
  it('request -> approve -> execute writes status, resolved_by, resolved_at, result, executed_at', async () => {
    const id = await approved('flow-ok');
    const r = await row(id);
    expect(r).toMatchObject({ status: 'approved', resolved_by: 'admin-1' });
    expect(r.resolved_at).not.toBeNull();
    const ex = await executeApproval(db, id, admin);
    expect(ex.kind).toBe('executed');
    const done = await row(id);
    expect(done.status).toBe('executed');
    expect(done.executed_at).not.toBeNull();
    expect(done.result).toMatchObject({ amountPaise: 100 });
    expect(await executeApproval(db, id, admin)).toMatchObject({ kind: 'duplicate', status: 'executed' });
  });

  it('request -> deny', async () => {
    const id = await pending('flow-deny', 100, false);
    expect(await resolveApproval(db, { ...admin, approvalId: id, decision: 'deny' })).toMatchObject({ kind: 'resolved', status: 'denied' });
    expect(await row(id)).toMatchObject({ status: 'denied', resolved_by: 'admin-1' });
    expect(await executeApproval(db, id, admin)).toMatchObject({ kind: 'not_approved', status: 'denied' });
  });

  it('failure path: handler refuses -> failed with result and executed_at', async () => {
    const inv = await paidInvoice();
    const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, inv.paid + 1), idempotencyKey: 'flow-over' });
    if (r.kind !== 'pending') throw new Error(r.kind);
    await resolveApproval(db, { ...admin, approvalId: r.approvalId, decision: 'approve' });
    expect(await executeApproval(db, r.approvalId, admin)).toEqual({ kind: 'failed', approvalId: r.approvalId, error: 'amount_exceeds_remaining' });
    const f = await row(r.approvalId);
    expect(f).toMatchObject({ status: 'failed', result: { error: 'amount_exceeds_remaining' } });
    expect(f.executed_at).not.toBeNull();
  });

  it('failure path: handler throws -> failed, side effects rolled back', async () => {
    const throwing: HandlerMap = {
      issue_refund: { ...issueRefund, execute: async () => { throw new Error('boom'); } },
    };
    const id = await approved('flow-throw');
    expect(await executeApproval(db, id, admin, throwing)).toEqual({ kind: 'failed', approvalId: id, error: 'boom' });
    expect(await row(id)).toMatchObject({ status: 'failed', result: { error: 'boom' } });
  });
});
