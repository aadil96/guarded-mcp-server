import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { AppDb, AppTx } from './types.js';

const APP_ROLE = 'meridian_app' as const;
const CLOSE_PROP = Symbol.for('appdb.close');

async function enterAppRole(client: pg.ClientBase) {
  await client.query(`SET ROLE ${APP_ROLE}`);
  const r = await client.query<{ u: string }>('select current_user as u');
  if (r.rows[0]?.u !== APP_ROLE) {
    throw new Error(`expected current_user ${APP_ROLE}, got ${r.rows[0]?.u}`);
  }
}

async function verifyAppRole(pool: pg.Pool) {
  const r = await pool.query<{ u: string }>('select current_user as u');
  if (r.rows[0]?.u !== APP_ROLE) {
    throw new Error(`database role check failed: current_user is ${r.rows[0]?.u}`);
  }
}

/**
 * Open a database handle that always runs as the least-privilege application role.
 * - Fails closed: if SET ROLE is not permitted, no connection is handed out.
 * - Verifies current_user = meridian_app before returning.
 * - Attaches a close() method to the handle for clean shutdown.
 */
export async function connectAsApp(url: string | undefined | null): Promise<AppDb> {
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: url, onConnect: enterAppRole });
  try {
    await verifyAppRole(pool);
  } catch (e) {
    // Ensure a failing probe never leaves a live pool behind.
    await pool.end().catch(() => {});
    throw e instanceof Error ? e : new Error(String(e));
  }
  const db = drizzle(pool) as AppDb;
  // Attach a close hook to support clean server shutdown without leaking the Pool.
  Object.defineProperty(db, CLOSE_PROP, {
    value: async () => { await pool.end().catch(() => {}); },
    enumerable: false,
    configurable: false,
    writable: false,
  });
  // Also provide a conventional close() for callers that check for it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).close = async () => { await pool.end().catch(() => {}); };
  return db;
}

// Utility to brand transaction handles inside drizzle's transaction callback.
export const brandTx = (tx: unknown) => tx as AppTx;

// Expose the symbol so internal code can discover and call the attached close hook if needed.
export const APP_DB_CLOSE_SYMBOL = CLOSE_PROP;

