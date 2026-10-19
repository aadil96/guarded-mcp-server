import type { SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { AppDb, AppQueryable, AppTx } from './types.js';

export type { AppDb, AppQueryable, AppTx } from './types.js';

export const APP_ROLE = 'meridian_app';

/** Runs before pg-pool hands a client out; a rejection destroys the client, so no query runs as the login user. */
async function enterAppRole(client: pg.ClientBase) {
  await client.query(`SET ROLE ${APP_ROLE}`);
  const r = await client.query<{ u: string }>('select current_user as u');
  if (r.rows[0]?.u !== APP_ROLE) throw new Error(`expected current_user ${APP_ROLE}, got ${r.rows[0]?.u}`);
}

const pools = new WeakMap<AppDb, pg.Pool>();

/**
 * The only way to get an AppDb. Every pooled connection runs SET ROLE meridian_app and checks current_user
 * before use. Fails closed: a missing URL, a refused SET ROLE or a wrong current_user rejects, and the pool
 * is ended, so no handle exists that could run as the login user.
 */
export async function connectAsApp(url: string | undefined): Promise<AppDb> {
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: url, onConnect: enterAppRole });
  try {
    const r = await pool.query<{ u: string }>('select current_user as u');
    if (r.rows[0]?.u !== APP_ROLE) throw new Error(`database role check failed: current_user is ${r.rows[0]?.u}`);
  } catch (e) {
    await pool.end().catch(() => {});
    throw e;
  }
  const db = drizzle(pool) as unknown as AppDb;
  pools.set(db, pool);
  return db;
}

/** Ends the pool behind an AppDb from connectAsApp. A no-op for handles it did not create. */
export async function closeAppDb(db: AppDb): Promise<void> {
  const pool = pools.get(db);
  pools.delete(db);
  await pool?.end();
}

/** Opens a transaction whose handle is branded AppTx, the type audit writes require. */
export function inAppTx<T>(db: AppDb, fn: (tx: AppTx) => Promise<T>): Promise<T> {
  return db.transaction((tx) => fn(tx as unknown as AppTx));
}

/** Runs raw SQL and returns its rows. Both pg and PGlite results carry `rows`. */
export async function queryRows<T>(db: AppQueryable, q: SQL): Promise<T[]> {
  const r = (await db.execute(q)) as unknown as { rows: T[] };
  return r.rows;
}
