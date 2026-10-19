import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';

// biome-ignore lint/suspicious/noExplicitAny: schema-less handles, so one type covers the pg pool and transactions
type AnySchema = any;

declare const appDbBrand: unique symbol;
declare const appTxBrand: unique symbol;

/**
 * A pooled handle that runs as meridian_app. Only src/db/index.ts constructs one (connectAsApp), so holding an
 * AppDb means the role check passed.
 */
export type AppDb = PgDatabase<PgQueryResultHKT, AnySchema> & { readonly [appDbBrand]: true };

/** A transaction opened from an AppDb through inAppTx(). Not assignable to AppDb, and vice versa. */
export type AppTx = PgTransaction<PgQueryResultHKT, AnySchema> & { readonly [appTxBrand]: true };

/** Anything that can run a statement as meridian_app. */
export type AppQueryable = AppDb | AppTx;
