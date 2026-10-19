import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { callerFromEnv } from './audit/log.js';
import { AuditTracker, auditingTransport } from './audit/transport.js';
import { APP_ROLE, closeAppDb, connectAsApp } from './db/index.js';
import type { AppDb } from './db/types.js';
import { createServer } from './server.js';

// stdout carries the MCP protocol; log only to stderr.
async function openDb(): Promise<AppDb> {
  try {
    return await connectAsApp(process.env.DATABASE_URL);
  } catch (e) {
    // Fail closed: never serve as the login user, and never without a database.
    console.error(`guarded-mcp-server: refusing to start, could not run as ${APP_ROLE}:`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

const db = await openDb();
const close = () => closeAppDb(db);
const caller = callerFromEnv();
const tracker = new AuditTracker();
// When the connection closes (stdin EOF or a signal), release the pool so the process exits on its own.
const handle = serveStdio(() => createServer(db, caller, tracker), {
  transport: auditingTransport(new StdioServerTransport(), db, caller, tracker, close),
  onerror: (e) => console.error('stdio error:', e) });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void handle.close(); });
