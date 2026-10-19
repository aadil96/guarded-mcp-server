import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

// Use explicit branded types to distinguish the app-scoped database handle from generic drizzle instances.
// biome-ignore lint/suspicious/noExplicitAny: works with both node-postgres and PGlite drizzle handles
export type DrizzleDb = PgDatabase<PgQueryResultHKT, any>;

export type AppDb = DrizzleDb & { readonly __brand: 'AppDb' };
export type AppTx = DrizzleDb & { readonly __brand: 'AppTx' };

