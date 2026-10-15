import { and, asc, desc, eq, ilike, or, type SQL } from 'drizzle-orm';
import * as z from 'zod';
import * as s from '../db/schema.js';
import type { Db } from '../db/types.js';

export const MAX_PAGE = 50;

export class ToolError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const uuid = z.string().uuid();
// Values above MAX_PAGE are clamped, not rejected.
const limit = z.number().int().min(1).optional().describe(`Page size, default 20, capped at ${MAX_PAGE}`);
const offset = z.number().int().min(0).optional().describe('Rows to skip, default 0');
const page = (a: { limit?: number; offset?: number }) => ({ limit: Math.min(a.limit ?? 20, MAX_PAGE), offset: a.offset ?? 0 });

/** Escape LIKE/ILIKE wildcards so user text matches literally (default escape char is backslash). */
export const escapeLike = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);

const customerCols = {
  id: s.customers.id, name: s.customers.name, city: s.customers.city, gstin: s.customers.gstin,
  phone: s.customers.phone, email: s.customers.email, createdAt: s.customers.createdAt,
};
const orderCols = {
  id: s.orders.id, orderNumber: s.orders.orderNumber, customerId: s.orders.customerId, status: s.orders.status,
  totalPaise: s.orders.totalPaise, createdAt: s.orders.createdAt, updatedAt: s.orders.updatedAt,
};

function one<T>(rows: T[], what: string): T {
  if (!rows[0]) throw new ToolError('not_found', `${what} not found`);
  return rows[0];
}

type Def<S extends z.ZodObject> = { description: string; input: S; run: (db: Db, a: z.infer<S>) => Promise<unknown> };
const def = <S extends z.ZodObject>(d: Def<S>) => d;

export const readTools = {
  list_customers: def({
    description: `List customers, oldest first. Paginated, max ${MAX_PAGE} per page.`,
    input: z.object({ limit, offset }),
    run: (db, a) => db.select(customerCols).from(s.customers).orderBy(asc(s.customers.createdAt), asc(s.customers.id)).limit(page(a).limit).offset(page(a).offset),
  }),
  get_customer: def({
    description: 'Get one customer by id.',
    input: z.object({ customer_id: uuid }),
    run: async (db, a) => one(await db.select(customerCols).from(s.customers).where(eq(s.customers.id, a.customer_id)), 'customer'),
  }),
  list_orders: def({
    description: `List orders, newest first, optionally filtered by customer_id and/or status. Max ${MAX_PAGE}.`,
    input: z.object({ customer_id: uuid.optional(), status: z.enum(s.orderStatus.enumValues).optional(), limit, offset }),
    run: (db, a) => {
      const w: SQL[] = [];
      if (a.customer_id) w.push(eq(s.orders.customerId, a.customer_id));
      if (a.status) w.push(eq(s.orders.status, a.status));
      return db.select(orderCols).from(s.orders).where(and(...w)).orderBy(desc(s.orders.createdAt), asc(s.orders.id)).limit(page(a).limit).offset(page(a).offset);
    },
  }),
  get_order: def({
    description: 'Get one order by id, with its line items.',
    input: z.object({ order_id: uuid }),
    run: async (db, a) => {
      const order = one(await db.select(orderCols).from(s.orders).where(eq(s.orders.id, a.order_id)), 'order');
      const items = await db.select({
        productId: s.orderItems.productId, sku: s.orderItems.sku, qty: s.orderItems.qty,
        unitPricePaise: s.orderItems.unitPricePaise, lineTotalPaise: s.orderItems.lineTotalPaise,
      }).from(s.orderItems).where(eq(s.orderItems.orderId, a.order_id)).orderBy(asc(s.orderItems.sku), asc(s.orderItems.id));
      return { ...order, items };
    },
  }),
  list_invoices: def({
    description: `List invoices, newest first, optionally filtered by customer_id and/or status. Max ${MAX_PAGE}.`,
    input: z.object({ customer_id: uuid.optional(), status: z.enum(s.invoiceStatus.enumValues).optional(), limit, offset }),
    run: (db, a) => {
      const w: SQL[] = [];
      if (a.customer_id) w.push(eq(s.invoices.customerId, a.customer_id));
      if (a.status) w.push(eq(s.invoices.status, a.status));
      return db.select().from(s.invoices).where(and(...w)).orderBy(desc(s.invoices.createdAt), asc(s.invoices.id)).limit(page(a).limit).offset(page(a).offset);
    },
  }),
  get_invoice: def({
    description: 'Get one invoice by id.',
    input: z.object({ invoice_id: uuid }),
    run: async (db, a) => one(await db.select().from(s.invoices).where(eq(s.invoices.id, a.invoice_id)), 'invoice'),
  }),
  search_orders: def({
    description: `Search orders by order number or customer name (case-insensitive substring; wildcards are matched literally). Max ${MAX_PAGE}.`,
    input: z.object({ query: z.string().min(1).max(100), limit }),
    run: (db, a) => {
      const pat = `%${escapeLike(a.query)}%`;
      return db.select({ ...orderCols, customerName: s.customers.name }).from(s.orders)
        .innerJoin(s.customers, eq(s.customers.id, s.orders.customerId))
        .where(or(ilike(s.orders.orderNumber, pat), ilike(s.customers.name, pat)))
        .orderBy(asc(s.orders.orderNumber)).limit(page(a).limit);
    },
  }),
  list_pending_approvals: def({
    description: `List write requests waiting for a human decision, oldest first. Max ${MAX_PAGE}.`,
    input: z.object({ limit }),
    run: (db, a) => db.select({
      id: s.approvals.id, tool: s.approvals.tool, summary: s.approvals.summary, arguments: s.approvals.arguments,
      requestedBy: s.approvals.requestedBy, createdAt: s.approvals.createdAt,
    }).from(s.approvals).where(eq(s.approvals.status, 'pending')).orderBy(asc(s.approvals.createdAt)).limit(page(a).limit),
  }),
};

export type ReadToolName = keyof typeof readTools;
