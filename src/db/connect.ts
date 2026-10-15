import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Db } from './types.js';

export const APP_ROLE = 'meridian_app';

/**
 * Pool whose every connection drops to the least-privilege app role, so the grants and
 * append-only triggers from drizzle/0001_guards.sql apply at runtime even when the login
 * user owns the tables. pg queues queries per client, so SET ROLE runs before any other query.
 */
export function createAppPool(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  pool.on('connect', (client) => {
    client.query(`SET ROLE ${APP_ROLE}`).catch((e) => console.error('SET ROLE failed:', e));
  });
  return pool;
}

export const appDb = (pool: pg.Pool): Db => drizzle(pool);
