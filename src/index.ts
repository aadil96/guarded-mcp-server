import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { callerFromEnv } from './audit/log.js';
import { AuditTracker, auditingTransport } from './audit/transport.js';
import { APP_ROLE, appDb, createAppPool, verifyAppRole } from './db/connect.js';
import type { Db } from './db/types.js';
import { createServer } from './server.js';

// stdout carries the MCP protocol; log only to stderr.
type OpenDb = { db: Db; close: () => Promise<void> };

async function openDb(): Promise<OpenDb> {
  if (process.env.MCP_DEV_PGLITE === '1') {
    // Dev-only: throwaway in-memory PGlite, migrated and seeded. Never used unless explicitly requested.
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const { seed } = await import('./db/seed.js');
    const { sql } = await import('drizzle-orm');
    const pglite = new PGlite();
    const db = drizzle(pglite);
    await migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname });
    await seed(db);
    await db.execute(sql.raw(`SET ROLE ${APP_ROLE}`)); // same least-privilege role as the pg path
    const who = (await db.execute(sql.raw('select current_user as u'))) as unknown as { rows: { u: string }[] };
    if (who.rows[0]?.u !== APP_ROLE) throw new Error(`PGlite role check failed: ${who.rows[0]?.u}`);
    console.error('guarded-mcp-server: using in-memory PGlite (MCP_DEV_PGLITE=1), seeded');
    return { db, close: () => pglite.close() };
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
  return { db: appDb(pool), close: () => pool.end() };
}

const { db, close } = await openDb();
const caller = callerFromEnv();
const tracker = new AuditTracker();
// When the connection closes (stdin EOF or a signal), release the pool so the process exits on its own.
const handle = serveStdio(() => createServer(db, caller, tracker), {
  transport: auditingTransport(new StdioServerTransport(), db, caller, tracker, close),
  onerror: (e) => console.error('stdio error:', e) });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void handle.close(); });
