import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Approval, ToolHandler } from './types.js';
import type { AppDb, AppTx } from '../db/types.js';

/** Integer-only INR formatting (en-IN grouping); no float division, so every paise is exact. */
export function formatInr(paise: number | bigint): string {
  const v = BigInt(paise);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const rupees = (abs / 100n).toString();
  const frac = (abs % 100n).toString().padStart(2, '0');
  const head = rupees.slice(0, -3);
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+$)/g, ',')},${rupees.slice(-3)}` : rupees;
  return `${neg ? '-' : ''}₹${grouped}.${frac}`;
}

export const issueRefundSchema = z.strictObject({
  invoice_id: z.guid(),
  amount_paise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reason: z.string().trim().min(1).max(500).refine((v) => !v.includes('\u0000') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v), 'reason must not contain NUL or unpaired surrogates'),
});

function parse(args: Record<string, unknown>) {
  const a = issueRefundSchema.parse(args);
  return { invoiceId: a.invoice_id, amount: a.amount_paise, reason: a.reason };
}

export const issueRefund: ToolHandler = {
  schema: issueRefundSchema,
  async summarize(db: AppDb | AppTx, args) {
    const { invoiceId, amount } = parse(args);
    const r = await (db as AppDb).execute(sql`select invoice_number from invoices where id = ${invoiceId}`);
    return `Refund ${formatInr(amount)} on ${(r as unknown as { rows: { invoice_number: string }[] }).rows[0]?.invoice_number ?? `invoice ${invoiceId}`}`;
  },
  async execute(tx: AppTx, approval: Approval) {
    const { invoiceId, amount, reason } = parse(approval.arguments);
    // Lock the invoice so concurrent refunds on it serialize and the remaining check is authoritative.
    const inv = await (tx as AppDb).execute(sql`select paid_paise from invoices where id = ${invoiceId} for update`);
    if (!inv.rows[0]) return { ok: false, error: 'invoice_not_found' };
    // Cap is what the customer actually paid, not the invoice total.
    // bigint end to end: paise sums can exceed Number.MAX_SAFE_INTEGER.
    const paid = BigInt((inv as unknown as { rows: { paid_paise: string | number }[] }).rows[0].paid_paise);
    const amt = BigInt(amount);
    const prior = await (tx as AppDb).execute(sql`select coalesce(sum(amount_paise), 0) s from refunds where invoice_id = ${invoiceId}`);
    const remaining = paid - BigInt((prior as unknown as { rows: { s: string | number }[] }).rows[0].s);
    if (amt > remaining) return { ok: false, error: 'amount_exceeds_remaining' };
    const refundId = crypto.randomUUID();
    await (tx as AppDb).execute(sql`
      insert into refunds (id, invoice_id, approval_id, amount_paise, reason)
      values (${refundId}, ${invoiceId}, ${approval.id}, ${amount}, ${reason})
    `);
    const fully = amt === remaining; // all paid money refunded
    if (fully) await (tx as AppDb).execute(sql`update invoices set status = 'refunded' where id = ${invoiceId}`);
    return { ok: true, result: { refundId, invoiceId, amountPaise: amount, remainingPaise: (remaining - amt).toString(), invoiceRefunded: fully } };
  },
};
