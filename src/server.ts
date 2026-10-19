import { McpServer } from '@modelcontextprotocol/server';
import { type Caller, callerFromEnv } from './audit/log.js';
import { AuditTracker } from './audit/transport.js';
import type { AppDb } from './db/types.js';
import './tools/read.js'; // side-effect: registers tools into the framework registry
import { registerReadTools } from './tools/framework.js';

/** Pass the same tracker to auditingTransport() so SDK-rejected calls are audited exactly once. */
export function createServer(db: AppDb, caller: Caller = callerFromEnv(), tracker = new AuditTracker()) {
  const server = new McpServer({ name: 'guarded-mcp-server', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerReadTools(server, db, caller, tracker);
  return server;
}
