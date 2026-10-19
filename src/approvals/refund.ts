import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Approval, ToolHandler } from './types.js';
import { queryRows } from '../db/index.js';
import { computeRefundable, paise, paiseToSafeNumber, zInvoiceId } from '../domain/brands.js';

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
  invoice_id: zInvoiceId,
  amount_paise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reason: z.string().trim().min(1).max(500).refine((v) => !v.includes('\u0000') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v), 'reason must not contain NUL or unpaired surrogates'),
});

function parse(args: Record<string, unknown>) {
  const a = issueRefundSchema.parse(args);
  // The argument boundary: the id is branded by zod, the amount becomes exact Paise here.
  return { invoiceId: a.invoice_id, amount: paise(a.amount_paise), reason: a.reason };
}

export const issueRefund: ToolHandler = {
  schema: issueRefundSchema,
  // Read-only: no lock, no writes. The refundable figure is as of the request; execute re-checks it under lock.
  async summarize(db, args) {
    const { invoiceId, amount } = parse(args);
    const [inv] = await queryRows<{ invoice_number: string }>(db, sql`select invoice_number from invoices where id = ${invoiceId}`);
    const refundable = await computeRefundable(db, invoiceId);
    const target = inv?.invoice_number ?? `invoice ${invoiceId}`;
    return refundable === null ? `Refund ${formatInr(amount)} on ${target}` : `Refund ${formatInr(amount)} on ${target}; ${formatInr(refundable)} refundable when requested`;
  },
  async execute(tx, approval: Approval) {
    const { invoiceId, amount, reason } = parse(approval.arguments);
    // Locks the invoice, so concurrent refunds on it serialize and this check is authoritative.
    const remaining = await computeRefundable(tx, invoiceId, { lock: true });
    if (remaining === null) return { ok: false, error: 'invoice_not_found' };
    if (amount > remaining) return { ok: false, error: 'amount_exceeds_remaining' };
    const refundId = crypto.randomUUID();
    await tx.execute(sql`
      insert into refunds (id, invoice_id, approval_id, amount_paise, reason)
      values (${refundId}, ${invoiceId}, ${approval.id}, ${amount.toString()}, ${reason})
    `);
    const fully = amount === remaining; // all paid money refunded
    if (fully) await tx.execute(sql`update invoices set status = 'refunded' where id = ${invoiceId}`);
    return { ok: true, result: { refundId, invoiceId, amountPaise: paiseToSafeNumber(amount), remainingPaise: (remaining - amount).toString(), invoiceRefunded: fully } };
  },
};
