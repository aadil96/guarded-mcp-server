import { randomUUID } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { z } from 'zod';
import { argsHash } from '../db/args-hash.js';
import * as s from '../db/schema.js';
import { type ApprovalsConfig, defaultApprovalsConfig } from './config.js';
import { jsonbSafeString, jsonSafe, LONE_SURROGATE, toJsonb, writeAudit } from './audit.js';
import { issueRefund } from './refund.js';
import type {
  Approval, Caller, Role, ExecuteResult, HandlerMap, RequestWriteResult, ResolveResult, WriteTool,
} from './types.js';
import type { AppDb, AppTx } from '../db/types.js';

export * from './types.js';
export { type ApprovalsConfig, defaultApprovalsConfig, loadApprovalsConfig } from './config.js';
export { formatInr } from './refund.js';

export const defaultHandlers: HandlerMap = { issue_refund: issueRefund };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Reject malformed ids before they reach Postgres (which would throw 22P02 and skip the audit row). */
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export const MAX_IDEMPOTENCY_KEY_BYTES = 200;

/** Caller metadata is validated on its own so a bad actor/role/correlationId can never break the audit insert. */
/** Text Postgres stores exactly as given: no U+0000 and no unpaired surrogates (Node would send U+FFFD, so identities and keys would alias). */
const isPgExact = (v: string) => !v.includes('\u0000') && !new RegExp(LONE_SURROGATE.source).test(v);

const callerSchema = z.object({
  // Postgres text/jsonb cannot hold U+0000; a NUL here would make the audit insert itself throw.
  actor: z.string().trim().min(1).max(200).refine(isPgExact),
  role: z.enum(['reader', 'operator', 'admin']),
  correlationId: z.string().min(1).max(200).refine(isPgExact).optional(),
});
type CallerCheck =
  | { ok: true; actor: string; role: Role; correlationId: string }
  | { ok: false; actor: 'unknown'; role: 'invalid'; correlationId: string };
function checkCaller(input: unknown): CallerCheck {
  const c = callerSchema.safeParse(input && typeof input === 'object'
    ? { actor: (input as Caller).actor, role: (input as Caller).role, correlationId: (input as Caller).correlationId }
    : {});
  return c.success
    ? { ok: true, actor: c.data.actor, role: c.data.role, correlationId: c.data.correlationId ?? randomUUID() }
    : { ok: false, actor: 'unknown', role: 'invalid', correlationId: randomUUID() };
}
const callerIssue = { code: 'custom', path: ['caller'], message: 'invalid caller metadata (actor, role or correlationId)' } as z.core.$ZodIssue;

/** Own-property lookup only: names like 'toString' or '__proto__' must not resolve to Object.prototype members. */
const lookupHandler = (handlers: HandlerMap, tool: unknown) =>
  typeof tool === 'string' && Object.hasOwn(handlers, tool) ? handlers[tool as WriteTool] : undefined;

const getApproval = async (db: AppDb | AppTx, id: string) => {
  const r = await (db as AppDb).execute(sql`select * from approvals where id = ${id}`);
  return (r as unknown as { rows: Approval[] }).rows[0];
};

export async function requestWrite(
  db: AppDb,
  input: Caller & { tool: WriteTool; args: Record<string, unknown>; idempotencyKey: string },
  handlers: HandlerMap = defaultHandlers,
): Promise<RequestWriteResult> {
  const startedAt = performance.now();
  const caller = checkCaller(input);
  const correlationId = caller.correlationId;
  // Whole-request guard: null/undefined/non-object requests reach the audited invalid-caller branch.
  const req = (input && typeof input === 'object' ? input : {}) as Partial<typeof input>;
  const rawKey: unknown = req.idempotencyKey;
  const auditKey = typeof rawKey === 'string' && isPgExact(rawKey) && Buffer.byteLength(rawKey, 'utf8') <= MAX_IDEMPOTENCY_KEY_BYTES ? rawKey : null;
  const base = { actor: caller.actor, role: caller.role, tool: typeof req.tool === 'string' ? req.tool.slice(0, 200).replaceAll('\u0000', '\uFFFD') : '[invalid]', args: req.args ?? null, idempotencyKey: auditKey, startedAt, correlationId };
  if (!caller.ok) {
    await db.transaction((tx) => writeAudit(tx, { ...base, outcome: 'error', errorCode: 'invalid_args' }));
    return { kind: 'invalid_args', issues: [callerIssue] };
  }
  const handler = lookupHandler(handlers, input.tool);
  if (caller.role === 'reader' || !handler) {
    const reason = !handler ? 'tool_not_supported' : 'role_not_permitted';
    await writeAudit(db, { ...base, outcome: 'denied', errorCode: reason });
    return { kind: 'denied', reason };
  }
  // Runtime callers can bypass the TS type; reject a missing/blank key before it reaches the approvals query.
  const key: unknown = input.idempotencyKey;
  // Bounded so it always fits the (tool, idempotency_key) unique index.
  if (typeof key !== 'string' || key.trim().length === 0 || !isPgExact(key) || Buffer.byteLength(key, 'utf8') > MAX_IDEMPOTENCY_KEY_BYTES) {
    await db.transaction((tx) => writeAudit(tx, { ...base, idempotencyKey: null, outcome: 'error', errorCode: 'invalid_args' }));
    return { kind: 'invalid_args', issues: [{ code: 'custom', path: ['idempotencyKey'], message: `idempotency key must be a non-empty string of at most ${MAX_IDEMPOTENCY_KEY_BYTES} UTF-8 bytes` } as z.core.$ZodIssue] };
  }
  const parsed = handler.schema.safeParse(input.args);
  if (!parsed.success) {
    await writeAudit(db, { ...base, outcome: 'error', errorCode: 'invalid_args' });
    return { kind: 'invalid_args', issues: parsed.error.issues };
  }
  const args = parsed.data;
  const hash = argsHash(args);

  const classify = async (row: Approval): Promise<RequestWriteResult> => {
    if (row.args_hash !== hash) {
      await writeAudit(db, { ...base, outcome: 'conflict', approvalId: row.id, errorCode: 'idempotency_key_reused' });
      return { kind: 'conflict', approvalId: row.id };
    }
    if (row.status === 'pending' || row.status === 'approved') {
      await writeAudit(db, { ...base, outcome: 'pending_approval', approvalId: row.id });
      return { kind: 'pending', approvalId: row.id, summary: row.summary, approval: row };
    }
    if (row.status === 'denied') {
      await writeAudit(db, { ...base, outcome: 'denied', approvalId: row.id, errorCode: 'previously_denied' });
      return { kind: 'denied', reason: 'previously_denied' };
    }
    await writeAudit(db, { ...base, outcome: 'duplicate', approvalId: row.id });
    return { kind: 'duplicate', approvalId: row.id, status: row.status, result: row.result };
  };

  const find = async () => {
    const r = await db.execute(sql`
      select * from approvals where tool = ${input.tool} and idempotency_key = ${input.idempotencyKey}
    `);
    return (r as unknown as { rows: Approval[] }).rows[0];
  };

  const existing = await find();
  if (existing) return classify(existing);

  const summary = await handler.summarize(db, args);
  // Insert and its audit row commit together; an audit failure rolls the approval back.
  const created = await db.transaction(async (_tx) => {
    const tx = _tx as AppTx;
    const inserted = await (tx as AppDb).execute(sql`
      insert into approvals (id, tool, idempotency_key, args_hash, arguments, summary, requested_by)
      values (${randomUUID()}, ${input.tool}, ${input.idempotencyKey}, ${hash}, ${JSON.stringify(args)}, ${summary}, ${caller.actor})
      on conflict (tool, idempotency_key) do nothing returning *
    `) as unknown as { rows: Approval[] };
    if (inserted.rows[0]) await writeAudit(tx, { ...base, outcome: 'pending_approval', approvalId: inserted.rows[0].id });
    return inserted.rows[0];
  });
  if (created) return { kind: 'pending', approvalId: created.id, summary, approval: created };
  // Lost a concurrent insert race: classify against the winner.
  return classify(await find() as Approval);
}

/** Strict: unknown keys (e.g. a smuggled singleOperator) are invalid_args, not ignored. */
const resolveInputSchema = z.strictObject({
  actor: z.string().min(1),
  role: z.enum(['reader', 'operator', 'admin']),
  correlationId: z.string().optional(),
  approvalId: z.string().refine(isUuid),
  decision: z.enum(['approve', 'deny']),
});
export type ResolveInput = Caller & { approvalId: string; decision: 'approve' | 'deny' };

/** Default export path: self-approval forbidden. Servers bind their startup config with createApprovals. */
export function resolveApproval(db: AppDb, input: ResolveInput): Promise<ResolveResult> {
  return resolveApprovalWith(defaultApprovalsConfig, db, input);
}

async function resolveApprovalWith(config: ApprovalsConfig, db: AppDb, input: ResolveInput): Promise<ResolveResult> {
  const startedAt = performance.now();
  const caller = checkCaller(input);
  const correlationId = caller.correlationId;
  const base = { actor: caller.actor, role: caller.role, tool: 'resolve_approval', args: { approvalId: input?.approvalId ?? null, decision: input?.decision ?? null }, approvalId: null as string | null, startedAt, correlationId };
  if (!caller.ok || !resolveInputSchema.safeParse(input).success) {
    await writeAudit(db, { ...base, outcome: 'error', errorCode: 'invalid_args' });
    return { kind: 'invalid_args' };
  }
  const row = await getApproval(db, input.approvalId);
  if (!row) {
    await writeAudit(db, { ...base, outcome: 'error', errorCode: 'not_found' });
    return { kind: 'not_found' };
  }
  base.approvalId = row.id;
  let reason: string | null = null;
  if (caller.role !== 'admin') reason = 'admin_required';
  else if (row.requested_by === caller.actor && !config.singleOperator) reason = 'self_approval_forbidden';
  if (reason) {
    await writeAudit(db, { ...base, outcome: 'denied', errorCode: reason });
    return { kind: 'denied', reason };
  }
  const status = input.decision === 'approve' ? 'approved' : 'denied';
  // Status change and its audit row commit in one transaction.
  return db.transaction(async (_tx): Promise<ResolveResult> => {
    const tx = _tx as AppTx;
    const upd = await (tx as AppDb).execute(sql`
      update approvals set status = ${status}, resolved_by = ${caller.actor}, resolved_at = now()
      where id = ${row.id} and status = 'pending' returning *
    `) as unknown as { rows: Approval[] };
    if (!upd.rows[0]) {
      const cur = await getApproval(tx, row.id) as Approval;
      await writeAudit(tx, { ...base, outcome: 'error', errorCode: 'not_pending' });
      return { kind: 'invalid_state', status: cur.status };
    }
    await writeAudit(tx, { ...base, outcome: 'ok' });
    return { kind: 'resolved', approvalId: row.id, status };
  });
}

export async function executeApproval(
  db: AppDb,
  approvalId: string,
  rawCaller: Caller,
  handlers: HandlerMap = defaultHandlers,
): Promise<ExecuteResult> {
  const startedAt = performance.now();
  const caller = checkCaller(rawCaller);
  const correlationId = caller.correlationId;
  if (!caller.ok) {
    await writeAudit(db, { actor: caller.actor, role: caller.role, tool: 'execute_approval', args: { approvalId: typeof approvalId === 'string' ? approvalId : null }, outcome: 'error', startedAt, correlationId, errorCode: 'invalid_args' });
    return { kind: 'invalid_args' };
  }
  if (caller.role === 'reader') {
    await writeAudit(db, { actor: caller.actor, role: caller.role, tool: 'execute_approval', args: { approvalId }, outcome: 'denied', startedAt, correlationId, errorCode: 'role_not_permitted' });
    return { kind: 'denied', reason: 'role_not_permitted' };
  }
  if (!isUuid(approvalId)) {
    await writeAudit(db, { actor: caller.actor, role: caller.role, tool: 'execute_approval', args: { approvalId }, outcome: 'error', startedAt, correlationId, errorCode: 'invalid_args' });
    return { kind: 'invalid_args' };
  }
  return db.transaction(async (_tx): Promise<ExecuteResult> => {
    const tx = _tx as AppTx;
    // Audit is written through tx so the business write and its audit row commit or roll back together.
    const finish = async (r: ExecuteResult, row?: Approval): Promise<ExecuteResult> => {
      const outcome = r.kind === 'executed' ? 'ok' : r.kind === 'duplicate' ? 'duplicate' : 'error';
      const errorCode = r.kind === 'failed' ? r.error : r.kind === 'not_approved' ? `status_${r.status}` : r.kind === 'not_found' ? 'not_found' : null;
      await writeAudit(tx, {
        actor: caller.actor, role: caller.role, tool: row?.tool ?? 'execute_approval', args: row?.arguments ?? { approvalId },
        outcome, approvalId: row ? approvalId : null, idempotencyKey: row?.idempotency_key ?? null, startedAt, correlationId, errorCode,
      });
      return r;
    };
    // Row lock serializes concurrent executors; the loser sees a non-approved status afterwards.
    const lockedRes = await (tx as AppDb).execute(sql`
      select * from approvals where id = ${approvalId} and status = 'approved' for update
    `) as unknown as { rows: Approval[] };
    const locked = lockedRes.rows[0];
    if (!locked) {
      const cur = await getApproval(tx, approvalId);
      if (!cur) return finish({ kind: 'not_found' });
      if (cur.status === 'executed' || cur.status === 'failed') return finish({ kind: 'duplicate', approvalId, status: cur.status, result: cur.result }, cur);
      return finish({ kind: 'not_approved', status: cur.status }, cur);
    }
    const handler = lookupHandler(handlers, locked.tool);
    await (tx as AppDb).execute(sql`savepoint exec_tool`);
    let outcome: Awaited<ReturnType<NonNullable<typeof handler>['execute']>>;
    try {
      outcome = handler ? await handler.execute(tx, locked) : { ok: false, error: 'tool_not_supported' };
    } catch (e) {
      outcome = { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : 'executor_error' };
    }
    if (!outcome.ok) await (tx as AppDb).execute(sql`rollback to savepoint exec_tool`);
    // Handler output is untrusted shape: make it jsonb-safe (bigint, cycles, NUL, lone surrogates) so the
    // status claim and its audit row always commit instead of rolling back and leaving it 'approved'.
    const error = outcome.ok ? '' : jsonbSafeString(typeof outcome.error === 'string' ? outcome.error : String(outcome.error)).slice(0, 200);
    const result = outcome.ok ? jsonSafe(outcome.result) : { error };
    const claimed = await (tx as AppDb).execute(sql`
      update approvals set status = ${outcome.ok ? 'executed' : 'failed'}, result = ${toJsonb(result)}::jsonb, executed_at = now()
      where id = ${approvalId} and status = 'approved' returning *
    `) as unknown as { rows: Approval[] };
    if (!claimed.rows[0]) throw new Error('approval claim lost despite row lock');
    return outcome.ok
      ? finish({ kind: 'executed', approvalId, result }, claimed.rows[0])
      : finish({ kind: 'failed', approvalId, error }, claimed.rows[0]);
  });
}

/** Bind approvals to server config read once at startup (see loadApprovalsConfig). */
export function createApprovals(config: ApprovalsConfig = defaultApprovalsConfig) {
  const cfg = Object.freeze({ ...config });
  return Object.freeze({
    config: cfg,
    requestWrite,
    executeApproval,
    resolveApproval: (db: AppDb, input: ResolveInput) => resolveApprovalWith(cfg, db, input),
  });
}
