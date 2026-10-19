import * as z from 'zod';
import type { AppTx } from '../db/types.js';
import { sql } from 'drizzle-orm';

// Branded primitives
export type Paise = number & { readonly __brand: 'Paise' };
export type ApprovalId = string & { readonly __brand: 'ApprovalId' };
export type InvoiceId = string & { readonly __brand: 'InvoiceId' };

// Constructors (the only allowed place for 'as')
export const zPaise = z.number().int().nonnegative().transform((n) => n as Paise);
export const zApprovalId = z.string().uuid().transform((s) => s as ApprovalId);
export const zInvoiceId = z.string().uuid().transform((s) => s as InvoiceId);

export function toPaise(n: number): Paise {
  if (!Number.isInteger(n) || n < 0) throw new TypeError('Paise must be a non-negative integer');
  return n as Paise;
}

export function paiseToBigInt(p: Paise): bigint {
  return BigInt(p as number);
}

// Refundable amount = paid - refunded, returned as Paise.
export async function computeRefundable(tx: AppTx, invoiceId: InvoiceId): Promise<Paise> {
  const remaining = await computeRefundableBigInt(tx, invoiceId);
  const asNumber = Number(remaining);
  // If beyond JS safe integer, this cast loses precision; business logic still uses BigInt for checks.
  return toPaise(asNumber);
}

export async function computeRefundableBigInt(tx: AppTx, invoiceId: InvoiceId): Promise<bigint> {
  const paid = await tx.execute(sql`select paid_paise from invoices where id = ${invoiceId} for update`);
  if (!(paid as unknown as { rows: unknown[] }).rows[0]) return 0n;
  const paidPaise = BigInt((paid as unknown as { rows: { paid_paise: string | number }[] }).rows[0].paid_paise);
  const prior = await tx.execute(sql`select coalesce(sum(amount_paise), 0) s from refunds where invoice_id = ${invoiceId}`);
  const refunded = BigInt((prior as unknown as { rows: { s: string | number }[] }).rows[0].s);
  return paidPaise - refunded;
}

