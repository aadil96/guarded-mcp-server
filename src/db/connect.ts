import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Db } from './types.js';

export const APP_ROLE = 'meridian_app';

/** Throws unless this connection is now acting as the app role. */
async function enterAppRole(client: pg.ClientBase) {
  await client.query(`SET ROLE ${APP_ROLE}`);
  const r = await client.query<{ u: string }>('select current_user as u');
  if (r.rows[0]?.u !== APP_ROLE) throw new Error(`expected current_user ${APP_ROLE}, got ${r.rows[0]?.u}`);
}

/**
 * Pool whose every connection drops to the least-privilege app role, so the grants and
 * append-only triggers from drizzle/0001_guards.sql apply at runtime even when the login
 * user owns the tables. Fails closed: pg-pool's onConnect hook runs before the client is
 * handed out, and if it rejects the pool ends that client and the query/connect errors.
 * A connection never silently continues as the login user.
 */
export function createAppPool(connectionString: string) {
  return new pg.Pool({ connectionString, onConnect: enterAppRole });
}

/** Startup probe: resolves only if a pooled connection reports current_user = meridian_app. */
export async function verifyAppRole(pool: pg.Pool) {
  const r = await pool.query<{ u: string }>('select current_user as u');
  if (r.rows[0]?.u !== APP_ROLE) throw new Error(`database role check failed: current_user is ${r.rows[0]?.u}`);
}

export const appDb = (pool: pg.Pool): Db => drizzle(pool);
