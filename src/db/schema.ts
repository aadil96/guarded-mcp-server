import { sql } from 'drizzle-orm';
import {
  bigint, check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

const money = (name: string) => bigint(name, { mode: 'number' }).notNull();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const orderStatus = pgEnum('order_status', ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled']);
export const invoiceStatus = pgEnum('invoice_status', ['unpaid', 'part_paid', 'paid', 'refunded']);
export const writeTool = pgEnum('write_tool', ['issue_refund', 'update_order_status', 'create_credit_note', 'add_customer_note']);
export const approvalStatus = pgEnum('approval_status', ['pending', 'approved', 'denied', 'executed', 'failed']);
export const role = pgEnum('role', ['reader', 'operator', 'admin']);
export const auditOutcome = pgEnum('audit_outcome', ['ok', 'error', 'denied', 'pending_approval', 'duplicate', 'conflict']);

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  city: text('city').notNull(),
  gstin: text('gstin').notNull().unique(),
  phone: text('phone').notNull(),
  email: text('email').notNull(),
  createdAt: createdAt(),
});

export const products = pgTable('products', {
  id: uuid('id').primaryKey(),
  sku: text('sku').notNull().unique(),
  name: text('name').notNull(),
  unitPricePaise: money('unit_price_paise'),
  createdAt: createdAt(),
}, (t) => [check('products_price_nonneg', sql`${t.unitPricePaise} >= 0`)]);

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey(),
  orderNumber: text('order_number').notNull().unique(),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  status: orderStatus('status').notNull(),
  totalPaise: money('total_paise'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('orders_total_nonneg', sql`${t.totalPaise} >= 0`),
  index('orders_customer_idx').on(t.customerId),
]);

export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  productId: uuid('product_id').notNull().references(() => products.id),
  sku: text('sku').notNull(),
  qty: integer('qty').notNull(),
  unitPricePaise: money('unit_price_paise'),
  lineTotalPaise: money('line_total_paise'),
}, (t) => [
  check('order_items_qty_pos', sql`${t.qty} > 0`),
  check('order_items_price_nonneg', sql`${t.unitPricePaise} >= 0`),
  check('order_items_line_total', sql`${t.lineTotalPaise} = ${t.qty} * ${t.unitPricePaise}`),
  index('order_items_order_idx').on(t.orderId),
]);

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey(),
  invoiceNumber: text('invoice_number').notNull().unique(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  status: invoiceStatus('status').notNull(),
  totalPaise: money('total_paise'),
  paidPaise: money('paid_paise'),
  createdAt: createdAt(),
}, (t) => [
  check('invoices_total_nonneg', sql`${t.totalPaise} >= 0`),
  check('invoices_paid_range', sql`${t.paidPaise} >= 0 AND ${t.paidPaise} <= ${t.totalPaise}`),
]);

export const refunds = pgTable('refunds', {
  id: uuid('id').primaryKey(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id),
  approvalId: uuid('approval_id').notNull().references(() => approvals.id),
  amountPaise: money('amount_paise'),
  reason: text('reason').notNull(),
  createdAt: createdAt(),
}, (t) => [check('refunds_amount_pos', sql`${t.amountPaise} > 0`)]);

export const creditNotes = pgTable('credit_notes', {
  id: uuid('id').primaryKey(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id),
  approvalId: uuid('approval_id').notNull().references(() => approvals.id),
  amountPaise: money('amount_paise'),
  reason: text('reason').notNull(),
  createdAt: createdAt(),
}, (t) => [check('credit_notes_amount_pos', sql`${t.amountPaise} > 0`)]);

export const notes = pgTable('notes', {
  id: uuid('id').primaryKey(),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  body: text('body').notNull(),
  author: text('author').notNull(),
  createdAt: createdAt(),
});

// NOTE: resolved_by <> requested_by is deliberately NOT a DB constraint.
// Local-dev single-operator mode lets one person request and approve; the app
// enforces separation (and the admin-role requirement) outside local-dev.
export const approvals = pgTable('approvals', {
  id: uuid('id').primaryKey(),
  tool: writeTool('tool').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  argsHash: text('args_hash').notNull(),
  arguments: jsonb('arguments').notNull(),
  summary: text('summary').notNull(),
  status: approvalStatus('status').notNull().default('pending'),
  requestedBy: text('requested_by').notNull(),
  resolvedBy: text('resolved_by'),
  result: jsonb('result'),
  createdAt: createdAt(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  executedAt: timestamp('executed_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('approvals_tool_key_uq').on(t.tool, t.idempotencyKey),
  check('approvals_args_hash_fmt', sql`${t.argsHash} ~ '^[0-9a-f]{64}$'`),
]);

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey(),
  createdAt: createdAt(),
  actor: text('actor').notNull(),
  role: role('role').notNull(),
  tool: text('tool').notNull(),
  arguments: jsonb('arguments').notNull(),
  outcome: auditOutcome('outcome').notNull(),
  approvalId: uuid('approval_id'),
  idempotencyKey: text('idempotency_key'),
  durationMs: integer('duration_ms').notNull(),
  correlationId: text('correlation_id').notNull(),
  errorCode: text('error_code'),
}, (t) => [
  check('audit_duration_nonneg', sql`${t.durationMs} >= 0`),
  index('audit_created_idx').on(t.createdAt),
]);
