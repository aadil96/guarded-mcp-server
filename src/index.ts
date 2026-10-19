import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { callerFromEnv } from './audit/log.js';
import { AuditTracker, auditingTransport } from './audit/transport.js';
import { APP_DB_CLOSE_SYMBOL, connectAsApp } from './db/index.js';
import type { AppDb } from './db/types.js';
import { createServer } from './server.js';

// stdout carries the MCP protocol; log only to stderr.
type OpenDb = { db: AppDb; close: () => Promise<void> };

async function openDb(): Promise<OpenDb> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  try {
    const db = await connectAsApp(url);
    const closer =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any).close ??
      (typeof (db as Record<symbol, unknown>)[APP_DB_CLOSE_SYMBOL] === 'function'
        ? ((db as Record<symbol, () => Promise<void>>)[APP_DB_CLOSE_SYMBOL]).bind(db)
        : async () => {});
    return { db, close: closer };
  } catch (e) {
    console.error('guarded-mcp-server: refusing to start, DB app-role check failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

const { db, close } = await openDb();
const caller = callerFromEnv();
const tracker = new AuditTracker();
// When the connection closes (stdin EOF or a signal), release the pool so the process exits on its own.
const handle = serveStdio(() => createServer(db, caller, tracker), {
  transport: auditingTransport(new StdioServerTransport(), db, caller, tracker, close),
  onerror: (e) => console.error('stdio error:', e) });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void handle.close(); });
