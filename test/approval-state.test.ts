import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApprovals, executeApproval, requestWrite, resolveApproval } from '../src/approvals/index.js';
import { TRANSITIONS } from '../src/approvals/state.js';
import type { ApprovalStatus } from '../src/approvals/types.js';
import { closeAppDb, connectAsApp, inAppTx } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';
import type { AppDb } from '../src/db/types.js';
import type { ApprovalId } from '../src/domain/brands.js';
import { auditFailing, freshDb } from './helpers.js';

// P5: every approval transition goes through the typed state machine, as meridian_app, on real Postgres in CI.
let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: AppDb;
let invoiceId = '';
const op = { actor: 'op-sm', role: 'operator' as const };
const admin = { actor: 'admin-sm', role: 'admin' as const };
const admin2 = { actor: 'admin-sm-2', role: 'admin' as const };
const reader = { actor: 'reader-sm', role: 'reader' as const };
const STATUSES: ApprovalStatus[] = ['pending', 'approved', 'denied', 'executed', 'failed'];
let seq = 0;

const one = async <T>(q: string, p: unknown[] = []) => (await ctx.client.query<T>(q, p)).rows[0];
const audits = async () => (await one<{ n: number }>('select count(*)::int n from audit_events')).n;
const lastAudit = () => one<Record<string, unknown>>(
  'select tool, outcome, error_code, approval_id, actor, role from audit_events order by created_at desc, id desc limit 1');
const row = (id: ApprovalId) => one<{ status: string; resolved_by: string | null; resolved_at: Date | null; executed_at: Date | null; result: unknown }>(
  'select status, resolved_by, resolved_at, executed_at, result from approvals where id = $1', [id]);
const refunds = async () => (await one<{ n: number }>('select count(*)::int n from refunds')).n;

/** An approval driven to `status` through the public API (amount 1 executes; a huge amount fails). */
async function inState(status: ApprovalStatus): Promise<ApprovalId> {
  const amount = status === 'failed' ? 999_999_999_999 : 1;
  const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: { invoice_id: invoiceId, amount_paise: amount, reason: 'p5' }, idempotencyKey: `sm-${status}-${seq++}` });
  if (r.kind !== 'pending') throw new Error(r.kind);
  if (status === 'pending') return r.approvalId;
  const res = await resolveApproval(db, { ...admin, approvalId: r.approvalId, decision: status === 'denied' ? 'deny' : 'approve' });
  if (res.kind !== 'resolved') throw new Error(res.kind);
  if (status === 'approved' || status === 'denied') return r.approvalId;
  const ex = await executeApproval(db, r.approvalId, admin);
  if (ex.kind !== status) throw new Error(`${ex.kind} != ${status}`);
  return r.approvalId;
}

beforeAll(async () => {
  ctx = await freshDb();
  await seed(ctx.db);
  invoiceId = (await one<{ id: string }>(`select id from invoices where status = 'paid' order by paid_paise desc limit 1`)).id;
  if (ctx.url) db = await connectAsApp(ctx.url);
  else { await ctx.client.query('set role meridian_app'); db = ctx.db as unknown as AppDb; }
});
afterAll(async () => { if (ctx.url) await closeAppDb(db); await ctx.client.close(); });

describe('the transition table is the database trigger, exactly', () => {
  it('TRANSITIONS allows a status change iff the approvals_guard trigger accepts it (all 25 pairs)', async () => {
    for (const from of STATUSES) {
      const id = await inState(from);
      for (const to of STATUSES) {
        if (to === from) continue;
        const accepted = await inAppTx(db, async (tx) => {
          await tx.execute(sql`savepoint probe`);
          try {
            await tx.execute(sql`update approvals set status = ${to} where id = ${id}`);
            return true;
          } catch {
            return false;
          } finally {
            await tx.execute(sql`rollback to savepoint probe`);
          }
        });
        expect(accepted, `${from} -> ${to}`).toBe((TRANSITIONS[from] as readonly string[]).includes(to));
      }
      expect((await row(id)).status).toBe(from);
    }
  });
});

describe('valid transitions: one audit row each, in the transaction that changes the row', () => {
  it('pending -> approved', async () => {
    const id = await inState('pending');
    const before = await audits();
    expect(await resolveApproval(db, { ...admin, approvalId: id, decision: 'approve' })).toEqual({ kind: 'resolved', approvalId: id, status: 'approved' });
    expect(await audits()).toBe(before + 1);
    expect(await lastAudit()).toMatchObject({ tool: 'resolve_approval', outcome: 'ok', approval_id: id, actor: admin.actor, role: 'admin' });
    expect(await row(id)).toMatchObject({ status: 'approved', resolved_by: admin.actor, resolved_at: expect.any(Date), executed_at: null });
  });

  it('pending -> denied', async () => {
    const id = await inState('pending');
    const before = await audits();
    expect(await resolveApproval(db, { ...admin, approvalId: id, decision: 'deny' })).toEqual({ kind: 'resolved', approvalId: id, status: 'denied' });
    expect(await audits()).toBe(before + 1);
    expect(await row(id)).toMatchObject({ status: 'denied', resolved_by: admin.actor, resolved_at: expect.any(Date) });
  });

  it('approved -> executed', async () => {
    const id = await inState('approved');
    const [before, r0] = [await audits(), await refunds()];
    expect(await executeApproval(db, id, admin)).toMatchObject({ kind: 'executed', approvalId: id });
    expect(await audits()).toBe(before + 1);
    expect(await refunds()).toBe(r0 + 1);
    expect(await lastAudit()).toMatchObject({ tool: 'issue_refund', outcome: 'ok', approval_id: id });
    expect(await row(id)).toMatchObject({ status: 'executed', executed_at: expect.any(Date), result: expect.objectContaining({ refundId: expect.any(String) }) });
  });

  it('approved -> failed (handler refuses): no refund, one audit row', async () => {
    const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: { invoice_id: invoiceId, amount_paise: 999_999_999_999, reason: 'p5' }, idempotencyKey: `sm-fail-${seq++}` });
    if (r.kind !== 'pending') throw new Error(r.kind);
    await resolveApproval(db, { ...admin, approvalId: r.approvalId, decision: 'approve' });
    const [before, r0] = [await audits(), await refunds()];
    expect(await executeApproval(db, r.approvalId, admin)).toMatchObject({ kind: 'failed', error: 'amount_exceeds_remaining' });
    expect(await audits()).toBe(before + 1);
    expect(await refunds()).toBe(r0);
    expect(await row(r.approvalId)).toMatchObject({ status: 'failed', executed_at: expect.any(Date), result: { error: 'amount_exceeds_remaining' } });
  });
});

describe('invalid transitions are refused, audited once, and change nothing', () => {
  for (const from of ['approved', 'denied', 'executed', 'failed'] as const) {
    for (const decision of ['approve', 'deny'] as const) {
      it(`${decision} on ${from} -> invalid_state`, async () => {
        const id = await inState(from);
        const before = await audits();
        expect(await resolveApproval(db, { ...admin2, approvalId: id, decision })).toEqual({ kind: 'invalid_state', status: from });
        expect(await audits()).toBe(before + 1);
        expect(await lastAudit()).toMatchObject({ tool: 'resolve_approval', outcome: 'error', error_code: 'not_pending', approval_id: id });
        expect((await row(id)).status).toBe(from);
      });
    }
  }
  for (const from of ['pending', 'denied'] as const) {
    it(`execute on ${from} -> not_approved`, async () => {
      const id = await inState(from);
      const [before, r0] = [await audits(), await refunds()];
      expect(await executeApproval(db, id, admin)).toEqual({ kind: 'not_approved', status: from });
      expect(await audits()).toBe(before + 1);
      expect(await lastAudit()).toMatchObject({ outcome: 'error', error_code: `status_${from}`, approval_id: id });
      expect(await refunds()).toBe(r0);
      expect((await row(id)).status).toBe(from);
    });
  }
  for (const from of ['executed', 'failed'] as const) {
    it(`execute on ${from} -> duplicate with the stored result, no second effect`, async () => {
      const id = await inState(from);
      const stored = (await row(id)).result;
      const [before, r0] = [await audits(), await refunds()];
      expect(await executeApproval(db, id, admin)).toEqual({ kind: 'duplicate', approvalId: id, status: from, result: stored });
      expect(await audits()).toBe(before + 1);
      expect(await lastAudit()).toMatchObject({ outcome: 'duplicate', approval_id: id });
      expect(await refunds()).toBe(r0);
    });
  }
});

describe('races', () => {
  it('two concurrent executes: exactly one executes, the other is a duplicate, one refund', async () => {
    const id = await inState('approved');
    const [before, r0] = [await audits(), await refunds()];
    const rs = await Promise.all([executeApproval(db, id, admin), executeApproval(db, id, admin2)]);
    expect(rs.map((r) => r.kind).sort()).toEqual(['duplicate', 'executed']);
    expect(await refunds()).toBe(r0 + 1);
    expect(await audits()).toBe(before + 2);
  });

  it('approve racing deny: exactly one wins, the loser sees invalid_state, the row holds the winner', async () => {
    for (let i = 0; i < 5; i++) {
      const id = await inState('pending');
      const before = await audits();
      const [a, d] = await Promise.all([
        resolveApproval(db, { ...admin, approvalId: id, decision: 'approve' }),
        resolveApproval(db, { ...admin2, approvalId: id, decision: 'deny' }),
      ]);
      const winners = [a, d].filter((r) => r.kind === 'resolved');
      expect(winners).toHaveLength(1);
      const loser = [a, d].find((r) => r.kind !== 'resolved');
      const won = winners[0].kind === 'resolved' ? winners[0].status : null;
      expect(loser).toEqual({ kind: 'invalid_state', status: won });
      expect((await row(id)).status).toBe(won);
      expect(await audits()).toBe(before + 2);
    }
  });
});

describe('caller rules, checked server-side on every approve, deny and execute', () => {
  it('self-approval and self-denial are refused (self_approval_forbidden), audited, still pending', async () => {
    const r = await requestWrite(db, { ...admin, tool: 'issue_refund', args: { invoice_id: invoiceId, amount_paise: 1, reason: 'p5' }, idempotencyKey: `sm-self-${seq++}` });
    if (r.kind !== 'pending') throw new Error(r.kind);
    for (const decision of ['approve', 'deny'] as const) {
      const before = await audits();
      expect(await resolveApproval(db, { ...admin, approvalId: r.approvalId, decision })).toEqual({ kind: 'denied', reason: 'self_approval_forbidden' });
      expect(await audits()).toBe(before + 1);
      expect(await lastAudit()).toMatchObject({ outcome: 'denied', error_code: 'self_approval_forbidden', approval_id: r.approvalId });
    }
    expect((await row(r.approvalId)).status).toBe('pending');
  });

  it('only single-operator server config (never request input) allows it', async () => {
    const r = await requestWrite(db, { ...admin, tool: 'issue_refund', args: { invoice_id: invoiceId, amount_paise: 1, reason: 'p5' }, idempotencyKey: `sm-solo-${seq++}` });
    if (r.kind !== 'pending') throw new Error(r.kind);
    expect(await createApprovals({ singleOperator: true }).resolveApproval(db, { ...admin, approvalId: r.approvalId, decision: 'approve' })).toMatchObject({ kind: 'resolved' });
  });

  it('wrong roles are refused for approve, deny and execute, audited, nothing changes', async () => {
    const id = await inState('pending');
    for (const who of [op, reader]) {
      for (const decision of ['approve', 'deny'] as const) {
        const before = await audits();
        expect(await resolveApproval(db, { ...who, approvalId: id, decision })).toEqual({ kind: 'denied', reason: 'admin_required' });
        expect(await audits()).toBe(before + 1);
      }
    }
    const appr = await inState('approved');
    const before = await audits();
    expect(await executeApproval(db, appr, reader)).toEqual({ kind: 'denied', reason: 'role_not_permitted' });
    expect(await audits()).toBe(before + 1);
    expect((await row(id)).status).toBe('pending');
    expect((await row(appr)).status).toBe('approved');
  });

  it('a forged actor or role in arguments is refused, never used as the caller', async () => {
    const id = await inState('pending');
    const before = await audits();
    // resolve: unknown keys in the request are invalid_args (the caller is the typed context, not the payload)
    expect(await resolveApproval(db, { ...op, approvalId: id, decision: 'approve', impersonate: { actor: 'x', role: 'admin' } } as never)).toEqual({ kind: 'invalid_args' });
    // write: actor/role inside tool arguments are unknown keys for the strict schema
    expect((await requestWrite(db, { ...op, tool: 'issue_refund', args: { invoice_id: invoiceId, amount_paise: 1, reason: 'p5', actor: admin.actor, role: 'admin' }, idempotencyKey: `sm-forge-${seq++}` })).kind).toBe('invalid_args');
    expect(await audits()).toBe(before + 2);
    expect((await row(id)).status).toBe('pending');
  });

  it('a forced audit failure on resolve rolls the transition back (atomic)', async () => {
    const id = await inState('pending');
    await expect(resolveApproval(auditFailing(db), { ...admin, approvalId: id, decision: 'approve' })).rejects.toThrow('forced audit failure');
    expect((await row(id)).status).toBe('pending');
  });
});
