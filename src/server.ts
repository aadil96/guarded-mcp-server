import { randomUUID } from 'node:crypto';
import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { ZodError } from 'zod';
import { type Caller, callerFromEnv, writeAudit } from './audit/log.js';
import { AuditTracker } from './audit/transport.js';
import type { AppDb } from './db/types.js';
import { readTools, ToolError } from './tools/read.js';
import { inAppTx } from './db/index.js';

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Runs one read tool and writes exactly one audit row, whatever the outcome. */
export async function callTool(db: AppDb, caller: Caller, name: keyof typeof readTools, args: unknown): Promise<Result> {
  const started = performance.now();
  const correlationId = randomUUID();
  let result: Result;
  let errorCode: string | null = null;
  try {
    const tool = readTools[name];
    // biome-ignore lint/suspicious/noExplicitAny: args already validated against tool.input
    const data = await tool.run(db, tool.input.parse(args ?? {}) as any);
    result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
  } catch (e) {
    errorCode = e instanceof ToolError ? e.code : e instanceof ZodError ? 'invalid_args' : 'internal_error';
    const msg = e instanceof ToolError ? e.message : e instanceof ZodError ? 'invalid arguments' : 'internal error';
    if (errorCode === 'internal_error') console.error(`[${correlationId}]`, e);
    result = { content: [{ type: 'text', text: JSON.stringify({ error: errorCode, message: msg, correlationId }) }], isError: true };
  }
  await inAppTx(db, (tx) => writeAudit(tx, {
    actor: caller.actor, role: caller.role, tool: name, args,
    outcome: errorCode ? 'error' : 'ok', startedAt: started, correlationId, errorCode,
  }));
  return result;
}

/** Pass the same tracker to auditingTransport() so SDK-rejected calls are audited exactly once. */
export function createServer(db: AppDb, caller: Caller = callerFromEnv(), tracker = new AuditTracker()) {
  const server = new McpServer({ name: 'guarded-mcp-server', version: '0.0.0' }, { capabilities: { tools: {} } });
  for (const [name, tool] of Object.entries(readTools) as [keyof typeof readTools, (typeof readTools)[keyof typeof readTools]][]) {
    server.registerTool(name, {
      description: tool.description,
      inputSchema: tool.input,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, (args: unknown, ctx: ServerContext) => {
      tracker.markHandled(ctx.mcpReq.id);
      return callTool(db, caller, name, args);
    });
  }
  return server;
}
