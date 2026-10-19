import { sql } from 'drizzle-orm';
import * as z from 'zod';
import { queryRows } from '../db/index.js';
import type { AppQueryable, AppTx } from '../db/types.js';

// Ids: zod brands are type-only, so the wire schema (and tools/list) is exactly z.guid()'s.
// Parsing with these schemas is the only way to get an id: at the argument boundary, or from an approvals row.
export const zInvoiceId = z.guid().brand<'InvoiceId'>();
export const zApprovalId = z.guid().brand<'ApprovalId'>();
export type InvoiceId = z.infer<typeof zInvoiceId>;
export type ApprovalId = z.infer<typeof zApprovalId>;

// Money: exact integer paise, bigint-backed, because sums of paise can exceed Number.MAX_SAFE_INTEGER.
declare const paiseBrand: unique symbol;
export type Paise = bigint & { readonly [paiseBrand]: true };

/**
 * The number/bigint boundary, and the only Paise constructor. Accepts a safe integer number (tool arguments),
 * a bigint, or an integer string (Postgres bigint/numeric columns); anything inexact throws.
 */
export function paise(v: number | bigint | string): Paise {
  if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new RangeError('paise must be a safe integer number');
  if (typeof v === 'string' && !/^-?\d+$/.test(v)) throw new RangeError('paise must be an integer string');
  return BigInt(v) as Paise;
}

/** Paise as a JSON number, for values known to be safe (e.g. a tool argument); throws rather than round. */
export function paiseToSafeNumber(p: Paise): number {
  const n = Number(p);
  if (!Number.isSafeInteger(n)) throw new RangeError('paise exceeds Number.MAX_SAFE_INTEGER');
  return n;
}

/**
 * Refundable = paid - refunded for one invoice, or null if the invoice doesn't exist. The one implementation,
 * used by issue_refund's summarize (plain read, no lock, no writes) and execute ({ lock: true } in its tx).
 * Locking is two statements on purpose: the refunds sum must be read after the lock is granted, so it sees
 * every refund committed by a transaction we waited on (one statement would keep its pre-wait snapshot).
 */
export async function computeRefundable(q: AppQueryable, invoiceId: InvoiceId): Promise<Paise | null>;
export async function computeRefundable(tx: AppTx, invoiceId: InvoiceId, opts: { lock: true }): Promise<Paise | null>;
export async function computeRefundable(q: AppQueryable, invoiceId: InvoiceId, opts?: { lock: true }): Promise<Paise | null> {
  const [inv] = await queryRows<{ paid_paise: string }>(q, opts?.lock
    ? sql`select paid_paise::text as paid_paise from invoices where id = ${invoiceId} for update`
    : sql`select paid_paise::text as paid_paise from invoices where id = ${invoiceId}`);
  if (!inv) return null;
  const [refunded] = await queryRows<{ s: string }>(q, sql`select coalesce(sum(amount_paise), 0)::text as s from refunds where invoice_id = ${invoiceId}`);
  return paise(paise(inv.paid_paise) - paise(refunded.s));
}
