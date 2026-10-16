import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { callerFromEnv } from './audit/log.js';
import { AuditTracker, auditingTransport } from './audit/transport.js';
import { APP_ROLE, appDb, createAppPool, verifyAppRole } from './db/connect.js';
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
    const { sql } = await import('drizzle-orm');
    const db = drizzle(new PGlite());
    await migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname });
    await seed(db);
    await db.execute(sql.raw(`SET ROLE ${APP_ROLE}`)); // same least-privilege role as the pg path
    const who = (await db.execute(sql.raw('select current_user as u'))) as unknown as { rows: { u: string }[] };
    if (who.rows[0]?.u !== APP_ROLE) throw new Error(`PGlite role check failed: ${who.rows[0]?.u}`);
    console.error('guarded-mcp-server: using in-memory PGlite (MCP_DEV_PGLITE=1), seeded');
    return db;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (or MCP_DEV_PGLITE=1 for a throwaway dev DB)');
  const pool = createAppPool(url);
  try {
    await verifyAppRole(pool);
  } catch (e) {
    // Fail closed: never serve as the login user.
    console.error(`guarded-mcp-server: refusing to start, could not run as ${APP_ROLE}:`, e instanceof Error ? e.message : e);
    await pool.end().catch(() => {});
    process.exit(1);
  }
  return appDb(pool);
}

const db = await openDb();
const caller = callerFromEnv();
const tracker = new AuditTracker();
serveStdio(() => createServer(db, caller, tracker), {
  transport: auditingTransport(new StdioServerTransport(), db, caller, tracker),
  onerror: (e) => console.error('stdio error:', e) });
