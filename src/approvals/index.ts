import { randomUUID } from 'node:crypto';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { argsHash } from '../db/args-hash.js';
import { inAppTx, queryRows } from '../db/index.js';
import { type ApprovalsConfig, defaultApprovalsConfig } from './config.js';
import { jsonbSafeString, jsonSafe, LONE_SURROGATE, toJsonb, writeAudit } from '../audit/log.js';
import { issueRefund } from './refund.js';
import type {
  Approval, Role, ExecuteResult, HandlerMap, RequestWriteResult, ResolveResult, WriteTool,
} from './types.js';
import type { Caller } from '../audit/log.js';
import type { AppDb, AppQueryable } from '../db/types.js';
import { type ApprovalId, zApprovalId } from '../domain/brands.js';

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

/** The DB row boundary for approvals: every row read goes through here, so its id is branded by zApprovalId. */
async function approvalRows(db: AppQueryable, q: SQL): Promise<Approval[]> {
  return (await queryRows<Omit<Approval, 'id'> & { id: string }>(db, q)).map((r) => ({ ...r, id: zApprovalId.parse(r.id) }));
}

const getApproval = async (db: AppQueryable, id: ApprovalId) =>
  (await approvalRows(db, sql`select * from approvals where id = ${id}`))[0];

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
    await inAppTx(db, (tx) => writeAudit(tx, { ...base, outcome: 'error', errorCode: 'invalid_args' }));
    return { kind: 'invalid_args', issues: [callerIssue] };
  }
  const handler = lookupHandler(handlers, input.tool);
  if (caller.role === 'reader' || !handler) {
    const reason = !handler ? 'tool_not_supported' : 'role_not_permitted';
    await inAppTx(db, (tx) => writeAudit(tx, { ...base, outcome: 'denied', errorCode: reason }));
    return { kind: 'denied', reason };
  }
  // Runtime callers can bypass the TS type; reject a missing/blank key before it reaches the approvals query.
  const key: unknown = input.idempotencyKey;
  // Bounded so it always fits the (tool, idempotency_key) unique index.
  if (typeof key !== 'string' || key.trim().length === 0 || !isPgExact(key) || Buffer.byteLength(key, 'utf8') > MAX_IDEMPOTENCY_KEY_BYTES) {
    await inAppTx(db, (tx) => writeAudit(tx, { ...base, idempotencyKey: null, outcome: 'error', errorCode: 'invalid_args' }));
    return { kind: 'invalid_args', issues: [{ code: 'custom', path: ['idempotencyKey'], message: `idempotency key must be a non-empty string of at most ${MAX_IDEMPOTENCY_KEY_BYTES} UTF-8 bytes` } as z.core.$ZodIssue] };
  }
  // Async, so schemas with async refinements or transforms parse instead of throwing.
  const parsed = await handler.schema.safeParseAsync(input.args);
  if (!parsed.success) {
    await inAppTx(db, (tx) => writeAudit(tx, { ...base, outcome: 'error', errorCode: 'invalid_args' }));
    return { kind: 'invalid_args', issues: parsed.error.issues };
  }
  const args = parsed.data;
  const hash = argsHash(args);

  const classify = async (row: Approval): Promise<RequestWriteResult> => {
    if (row.args_hash !== hash) {
      await inAppTx(db, (tx) => writeAudit(tx, { ...base, outcome: 'conflict', approvalId: row.id, errorCode: 'idempotency_key_reused' }));
      return { kind: 'conflict', approvalId: row.id };
    }
    if (row.status === 'pending' || row.status === 'approved') {
      await inAppTx(db, (tx) => writeAudit(tx, { ...base, outcome: 'pending_approval', approvalId: row.id }));
      return { kind: 'pending', approvalId: row.id, summary: row.summary, approval: row };
    }
    if (row.status === 'denied') {
      await inAppTx(db, (tx) => writeAudit(tx, { ...base, outcome: 'denied', approvalId: row.id, errorCode: 'previously_denied' }));
      return { kind: 'denied', reason: 'previously_denied' };
    }
    await inAppTx(db, (tx) => writeAudit(tx, { ...base, outcome: 'duplicate', approvalId: row.id }));
    return { kind: 'duplicate', approvalId: row.id, status: row.status, result: row.result };
  };

  const find = async () => (await approvalRows(db,
    sql`select * from approvals where tool = ${input.tool} and idempotency_key = ${input.idempotencyKey}`))[0];

  const existing = await find();
  if (existing) return classify(existing);

  const summary = await handler.summarize(db, args);
  // Insert and its audit row commit together; an audit failure rolls the approval back.
  const created = await inAppTx(db, async (tx) => {
    const [row] = await approvalRows(tx, sql`
      insert into approvals (id, tool, idempotency_key, args_hash, arguments, summary, requested_by)
      values (${randomUUID()}, ${input.tool}, ${input.idempotencyKey}, ${hash}, ${JSON.stringify(args)}::jsonb, ${summary}, ${caller.actor})
      on conflict (tool, idempotency_key) do nothing returning *`);
    if (row) await writeAudit(tx, { ...base, outcome: 'pending_approval', approvalId: row.id });
    return row;
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
export type ResolveInput = Caller & { approvalId: ApprovalId; decision: 'approve' | 'deny' };

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
    await inAppTx(db, (tx) => writeAudit(tx, { ...base, outcome: 'error', errorCode: 'invalid_args' }));
    return { kind: 'invalid_args' };
  }
  const row = await getApproval(db, input.approvalId);
  if (!row) {
    await inAppTx(db, (tx) => writeAudit(tx, { ...base, outcome: 'error', errorCode: 'not_found' }));
    return { kind: 'not_found' };
  }
  base.approvalId = row.id;
  let reason: string | null = null;
  if (caller.role !== 'admin') reason = 'admin_required';
  else if (row.requested_by === caller.actor && !config.singleOperator) reason = 'self_approval_forbidden';
  if (reason) {
    await inAppTx(db, (tx) => writeAudit(tx, { ...base, outcome: 'denied', errorCode: reason }));
    return { kind: 'denied', reason };
  }
  const status = input.decision === 'approve' ? 'approved' : 'denied';
  // Status change and its audit row commit in one transaction.
  return inAppTx(db, async (tx): Promise<ResolveResult> => {
    const [updated] = await approvalRows(tx, sql`
      update approvals set status = ${status}, resolved_by = ${caller.actor}, resolved_at = now()
      where id = ${row.id} and status = 'pending' returning *`);
    if (!updated) {
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
  approvalId: ApprovalId,
  rawCaller: Caller,
  handlers: HandlerMap = defaultHandlers,
): Promise<ExecuteResult> {
  const startedAt = performance.now();
  const caller = checkCaller(rawCaller);
  const correlationId = caller.correlationId;
  if (!caller.ok) {
    await inAppTx(db, (tx) => writeAudit(tx, { actor: caller.actor, role: caller.role, tool: 'execute_approval', args: { approvalId: typeof approvalId === 'string' ? approvalId : null }, outcome: 'error', startedAt, correlationId, errorCode: 'invalid_args' }));
    return { kind: 'invalid_args' };
  }
  if (caller.role === 'reader') {
    await inAppTx(db, (tx) => writeAudit(tx, { actor: caller.actor, role: caller.role, tool: 'execute_approval', args: { approvalId }, outcome: 'denied', startedAt, correlationId, errorCode: 'role_not_permitted' }));
    return { kind: 'denied', reason: 'role_not_permitted' };
  }
  if (!isUuid(approvalId)) {
    await inAppTx(db, (tx) => writeAudit(tx, { actor: caller.actor, role: caller.role, tool: 'execute_approval', args: { approvalId }, outcome: 'error', startedAt, correlationId, errorCode: 'invalid_args' }));
    return { kind: 'invalid_args' };
  }
  return inAppTx(db, async (tx): Promise<ExecuteResult> => {
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
    const [locked] = await approvalRows(tx,
      sql`select * from approvals where id = ${approvalId} and status = 'approved' for update`);
    if (!locked) {
      const cur = await getApproval(tx, approvalId);
      if (!cur) return finish({ kind: 'not_found' });
      if (cur.status === 'executed' || cur.status === 'failed') return finish({ kind: 'duplicate', approvalId, status: cur.status, result: cur.result }, cur);
      return finish({ kind: 'not_approved', status: cur.status }, cur);
    }
    const handler = lookupHandler(handlers, locked.tool);
    await tx.execute(sql`savepoint exec_tool`);
    let outcome: Awaited<ReturnType<NonNullable<typeof handler>['execute']>>;
    try {
      outcome = handler ? await handler.execute(tx, locked) : { ok: false, error: 'tool_not_supported' };
    } catch (e) {
      // Drizzle wraps driver errors as "Failed query: <sql> params: <values>"; keep only the driver's message so
      // statement parameters never land in approvals.result or the audit row.
      const root = e instanceof Error && e.cause instanceof Error ? e.cause : e;
      outcome = { ok: false, error: root instanceof Error ? root.message.slice(0, 200) : 'executor_error' };
    }
    if (!outcome.ok) await tx.execute(sql`rollback to savepoint exec_tool`);
    // Handler output is untrusted shape: make it jsonb-safe (bigint, cycles, NUL, lone surrogates) so the
    // status claim and its audit row always commit instead of rolling back and leaving it 'approved'.
    const error = outcome.ok ? '' : jsonbSafeString(typeof outcome.error === 'string' ? outcome.error : String(outcome.error)).slice(0, 200);
    const result = outcome.ok ? jsonSafe(outcome.result) : { error };
    const [claimed] = await approvalRows(tx, sql`
      update approvals set status = ${outcome.ok ? 'executed' : 'failed'}, result = ${toJsonb(result)}::jsonb, executed_at = now()
      where id = ${approvalId} and status = 'approved' returning *`);
    if (!claimed) throw new Error('approval claim lost despite row lock');
    return outcome.ok
      ? finish({ kind: 'executed', approvalId, result }, claimed)
      : finish({ kind: 'failed', approvalId, error }, claimed);
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
