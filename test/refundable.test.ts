import { beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from './helpers.js';
import { seed, seedId } from '../src/db/seed.js';
import type { AppDb } from '../src/db/types.js';
import { inAppTx } from '../src/db/index.js';
import { computeRefundable, zInvoiceId } from '../src/domain/brands.js';
import { createApprovals, executeApproval, requestWrite, resolveApproval } from '../src/approvals/index.js';

let ctx: Awaited<ReturnType<typeof freshDb>>;

beforeAll(async () => {
  ctx = await freshDb();
  await seed(ctx.db);
});

describe.runIf(process.env.DATABASE_URL)('refundable computation', () => {
  it('paid invoice refundable starts at paid and drops to 0 after full refund', async () => {
    const db = ctx.db as unknown as AppDb;
    const inv = zInvoiceId.parse(seedId('invoice:3')); // a paid invoice
    const paid = await ctx.client.query<{ p: string }>('select paid_paise p from invoices where id = $1', [inv]);
    const start = await inAppTx(db, (tx) => computeRefundable(tx, inv));
    expect(start).toBe(Number(paid.rows[0].p));
    const op = { actor: 'op', role: 'operator' as const };
    const admin = { actor: 'admin', role: 'admin' as const };
    const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: { invoice_id: inv, amount_paise: start, reason: 'full' }, idempotencyKey: `p4-full-${inv}` });
    if (r.kind !== 'pending') throw new Error(r.kind);
    await resolveApproval(db, { ...admin, approvalId: r.approvalId, decision: 'approve' });
    const ex = await executeApproval(db, r.approvalId, admin);
    expect(ex.kind).toBe('executed');
    const after = await inAppTx(db, (tx) => computeRefundable(tx, inv));
    expect(after).toBe(0);
  });

  it('over-refund attempt fails and leaves refundable unchanged', async () => {
    const db = ctx.db as unknown as AppDb;
    const inv = zInvoiceId.parse(seedId('invoice:4')); // a paid or part-paid invoice
    const before = await inAppTx(db, (tx) => computeRefundable(tx, inv));
    const op = { actor: 'op2', role: 'operator' as const };
    const admin = { actor: 'admin2', role: 'admin' as const };
    const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: { invoice_id: inv, amount_paise: before + 1, reason: 'over' }, idempotencyKey: `p4-over-${inv}` });
    if (r.kind !== 'pending') throw new Error(r.kind);
    await resolveApproval(db, { ...admin, approvalId: r.approvalId, decision: 'approve' });
    const ex = await executeApproval(db, r.approvalId, admin);
    expect(ex.kind).toBe('failed');
    const after = await inAppTx(db, (tx) => computeRefundable(tx, inv));
    expect(after).toBe(before);
  });
});

