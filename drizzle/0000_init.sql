CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'denied', 'executed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('ok', 'error', 'denied', 'pending_approval', 'duplicate', 'conflict');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('unpaid', 'part_paid', 'paid', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'confirmed', 'shipped', 'delivered', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('reader', 'operator', 'admin');--> statement-breakpoint
CREATE TYPE "public"."write_tool" AS ENUM('issue_refund', 'update_order_status', 'create_credit_note', 'add_customer_note');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tool" "write_tool" NOT NULL,
	"idempotency_key" text NOT NULL,
	"args_hash" text NOT NULL,
	"arguments" jsonb NOT NULL,
	"summary" text NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"resolved_by" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	CONSTRAINT "approvals_args_hash_fmt" CHECK ("approvals"."args_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"role" "role" NOT NULL,
	"tool" text NOT NULL,
	"arguments" jsonb NOT NULL,
	"outcome" "audit_outcome" NOT NULL,
	"approval_id" uuid,
	"idempotency_key" text,
	"duration_ms" integer NOT NULL,
	"correlation_id" text NOT NULL,
	"error_code" text,
	CONSTRAINT "audit_duration_nonneg" CHECK ("audit_events"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_notes_amount_pos" CHECK ("credit_notes"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"city" text NOT NULL,
	"gstin" text NOT NULL,
	"phone" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_gstin_unique" UNIQUE("gstin")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_number" text NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "invoice_status" NOT NULL,
	"total_paise" bigint NOT NULL,
	"paid_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_invoice_number_unique" UNIQUE("invoice_number"),
	CONSTRAINT "invoices_total_nonneg" CHECK ("invoices"."total_paise" >= 0),
	CONSTRAINT "invoices_paid_range" CHECK ("invoices"."paid_paise" >= 0 AND "invoices"."paid_paise" <= "invoices"."total_paise")
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"body" text NOT NULL,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_paise" bigint NOT NULL,
	"line_total_paise" bigint NOT NULL,
	CONSTRAINT "order_items_qty_pos" CHECK ("order_items"."qty" > 0),
	CONSTRAINT "order_items_price_nonneg" CHECK ("order_items"."unit_price_paise" >= 0),
	CONSTRAINT "order_items_line_total" CHECK ("order_items"."line_total_paise" = "order_items"."qty" * "order_items"."unit_price_paise")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "order_status" NOT NULL,
	"total_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_number_unique" UNIQUE("order_number"),
	CONSTRAINT "orders_total_nonneg" CHECK ("orders"."total_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"unit_price_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_sku_unique" UNIQUE("sku"),
	CONSTRAINT "products_price_nonneg" CHECK ("products"."unit_price_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_amount_pos" CHECK ("refunds"."amount_paise" > 0)
);
--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_tool_key_uq" ON "approvals" USING btree ("tool","idempotency_key");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");