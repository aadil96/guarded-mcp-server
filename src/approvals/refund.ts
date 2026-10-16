import { z } from 'zod';
import type { Approval, Sql, ToolHandler } from './types.js';

export function formatInr(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const issueRefundSchema = z.strictObject({
  invoice_id: z.guid(),
  amount_paise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reason: z.string().trim().min(1).max(500),
});

function parse(args: Record<string, unknown>) {
  const a = issueRefundSchema.parse(args);
  return { invoiceId: a.invoice_id, amount: a.amount_paise, reason: a.reason };
}

export const issueRefund: ToolHandler = {
  schema: issueRefundSchema,
  async summarize(sql: Sql, args) {
    const { invoiceId, amount } = parse(args);
    const r = await sql.query<{ invoice_number: string }>('select invoice_number from invoices where id = $1', [invoiceId]);
    return `Refund ${formatInr(amount)} on ${r.rows[0]?.invoice_number ?? `invoice ${invoiceId}`}`;
  },
  async execute(tx: Sql, approval: Approval) {
    const { invoiceId, amount, reason } = parse(approval.arguments);
    // Lock the invoice so concurrent refunds on it serialize and the remaining check is authoritative.
    const inv = await tx.query<{ paid_paise: string | number }>('select paid_paise from invoices where id = $1 for update', [invoiceId]);
    if (!inv.rows[0]) return { ok: false, error: 'invoice_not_found' };
    // Cap is what the customer actually paid, not the invoice total.
    // bigint end to end: paise sums can exceed Number.MAX_SAFE_INTEGER.
    const paid = BigInt(inv.rows[0].paid_paise);
    const amt = BigInt(amount);
    const prior = await tx.query<{ s: string | number }>('select coalesce(sum(amount_paise), 0) s from refunds where invoice_id = $1', [invoiceId]);
    const remaining = paid - BigInt(prior.rows[0].s);
    if (amt > remaining) return { ok: false, error: 'amount_exceeds_remaining' };
    const refundId = crypto.randomUUID();
    await tx.query('insert into refunds (id, invoice_id, approval_id, amount_paise, reason) values ($1,$2,$3,$4,$5)',
      [refundId, invoiceId, approval.id, amount, reason]);
    const fully = amt === remaining; // all paid money refunded
    if (fully) await tx.query(`update invoices set status = 'refunded' where id = $1`, [invoiceId]);
    return { ok: true, result: { refundId, invoiceId, amountPaise: amount, remainingPaise: (remaining - amt).toString(), invoiceRefunded: fully } };
  },
};
