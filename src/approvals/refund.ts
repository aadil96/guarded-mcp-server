import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Approval, ToolHandler } from './types.js';
import { inAppTx, queryRows } from '../db/index.js';
import { computeRefundable, computeRefundableBigInt, paiseToBigInt, zInvoiceId, type Paise } from '../domain/brands.js';

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
  amount_paise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform((n) => n as Paise),
  reason: z.string().trim().min(1).max(500).refine((v) => !v.includes('\u0000') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v), 'reason must not contain NUL or unpaired surrogates'),
});

function parse(args: Record<string, unknown>) {
  const a = issueRefundSchema.parse(args);
  return { invoiceId: a.invoice_id, amount: a.amount_paise, reason: a.reason };
}

export const issueRefund: ToolHandler = {
  schema: issueRefundSchema,
  async summarize(db, args) {
    const { invoiceId, amount } = parse(args);
    // Exercise refundable computation path even in summarize.
    if ('transaction' in (db as unknown as Record<string, unknown>)) {
      await inAppTx(db as never, (tx) => computeRefundable(tx, invoiceId));
    }
    const [inv] = await queryRows<{ invoice_number: string }>(db, sql`select invoice_number from invoices where id = ${invoiceId}`);
    return `Refund ${formatInr(amount)} on ${inv?.invoice_number ?? `invoice ${invoiceId}`}`;
  },
  async execute(tx, approval: Approval) {
    const { invoiceId, amount, reason } = parse(approval.arguments);
    // Compute refundable under lock.
    const remaining = await computeRefundableBigInt(tx as never, invoiceId);
    const amt = paiseToBigInt(amount);
    if (amt > remaining) return { ok: false, error: 'amount_exceeds_remaining' };
    const refundId = crypto.randomUUID();
    await tx.execute(sql`
      insert into refunds (id, invoice_id, approval_id, amount_paise, reason)
      values (${refundId}, ${invoiceId}, ${approval.id}, ${amount}, ${reason})
    `);
    const fully = amt === remaining; // all paid money refunded
    if (fully) await tx.execute(sql`update invoices set status = 'refunded' where id = ${invoiceId}`);
    return { ok: true, result: { refundId, invoiceId, amountPaise: amount, remainingPaise: (remaining - amt).toString(), invoiceRefunded: fully } };
  },
};
