import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export type QueryResult<T> = { rows: T[]; affectedRows: number };
export type TestClient = {
  query<T = Record<string, unknown>>(q: string, params?: unknown[]): Promise<QueryResult<T>>;
  close(): Promise<void>;
};

// With DATABASE_URL set (CI), each test file gets its own throwaway database on real Postgres.
// Without it, tests use in-memory PGlite for a fast local loop.
export async function freshDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    const pglite = new PGlite();
    const db = drizzlePglite(pglite);
    await migratePglite(db, { migrationsFolder: 'drizzle' });
    const client: TestClient = {
      async query<T>(q: string, params?: unknown[]) {
        const r = await pglite.query<T>(q, params);
        return { rows: r.rows, affectedRows: r.affectedRows ?? 0 };
      },
      close: () => pglite.close(),
    };
    return { client, db, url: undefined as string | undefined };
  }

  const name = `t_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const dbUrl = new URL(url);
  dbUrl.pathname = `/${name}`;
  const pgClient = new pg.Client({ connectionString: dbUrl.toString() });
  await pgClient.connect();
  const db = drizzlePg(pgClient);
  await migratePg(db, { migrationsFolder: 'drizzle' });
  const client: TestClient = {
    async query<T>(q: string, params?: unknown[]) {
      const r = await pgClient.query(q, params);
      return { rows: r.rows as T[], affectedRows: r.rowCount ?? 0 };
    },
    close: () => pgClient.end(),
  };
  return { client, db, url: dbUrl.toString() as string | undefined };
}
