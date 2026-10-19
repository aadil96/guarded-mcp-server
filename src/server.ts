import { McpServer } from '@modelcontextprotocol/server';
import { type Caller, callerFromEnv } from './audit/log.js';
import { AuditTracker } from './audit/transport.js';
import type { AppDb } from './db/types.js';
import { type DefinedTool, registerTools } from './tools/framework.js';
import { readTools } from './tools/read.js';
import { writeTools } from './tools/write.js';

/** Every tool the server exposes. */
export const serverTools: readonly DefinedTool[] = [...readTools, ...writeTools];

/** Pass the same tracker to auditingTransport() so SDK-rejected calls are audited exactly once. */
export function createServer(db: AppDb, caller: Caller = callerFromEnv(), tracker = new AuditTracker(), tools: readonly DefinedTool[] = serverTools) {
  const server = new McpServer({ name: 'guarded-mcp-server', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerTools(server, { db, caller, tracker }, tools);
  return server;
}
