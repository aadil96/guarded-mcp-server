import type { Approval, Sql, ToolHandler } from './types.js';

export function formatInr(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function parse(args: Record<string, unknown>) {
  const { invoice_id, amount_paise, reason } = args;
  if (typeof invoice_id !== 'string' || !Number.isSafeInteger(amount_paise) || (amount_paise as number) <= 0 || typeof reason !== 'string') {
    throw new TypeError('issue_refund: invalid arguments');
  }
  return { invoiceId: invoice_id, amount: amount_paise as number, reason };
}

export const issueRefund: ToolHandler = {
  async summarize(sql: Sql, args) {
    const { invoiceId, amount } = parse(args);
    const r = await sql.query<{ invoice_number: string }>('select invoice_number from invoices where id = $1', [invoiceId]);
    return `Refund ${formatInr(amount)} on ${r.rows[0]?.invoice_number ?? `invoice ${invoiceId}`}`;
  },
  async execute(tx: Sql, approval: Approval) {
    const { invoiceId, amount, reason } = parse(approval.arguments);
    // Lock the invoice so concurrent refunds on it serialize and the remaining check is authoritative.
    const inv = await tx.query<{ total_paise: string | number }>('select total_paise from invoices where id = $1 for update', [invoiceId]);
    if (!inv.rows[0]) return { ok: false, error: 'invoice_not_found' };
    const total = Number(inv.rows[0].total_paise);
    const prior = await tx.query<{ s: string | number }>('select coalesce(sum(amount_paise), 0) s from refunds where invoice_id = $1', [invoiceId]);
    const remaining = total - Number(prior.rows[0].s);
    if (amount > remaining) return { ok: false, error: 'amount_exceeds_remaining' };
    const refundId = crypto.randomUUID();
    await tx.query('insert into refunds (id, invoice_id, approval_id, amount_paise, reason) values ($1,$2,$3,$4,$5)',
      [refundId, invoiceId, approval.id, amount, reason]);
    const fully = amount === remaining;
    if (fully) await tx.query(`update invoices set status = 'refunded' where id = $1`, [invoiceId]);
    return { ok: true, result: { refundId, invoiceId, amountPaise: amount, remainingPaise: remaining - amount, invoiceRefunded: fully } };
  },
};
