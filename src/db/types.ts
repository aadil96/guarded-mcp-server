import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

// biome-ignore lint/suspicious/noExplicitAny: works with both node-postgres and PGlite drizzle handles
export type Db = PgDatabase<PgQueryResultHKT, any>;
