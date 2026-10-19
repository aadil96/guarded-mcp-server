import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { callerFromEnv } from './audit/log.js';
import { AuditTracker, auditingTransport } from './audit/transport.js';
import { loadTokenConfig, type TokenEntry } from './auth/tokens.js';
import { APP_ROLE, closeAppDb, connectAsApp } from './db/index.js';
import type { AppDb } from './db/types.js';
import { startHttpServer } from './http/server.js';
import { createServer } from './server.js';

// stdout carries the MCP protocol on stdio; log only to stderr.
const fail = (what: string, e: unknown): never => {
  console.error(`guarded-mcp-server: refusing to start, ${what}:`, e instanceof Error ? e.message : e);
  process.exit(1);
};

async function openDb(): Promise<AppDb> {
  try {
    return await connectAsApp(process.env.DATABASE_URL);
  } catch (e) {
    // Fail closed: never serve as the login user, and never without a database.
    return fail(`could not run as ${APP_ROLE}`, e);
  }
}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

async function serveHttp() {
  // Tokens first: with no or malformed token config the server never opens a port or a database pool.
  let tokens: TokenEntry[] = [];
  try {
    tokens = await loadTokenConfig();
  } catch (e) {
    fail('HTTP token config', e);
  }
  const port = Number(process.env.MCP_HTTP_PORT ?? 3333);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('HTTP config', new Error('MCP_HTTP_PORT must be an integer port'));
  const db = await openDb();
  const srv = await startHttpServer({
    db, tokens, port, host: process.env.MCP_HTTP_HOST || '127.0.0.1',
    allowedHosts: list(process.env.MCP_HTTP_ALLOWED_HOSTS), allowedOrigins: list(process.env.MCP_HTTP_ALLOWED_ORIGINS),
  });
  console.error(`guarded-mcp-server: listening on ${srv.url.href} (${tokens.length} token(s))`);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => { void srv.close().then(() => closeAppDb(db)); });
  }
}

async function serveStdioEntry() {
  const db = await openDb();
  const close = () => closeAppDb(db);
  const caller = callerFromEnv();
  const tracker = new AuditTracker();
  // When the connection closes (stdin EOF or a signal), release the pool so the process exits on its own.
  const handle = serveStdio(() => createServer(db, caller, tracker), {
    transport: auditingTransport(new StdioServerTransport(), db, caller, tracker, close),
    onerror: (e) => console.error('stdio error:', e) });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void handle.close(); });
}

const transport = process.env.MCP_TRANSPORT ?? 'stdio';
if (transport === 'http') await serveHttp();
else if (transport === 'stdio') await serveStdioEntry();
else fail('MCP_TRANSPORT', new Error('must be "stdio" or "http"'));
