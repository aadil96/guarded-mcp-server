import { beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from './helpers.js';
import { seed, seedId } from '../src/db/seed.js';
import type { AppDb } from '../src/db/types.js';
import { createApprovals, requestWrite, resolveApproval, executeApproval } from '../src/approvals/index.js';

let ctx: Awaited<ReturnType<typeof freshDb>>;

beforeAll(async () => {
  ctx = await freshDb();
  await seed(ctx.db);
});

describe.runIf(process.env.DATABASE_URL)('approve/deny/execute entrypoints enforce caller rules', () => {
  const admin = { actor: 'approver', role: 'admin' as const };
  const reader = { actor: 'r', role: 'reader' as const };
  const op = { actor: 'operator1', role: 'operator' as const };

  it('self-approval refused (single-operator disabled)', async () => {
    const db = ctx.db as unknown as AppDb;
    const r = await requestWrite(db, { ...admin, tool: 'issue_refund', args: { invoice_id: seedId('invoice:2'), amount_paise: 1, reason: 'x' }, idempotencyKey: 'p5-self' });
    if (r.kind !== 'pending') throw new Error(r.kind);
    const before = (await ctx.client.query<{ n: number }>('select count(*)::int n from audit_events')).rows[0].n;
    const res = await resolveApproval(db, { ...admin, approvalId: r.approvalId, decision: 'approve' });
    expect(res).toEqual({ kind: 'denied', reason: 'self_approval_forbidden' });
    const after = (await ctx.client.query<{ n: number }>('select count(*)::int n from audit_events')).rows[0].n;
    expect(after).toBe(before + 1);
  });

  it('wrong role refused for approve and execute', async () => {
    const db = ctx.db as unknown as AppDb;
    const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: { invoice_id: seedId('invoice:3'), amount_paise: 1, reason: 'x' }, idempotencyKey: 'p5-wrongrole' });
    if (r.kind !== 'pending') throw new Error(r.kind);
    const n0 = (await ctx.client.query<{ n: number }>('select count(*)::int n from audit_events')).rows[0].n;
    expect(await resolveApproval(db, { ...reader, approvalId: r.approvalId, decision: 'approve' })).toEqual({ kind: 'denied', reason: 'admin_required' });
    const n1 = (await ctx.client.query<{ n: number }>('select count(*)::int n from audit_events')).rows[0].n;
    expect(n1).toBe(n0 + 1);
    const n2 = (await ctx.client.query<{ n: number }>('select count(*)::int n from audit_events')).rows[0].n;
    expect(await executeApproval(db, r.approvalId, reader)).toEqual({ kind: 'denied', reason: 'role_not_permitted' });
    const n3 = (await ctx.client.query<{ n: number }>('select count(*)::int n from audit_events')).rows[0].n;
    expect(n3).toBe(n2 + 1);
  });

  it('forged actor/role in args are rejected/ignored for write and do not bypass checks', async () => {
    const db = ctx.db as unknown as AppDb;
    const key = 'p5-forged';
    const before = (await ctx.client.query<{ n: number }>('select count(*)::int n from audit_events')).rows[0].n;
    const bad = await requestWrite(db, { ...op, tool: 'issue_refund', args: { invoice_id: seedId('invoice:4'), amount_paise: 1, reason: 'x', actor: 'evil', role: 'admin' }, idempotencyKey: key } as never);
    expect(bad.kind).toBe('invalid_args');
    const after = (await ctx.client.query<{ n: number }>('select count(*)::int n from audit_events')).rows[0].n;
    expect(after).toBe(before + 1);
  });
});

