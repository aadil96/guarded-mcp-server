import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Db } from './db/types.js';
import { createServer } from './server.js';

// stdout carries the MCP protocol; log only to stderr.
async function openDb(): Promise<Db> {
  if (process.env.MCP_DEV_PGLITE === '1') {
    // Dev-only: throwaway in-memory PGlite, migrated and seeded. Never used unless explicitly requested.
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const { seed } = await import('./db/seed.js');
    const db = drizzle(new PGlite());
    await migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname });
    await seed(db);
    console.error('guarded-mcp-server: using in-memory PGlite (MCP_DEV_PGLITE=1), seeded');
    return db;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (or MCP_DEV_PGLITE=1 for a throwaway dev DB)');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const pg = (await import('pg')).default;
  return drizzle(new pg.Pool({ connectionString: url }));
}

const db = await openDb();
serveStdio(() => createServer(db), { onerror: (e) => console.error('stdio error:', e) });
