import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeApproval, requestWrite, resolveApproval } from '../src/approvals/index.js';
import { issueRefund } from '../src/approvals/refund.js';
import { closeAppDb, connectAsApp, inAppTx } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';
import type { AppDb } from '../src/db/types.js';
import { computeRefundable, paise, zInvoiceId } from '../src/domain/brands.js';
import { freshDb } from './helpers.js';

// The one refundable computation (paid - refunded for an invoice), as meridian_app, on real Postgres in CI.
let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: AppDb;
const op = { actor: 'op-p4', role: 'operator' as const };
const admin = { actor: 'admin-p4', role: 'admin' as const };
const one = async <T>(q: string, p: unknown[] = []) => (await ctx.client.query<T>(q, p)).rows[0];
const invoice = async (status: string, offset = 0) => {
  const r = await one<{ id: string; invoice_number: string; paid_paise: string }>(
    `select id, invoice_number, paid_paise::text from invoices where status = $1 order by invoice_number offset $2 limit 1`, [status, offset]);
  return { ...r, id: zInvoiceId.parse(r.id) };
};
const refund = async (invoiceId: string, amount: number, key: string) => {
  const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: { invoice_id: invoiceId, amount_paise: amount, reason: 'p4 test' }, idempotencyKey: key });
  if (r.kind !== 'pending') throw new Error(r.kind);
  await resolveApproval(db, { ...admin, approvalId: r.approvalId, decision: 'approve' });
  return executeApproval(db, r.approvalId, admin);
};

beforeAll(async () => {
  ctx = await freshDb();
  await seed(ctx.db);
  if (ctx.url) db = await connectAsApp(ctx.url);
  else { await ctx.client.query('set role meridian_app'); db = ctx.db as unknown as AppDb; }
});
afterAll(async () => { if (ctx.url) await closeAppDb(db); await ctx.client.close(); });

describe('computeRefundable: paid - refunded for one invoice', () => {
  it('starts at paid_paise, drops by exactly each refund, and reaches 0 after a full refund', async () => {
    const inv = await invoice('paid');
    expect(await computeRefundable(db, inv.id)).toBe(paise(inv.paid_paise));
    expect((await refund(inv.id, 100, `p4-part-${inv.id}`)).kind).toBe('executed');
    expect(await computeRefundable(db, inv.id)).toBe(paise(BigInt(inv.paid_paise) - 100n));
    const rest = Number(BigInt(inv.paid_paise) - 100n);
    expect((await refund(inv.id, rest, `p4-rest-${inv.id}`)).kind).toBe('executed');
    expect(await computeRefundable(db, inv.id)).toBe(paise(0));
    expect(await one('select status from invoices where id = $1', [inv.id])).toEqual({ status: 'refunded' });
  });

  it('is the same value with and without the row lock', async () => {
    const inv = await invoice('paid', 1);
    const plain = await computeRefundable(db, inv.id);
    const locked = await inAppTx(db, (tx) => computeRefundable(tx, inv.id, { lock: true }));
    expect(locked).toBe(plain);
  });

  it('is exact above Number.MAX_SAFE_INTEGER', async () => {
    const inv = await invoice('paid', 2);
    await ctx.client.query('reset role').catch(() => {});
    await ctx.client.query(`update invoices set total_paise = 9007199254740993, paid_paise = 9007199254740993 where id = $1`, [inv.id]);
    if (!ctx.url) await ctx.client.query('set role meridian_app');
    expect(await computeRefundable(db, inv.id)).toBe(paise(9007199254740993n));
  });

  it('is null for an invoice that does not exist, and execute reports invoice_not_found', async () => {
    const missing = zInvoiceId.parse('00000000-0000-4000-8000-000000000000');
    expect(await computeRefundable(db, missing)).toBeNull();
    expect(await refund(missing, 100, 'p4-missing')).toMatchObject({ kind: 'failed', error: 'invoice_not_found' });
  });

  it('an over-refund fails and leaves refundable unchanged', async () => {
    const inv = await invoice('paid', 3);
    const before = await computeRefundable(db, inv.id);
    if (before === null) throw new Error('seeded invoice missing');
    expect(await refund(inv.id, Number(before) + 1, `p4-over-${inv.id}`)).toMatchObject({ kind: 'failed', error: 'amount_exceeds_remaining' });
    expect(await computeRefundable(db, inv.id)).toBe(before);
  });
});

describe('issue_refund summarize uses the same computation and has no side effects', () => {
  it('names the refundable amount', async () => {
    const inv = await invoice('paid', 4);
    const s = await issueRefund.summarize(db, { invoice_id: inv.id, amount_paise: 1500, reason: 'p4' });
    expect(s).toMatch(new RegExp(`^Refund ₹15\\.00 on ${inv.invoice_number}; ₹[\\d,]+\\.\\d{2} refundable when requested$`));
  });

  it('takes no row lock and writes nothing: it completes while another transaction holds the invoice', async () => {
    if (!ctx.url) return; // a second session is needed to hold the lock; CI always has DATABASE_URL
    const inv = await invoice('paid', 5);
    const holder = await connectAsApp(ctx.url);
    const counts = () => one(`select (select count(*)::int from approvals) a, (select count(*)::int from audit_events) e, (select count(*)::int from refunds) r`);
    const before = await counts();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const lockTx = inAppTx(holder, async (tx) => { await computeRefundable(tx, inv.id, { lock: true }); locked(); await held; });
    await isLocked;
    try {
      const s = await Promise.race([
        issueRefund.summarize(db, { invoice_id: inv.id, amount_paise: 100, reason: 'p4' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('summarize blocked on the invoice lock')), 2000)),
      ]);
      expect(s).toMatch(/refundable when requested$/);
      expect(await counts()).toEqual(before);
    } finally {
      release();
      await lockTx;
      await closeAppDb(holder);
    }
  });
});
