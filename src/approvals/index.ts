import { randomUUID } from 'node:crypto';
import { argsHash } from '../db/args-hash.js';
import { writeAudit } from './audit.js';
import { issueRefund } from './refund.js';
import type {
  Approval, Caller, Db, ExecuteResult, HandlerMap, RequestWriteResult, ResolveResult, Sql, WriteTool,
} from './types.js';

export * from './types.js';
export { formatInr } from './refund.js';

export const defaultHandlers: HandlerMap = { issue_refund: issueRefund };

const getApproval = async (sql: Sql, id: string) =>
  (await sql.query<Approval>('select * from approvals where id = $1', [id])).rows[0];

export async function requestWrite(
  db: Db,
  input: Caller & { tool: WriteTool; args: Record<string, unknown>; idempotencyKey: string },
  handlers: HandlerMap = defaultHandlers,
): Promise<RequestWriteResult> {
  const startedAt = performance.now();
  const correlationId = input.correlationId ?? randomUUID();
  const base = { actor: input.actor, role: input.role, tool: input.tool, args: input.args, idempotencyKey: input.idempotencyKey, startedAt, correlationId };
  const handler = handlers[input.tool];
  if (input.role === 'reader' || !handler) {
    const reason = !handler ? 'tool_not_supported' : 'role_not_permitted';
    await writeAudit(db, { ...base, outcome: 'denied', errorCode: reason });
    return { kind: 'denied', reason };
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

  const find = async () => (await db.query<Approval>(
    'select * from approvals where tool = $1 and idempotency_key = $2', [input.tool, input.idempotencyKey])).rows[0];

  const existing = await find();
  if (existing) return classify(existing);

  const summary = await handler.summarize(db, args);
  const inserted = await db.query<Approval>(
    `insert into approvals (id, tool, idempotency_key, args_hash, arguments, summary, requested_by)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (tool, idempotency_key) do nothing returning *`,
    [randomUUID(), input.tool, input.idempotencyKey, hash, JSON.stringify(args), summary, input.actor],
  );
  if (inserted.rows[0]) {
    await writeAudit(db, { ...base, outcome: 'pending_approval', approvalId: inserted.rows[0].id });
    return { kind: 'pending', approvalId: inserted.rows[0].id, summary, approval: inserted.rows[0] };
  }
  // Lost a concurrent insert race: classify against the winner.
  return classify(await find() as Approval);
}

export async function resolveApproval(
  db: Db,
  input: Caller & { approvalId: string; decision: 'approve' | 'deny'; singleOperator?: boolean },
): Promise<ResolveResult> {
  const startedAt = performance.now();
  const correlationId = input.correlationId ?? randomUUID();
  const base = { actor: input.actor, role: input.role, tool: 'resolve_approval', args: { approvalId: input.approvalId, decision: input.decision }, approvalId: null as string | null, startedAt, correlationId };
  const row = await getApproval(db, input.approvalId);
  if (!row) {
    await writeAudit(db, { ...base, outcome: 'error', errorCode: 'not_found' });
    return { kind: 'not_found' };
  }
  base.approvalId = row.id;
  let reason: string | null = null;
  if (input.role !== 'admin') reason = 'admin_required';
  else if (row.requested_by === input.actor && !input.singleOperator) reason = 'self_approval_forbidden';
  if (reason) {
    await writeAudit(db, { ...base, outcome: 'denied', errorCode: reason });
    return { kind: 'denied', reason };
  }
  const status = input.decision === 'approve' ? 'approved' : 'denied';
  const upd = await db.query<Approval>(
    `update approvals set status = $2, resolved_by = $3, resolved_at = now() where id = $1 and status = 'pending' returning *`,
    [row.id, status, input.actor],
  );
  if (!upd.rows[0]) {
    const cur = await getApproval(db, row.id) as Approval;
    await writeAudit(db, { ...base, outcome: 'error', errorCode: 'not_pending' });
    return { kind: 'invalid_state', status: cur.status };
  }
  await writeAudit(db, { ...base, outcome: 'ok' });
  return { kind: 'resolved', approvalId: row.id, status };
}

export async function executeApproval(
  db: Db,
  approvalId: string,
  caller: Caller,
  handlers: HandlerMap = defaultHandlers,
): Promise<ExecuteResult> {
  const startedAt = performance.now();
  const correlationId = caller.correlationId ?? randomUUID();
  if (caller.role === 'reader') {
    await writeAudit(db, { actor: caller.actor, role: caller.role, tool: 'execute_approval', args: { approvalId }, outcome: 'denied', startedAt, correlationId, errorCode: 'role_not_permitted' });
    return { kind: 'denied', reason: 'role_not_permitted' };
  }
  return db.transaction(async (tx): Promise<ExecuteResult> => {
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
    const locked = (await tx.query<Approval>(`select * from approvals where id = $1 and status = 'approved' for update`, [approvalId])).rows[0];
    if (!locked) {
      const cur = await getApproval(tx, approvalId);
      if (!cur) return finish({ kind: 'not_found' });
      if (cur.status === 'executed' || cur.status === 'failed') return finish({ kind: 'duplicate', approvalId, status: cur.status, result: cur.result }, cur);
      return finish({ kind: 'not_approved', status: cur.status }, cur);
    }
    const handler = handlers[locked.tool];
    await tx.query('savepoint exec_tool');
    let outcome: Awaited<ReturnType<NonNullable<typeof handler>['execute']>>;
    try {
      outcome = handler ? await handler.execute(tx, locked) : { ok: false, error: 'tool_not_supported' };
    } catch (e) {
      outcome = { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : 'executor_error' };
    }
    if (!outcome.ok) await tx.query('rollback to savepoint exec_tool');
    const result = outcome.ok ? outcome.result : { error: outcome.error };
    const claimed = await tx.query<Approval>(
      `update approvals set status = $2, result = $3, executed_at = now() where id = $1 and status = 'approved' returning *`,
      [approvalId, outcome.ok ? 'executed' : 'failed', JSON.stringify(result)],
    );
    if (!claimed.rows[0]) throw new Error('approval claim lost despite row lock');
    return outcome.ok
      ? finish({ kind: 'executed', approvalId, result }, claimed.rows[0])
      : finish({ kind: 'failed', approvalId, error: outcome.error }, claimed.rows[0]);
  });
}
