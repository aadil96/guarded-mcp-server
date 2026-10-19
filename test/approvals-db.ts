import { createAppPool } from '../src/db/connect.js';
import type { Db, Sql } from '../src/approvals/index.js';
import type { TestClient } from './helpers.js';

/**
 * Real Postgres (url set): a pg.Pool, so concurrent calls really run on separate connections.
 * Both run as the least-privilege role meridian_app.
 * PGlite: one in-process connection, so transactions are serialized with a mutex.
 */
export function approvalsDb(client: TestClient, url?: string): Db & { close(): Promise<void> } {
  if (url) {
    // The production pool: every connection enters meridian_app and fails closed if it can't.
    const pool = createAppPool(url);
    return {
      query: async (q, p) => ({ rows: (await pool.query(q, p)).rows }),
      async transaction(fn) {
        const c = await pool.connect();
        try {
          await c.query('begin');
          const tx: Sql = { query: async (q, p) => ({ rows: (await c.query(q, p)).rows }) };
          const r = await fn(tx);
          await c.query('commit');
          return r;
        } catch (e) {
          await c.query('rollback');
          throw e;
        } finally {
          c.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const ready = client.query('set role meridian_app');
  let lock: Promise<unknown> = ready;
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const run = lock.then(f, f);
    lock = run.catch(() => undefined);
    return run;
  };
  const q: Sql['query'] = (s, p) => client.query(s, p);
  return {
    query: (s, p) => serial(() => q(s, p)),
    transaction: (fn) => serial(async () => {
      await q('begin');
      try {
        const r = await fn({ query: q });
        await q('commit');
        return r;
      } catch (e) {
        await q('rollback');
        throw e;
      }
    }),
    close: async () => {},
  };
}
