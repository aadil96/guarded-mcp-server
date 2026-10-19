import { randomUUID } from 'node:crypto';
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { requestWrite } from '../approvals/index.js';
import { assertNever } from '../approvals/state.js';
import type { Approved, HandlerMap, HandlerOutcome, RequestWriteResult, ToolHandler, WriteTool } from '../approvals/types.js';
import { type Caller, writeAudit } from '../audit/log.js';
import type { AuditTracker } from '../audit/transport.js';
import { inAppTx } from '../db/index.js';
import type { AppDb, AppQueryable, AppTx } from '../db/types.js';

/**
 * The only module that registers MCP tools (scripts/check-mcp-register.mjs enforces it). Tools are built with
 * defineReadTool / defineWriteTool; the framework owns strict parsing, audit, the transaction and result
 * mapping. Handlers only see parsed args and a transaction handle.
 */

// biome-ignore lint/suspicious/noExplicitAny: any shape; strictness is checked at runtime by assertStrict
export type ToolInput = z.ZodObject<any>;

/** Thrown by read handlers for expected failures; the code is audited and returned, the message is shown. */
export class ToolError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

type Deps = { db: AppDb; caller: Caller; tracker: AuditTracker };
const toolBrand: unique symbol = Symbol('tool');

/** An MCP tool built by defineReadTool or defineWriteTool. Not constructible elsewhere. */
export type DefinedTool = {
  readonly [toolBrand]: true;
  readonly name: string;
  readonly kind: 'read' | 'write';
  readonly description: string;
  readonly inputSchema: ToolInput;
  readonly annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  readonly call: (deps: Deps, raw: unknown) => Promise<CallToolResult>;
  /** Write tools only: the approvals handler executeApproval runs once the request is approved. */
  readonly approvalHandler?: ToolHandler;
};

/**
 * Strictness is a property of the schema, enforced when a tool is defined: every object, at any depth, must
 * reject unknown keys. zod's $strict and $strip config types are structurally identical, so this can't be a
 * type constraint; a non-strict schema throws at module load instead.
 */
export function assertStrict(schema: z.ZodType, path = 'input'): void {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> & { type: string } } })._zod.def;
  switch (def.type) {
    case 'object': {
      const catchall = def.catchall as z.ZodType | undefined;
      const strict = catchall !== undefined && (catchall as unknown as { _zod: { def: { type: string } } })._zod.def.type === 'never';
      if (!strict) throw new Error(`${path} must be a strict object (z.strictObject or .strict()) so unknown keys are rejected`);
      for (const [k, v] of Object.entries(def.shape as Record<string, z.ZodType>)) assertStrict(v, `${path}.${k}`);
      return;
    }
    case 'optional': case 'nullable': case 'default': case 'prefault': case 'readonly': case 'nonoptional': case 'catch':
      assertStrict(def.innerType as z.ZodType, path);
      return;
    case 'array':
      assertStrict(def.element as z.ZodType, `${path}[]`);
      return;
    case 'union':
      for (const [i, o] of (def.options as z.ZodType[]).entries()) assertStrict(o, `${path}|${i}`);
      return;
    case 'pipe':
      // A codec decodes while parsing: the SDK passes the decoded value on and the framework's second parse rejects it.
      if (def.transform) throw new Error(`${path} uses a codec; tool inputs must parse to the same shape they accept`);
      assertStrict(def.in as z.ZodType, path);
      assertStrict(def.out as z.ZodType, path);
      return;
    case 'tuple':
      for (const [i, item] of (def.items as z.ZodType[]).entries()) assertStrict(item, `${path}[${i}]`);
      if (def.rest) assertStrict(def.rest as z.ZodType, `${path}[...]`);
      return;
    case 'intersection':
      assertStrict(def.left as z.ZodType, path);
      assertStrict(def.right as z.ZodType, path);
      return;
    case 'record': case 'map':
      assertStrict(def.keyType as z.ZodType, `${path}{key}`);
      assertStrict(def.valueType as z.ZodType, `${path}{}`);
      return;
    case 'set':
      assertStrict(def.valueType as z.ZodType, `${path}{}`);
      return;
    case 'transform':
      // Arguments are parsed by the SDK, then again by the framework, and stored for approval: parsing must not
      // change a value's shape, or the second parse rejects the first one's output.
      throw new Error(`${path} uses a transform; tool inputs must parse to the same shape they accept`);
    default:
      // Leaves hold no objects. Anything else (lazy, promise, function, a future container) can't be checked, so it's refused.
      if (LEAF_TYPES.has(def.type)) return;
      throw new Error(`${path} uses a ${def.type} schema, which strictness can't be checked through; use plain strict objects`);
  }
}

/** tools/list converts every input schema to JSON Schema; one that can't convert would break listing for every tool. */
function assertWireSchema(schema: z.ZodType, name: string): void {
  try {
    z.toJSONSchema(schema, { io: 'input' });
  } catch (e) {
    throw new Error(`${name}.input can't be expressed as JSON Schema for tools/list: ${(e as Error).message}`);
  }
}

const LEAF_TYPES = new Set([
  // Not any, unknown or custom: they accept arbitrary objects, so unknown keys would pass through unchecked.
  'string', 'number', 'int', 'bigint', 'boolean', 'date', 'symbol', 'null', 'undefined', 'void', 'never',
  'nan', 'literal', 'enum', 'template_literal', 'file', 'success',
]);

const text = (value: unknown, isError = false): CallToolResult =>
  ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });

export type ReadToolSpec<S extends ToolInput> = {
  name: string;
  description: string;
  input: S;
  run: (tx: AppTx, args: z.output<S>) => Promise<unknown>;
};

export function defineReadTool<S extends ToolInput>(spec: ReadToolSpec<S>): DefinedTool {
  assertStrict(spec.input, `${spec.name}.input`);
  assertWireSchema(spec.input, spec.name);
  return Object.freeze({
    [toolBrand]: true as const,
    name: spec.name,
    kind: 'read' as const,
    description: spec.description,
    inputSchema: spec.input,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async call({ db, caller }: Deps, raw: unknown) {
      const startedAt = performance.now();
      const correlationId = randomUUID();
      const audit = (tx: AppTx, args: unknown, errorCode: string | null) => writeAudit(tx, {
        actor: caller.actor, role: caller.role, tool: spec.name, args, outcome: errorCode ? 'error' : 'ok', startedAt, correlationId, errorCode,
      });
      let parsed: z.ZodSafeParseResult<z.output<S>>;
      try {
        // Async, so schemas with async refinements or transforms parse instead of throwing.
        parsed = await spec.input.safeParseAsync(raw ?? {});
      } catch (e) {
        console.error(`[${correlationId}]`, e);
        await inAppTx(db, (tx) => audit(tx, raw, 'internal_error'));
        return text({ error: 'internal_error', message: 'internal error', correlationId }, true);
      }
      if (!parsed.success) {
        await inAppTx(db, (tx) => audit(tx, raw, 'invalid_args'));
        return text({ error: 'invalid_args', message: 'invalid arguments', issues: publicIssues(parsed.error.issues), correlationId }, true);
      }
      return inAppTx(db, async (tx) => {
        try {
          // A savepoint, so a failed query doesn't abort the transaction the audit row is written in.
          const data = await tx.transaction((inner) => spec.run(inner as unknown as AppTx, parsed.data));
          // Serialise first: a value JSON can't encode (bigint, cycle) must fail before the success audit is written.
          const result = text(data);
          // JSON.stringify returns undefined (no throw) for undefined, functions and symbols: not a valid text item.
          if (typeof (result.content[0] as { text?: unknown }).text !== 'string') throw new Error('tool result is not JSON-serialisable');
          await audit(tx, parsed.data, null);
          return result;
        } catch (e) {
          const known = e instanceof ToolError;
          if (!known) console.error(`[${correlationId}]`, e);
          await audit(tx, parsed.data, known ? e.code : 'internal_error');
          return text({ error: known ? e.code : 'internal_error', message: known ? e.message : 'internal error', correlationId }, true);
        }
      });
    },
  });
}

/** Path, code and message only: never echo input values, which may be sensitive. */
function publicIssues(issues: readonly { code: string; path: readonly PropertyKey[]; message: string }[]) {
  return issues.map((i) => ({ code: i.code, path: i.path.map((k) => (typeof k === 'symbol' ? String(k) : k)), message: i.message }));
}

export const IDEMPOTENCY_KEY = 'idempotency_key';

export type WriteToolSpec<S extends ToolInput> = {
  name: WriteTool;
  description: string;
  /** The tool's own arguments; the framework adds idempotency_key to the MCP input schema. */
  input: S;
  /** Human-readable summary shown to the approver and returned while pending. */
  summarize: (db: AppQueryable, args: z.output<S>) => Promise<string>;
  /** Runs after approval, inside the transaction that claims the approval. */
  execute: (tx: AppTx, args: z.output<S>, approval: Approved) => Promise<HandlerOutcome>;
  destructive?: boolean;
};


/** Total mapping from the approvals module's result to an MCP tool result. Keeps every field a caller needs. */
export function mapRequestWriteResult(r: RequestWriteResult): CallToolResult {
  switch (r.kind) {
    case 'pending':
      return text({ status: 'pending_approval', approvalId: r.approvalId, summary: r.summary });
    case 'duplicate':
      return text({ status: 'duplicate', approvalId: r.approvalId, approvalStatus: r.status, result: r.result }, r.status !== 'executed');
    case 'conflict':
      return text({ error: 'conflict', reason: 'idempotency_key_reused', approvalId: r.approvalId }, true);
    case 'denied':
      return text({ error: 'denied', reason: r.reason }, true);
    case 'invalid_args':
      // Path, code and message only: never echo input values, which may be sensitive.
      return text({ error: 'invalid_args', issues: publicIssues(r.issues) }, true);
    default:
      return assertNever(r);
  }
}

export function defineWriteTool<S extends ToolInput>(spec: WriteToolSpec<S>): DefinedTool {
  assertStrict(spec.input, `${spec.name}.input`);
  assertWireSchema(spec.input, spec.name);
  if (IDEMPOTENCY_KEY in spec.input.shape) throw new Error(`${spec.name}.input must not declare ${IDEMPOTENCY_KEY}; the framework adds it`);
  // max(200) counts characters, so it only advertises a bound in tools/list. The real limit is 200 UTF-8 bytes,
  // enforced (and audited) by requestWrite; a non-ASCII key can pass this schema and still be rejected there.
  const inputSchema = spec.input.extend({ [IDEMPOTENCY_KEY]: z.string().min(1).max(200) }).strict();
  const handler: ToolHandler = {
    schema: spec.input as unknown as z.ZodType<Record<string, unknown>>,
    summarize: (db: AppQueryable, args: Record<string, unknown>) => spec.summarize(db, args as z.output<S>),
    // approval.arguments is the schema's parsed output, stored by requestWrite; inputs have no transforms
    // (assertStrict), so that output already has the input's shape and is passed through as is.
    execute: (tx: AppTx, approval: Approved) => spec.execute(tx, approval.arguments as z.output<S>, approval),
  };
  return Object.freeze({
    [toolBrand]: true as const,
    name: spec.name,
    kind: 'write' as const,
    description: spec.description,
    inputSchema,
    approvalHandler: handler,
    annotations: { readOnlyHint: false, destructiveHint: spec.destructive ?? true, idempotentHint: true, openWorldHint: false },
    async call({ db, caller }: Deps, raw: unknown) {
      const { [IDEMPOTENCY_KEY]: key, ...args } = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      // requestWrite parses args strictly, checks the key and writes exactly one audit row in a transaction.
      const startedAt = performance.now();
      let r: RequestWriteResult;
      try {
        r = await requestWrite(db, { ...caller, tool: spec.name, args, idempotencyKey: key as string }, { [spec.name]: handler });
      } catch (e) {
        // requestWrite rolled back (e.g. summarize threw), so nothing was audited: record the failure in a fresh transaction.
        const correlationId = randomUUID();
        console.error(`[${correlationId}]`, e);
        await inAppTx(db, (tx) => writeAudit(tx, {
          actor: caller.actor, role: caller.role, tool: spec.name, args, outcome: 'error', startedAt, correlationId, errorCode: 'internal_error',
        }));
        return text({ error: 'internal_error', message: 'internal error', correlationId }, true);
      }
      return mapRequestWriteResult(r);
    },
  });
}

/** The approvals handlers for a tool list, for executeApproval: the same code the MCP request was validated by. */
export function approvalHandlers(tools: readonly DefinedTool[]): HandlerMap {
  const map: HandlerMap = {};
  for (const t of tools) if (t.kind === 'write' && t.approvalHandler) map[t.name as WriteTool] = t.approvalHandler;
  return map;
}

/** Registers tools on a server. The only registerTool call in the codebase. */
export function registerTools(server: McpServer, deps: Deps, tools: readonly DefinedTool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (tool[toolBrand] !== true) throw new Error('tools must be built with defineReadTool or defineWriteTool');
    if (seen.has(tool.name)) throw new Error(`duplicate tool name ${tool.name}`);
    seen.add(tool.name);
    server.registerTool(tool.name, {
      description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations,
    }, async (raw: unknown, ctx: ServerContext) => {
      // The handler audits from here on; the transport hook only audits calls the SDK rejected first.
      deps.tracker.markHandled(ctx.mcpReq.id);
      return tool.call(deps, raw);
    });
  }
}
