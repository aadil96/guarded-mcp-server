import type { ServerContext } from '@modelcontextprotocol/server';
import type { Transport } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod';
import { randomUUID } from 'node:crypto';
import { inAppTx } from '../db/index.js';
import type { AppDb, AppTx } from '../db/types.js';
import { type Caller, writeAudit } from '../audit/log.js';
import { AuditTracker } from '../audit/transport.js';

// Strict Zod object guard: helper accepts only strict schemas.
export type StrictZodObject = z.ZodObject<any>;

export type ReadToolDef<S extends StrictZodObject> = {
  name: string;
  description: string;
  input: S;
  run: (tx: AppTx, args: z.infer<S>) => Promise<unknown>;
};

const readRegistry: ReadToolDef<StrictZodObject>[] = [];

export function defineReadTool<S extends StrictZodObject>(def: ReadToolDef<S>): ReadToolDef<S> {
  readRegistry.push(def as ReadToolDef<StrictZodObject>);
  return def;
}

// Register all read tools on an MCP server. The helper owns parsing, tx, and audit.
export function registerReadTools(server: McpServer, db: AppDb, caller: Caller, tracker: AuditTracker) {
  for (const tool of readRegistry) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.input,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (raw: unknown, ctx: ServerContext) => {
      tracker.markHandled(ctx.mcpReq.id);
      const startedAt = performance.now();
      const correlationId = randomUUID();
      try {
        // Parse strictly at boundary.
        const args = tool.input.parse(raw);
        // Run inside a tx; write audit in the same tx.
        const outcome = await inAppTx(db, async (tx) => {
          try {
            const data = await tool.run(tx, args as never);
            await writeAudit(tx, { actor: caller.actor, role: caller.role, tool: tool.name, args, outcome: 'ok', startedAt, correlationId, errorCode: null });
            return { ok: true as const, data };
          } catch (e) {
            const code = (e as any)?.code === 'not_found' ? 'not_found' : 'internal_error';
            await writeAudit(tx, { actor: caller.actor, role: caller.role, tool: tool.name, args, outcome: 'error', startedAt, correlationId, errorCode: code });
            return { ok: false as const, code };
          }
        });
        if (outcome.ok) return { content: [{ type: 'text' as const, text: JSON.stringify(outcome.data) }] };
        return { isError: true as const, content: [{ type: 'text' as const, text: JSON.stringify({ error: outcome.code, correlationId }) }] };
      } catch {
        // SDK-level rejections are audited by the transport wrapper.
        return { isError: true as const, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'invalid_args' }) }] };
      }
    });
  }
}

// -- Write tools scaffolding --
export type WriteToolSummaryHook<A> = (args: A) => string;

export type WriteOutcome =
  | { kind: 'pending'; summary: string }
  | { kind: 'duplicate'; result: unknown }
  | { kind: 'conflict' }
  | { kind: 'denied' }
  | { kind: 'invalid_args' };

export function mapApprovalOutcomeToMcp(outcome: WriteOutcome) {
  switch (outcome.kind) {
    case 'pending':
      return { isError: false as const, content: [{ type: 'input' as const, text: outcome.summary }] };
    case 'duplicate':
      return { isError: false as const, content: [{ type: 'text' as const, text: JSON.stringify(outcome.result) }] };
    case 'conflict':
    case 'denied':
      return { isError: true as const, content: [{ type: 'text' as const, text: JSON.stringify({ error: outcome.kind }) }] };
    case 'invalid_args':
      return { isError: true as const, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'invalid_args' }) }] };
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

