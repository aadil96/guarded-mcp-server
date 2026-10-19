import { type SQL, sql } from 'drizzle-orm';
import * as z from 'zod';
import { toJsonb } from '../audit/log.js';
import { queryRows } from '../db/index.js';
import type { AppQueryable, AppTx } from '../db/types.js';
import { type ApprovalId, zApprovalId } from '../domain/brands.js';
import type { Approval, ApprovalStatus, Approved, Denied, Executed, Failed, Pending } from './types.js';

/**
 * The single source for allowed moves: pending -> approved|denied, approved -> executed|failed.
 * It mirrors the approvals_guard trigger (drizzle/0001_guards.sql); a test checks every pair against it.
 */
export const TRANSITIONS = {
  pending: ['approved', 'denied'],
  approved: ['executed', 'failed'],
  denied: [],
  executed: [],
  failed: [],
} as const satisfies Record<ApprovalStatus, readonly ApprovalStatus[]>;

export function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}

// The DB row boundary: every approvals row is parsed into exactly one state, or the read throws.
const fields = {
  id: zApprovalId,
  tool: z.enum(['issue_refund', 'update_order_status', 'create_credit_note', 'add_customer_note']),
  idempotency_key: z.string(),
  args_hash: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  summary: z.string(),
  requested_by: z.string(),
};
const rowSchema = z.discriminatedUnion('status', [
  z.object({ ...fields, status: z.literal('pending'), resolved_by: z.null(), result: z.null() }),
  z.object({ ...fields, status: z.literal('approved'), resolved_by: z.string(), result: z.null() }),
  z.object({ ...fields, status: z.literal('denied'), resolved_by: z.string(), result: z.null() }),
  z.object({ ...fields, status: z.literal('executed'), resolved_by: z.string(), result: z.unknown() }),
  z.object({ ...fields, status: z.literal('failed'), resolved_by: z.string(), result: z.unknown() }),
]);

export function toApproval(row: unknown): Approval {
  const r = rowSchema.safeParse(row);
  if (!r.success) throw new Error(`approvals row does not match any state: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  // `result: unknown` parses to an optional key; the row always has the column, so default it to null.
  return { ...r.data, result: r.data.result ?? null } as Approval;
}

export async function approvalRows(db: AppQueryable, q: SQL): Promise<Approval[]> {
  return (await queryRows<unknown>(db, q)).map(toApproval);
}

export const getApproval = async (db: AppQueryable, id: ApprovalId): Promise<Approval | undefined> =>
  (await approvalRows(db, sql`select * from approvals where id = ${id}`))[0];

/** Row lock: concurrent resolvers and executors of one approval serialize here and see each other's result. */
export const lockApproval = async (tx: AppTx, id: ApprovalId): Promise<Approval | undefined> =>
  (await approvalRows(tx, sql`select * from approvals where id = ${id} for update`))[0];

function expectState<S extends ApprovalStatus>(a: Approval | undefined, ...states: S[]): Extract<Approval, { status: S }> {
  if (!a || !(states as ApprovalStatus[]).includes(a.status)) throw new Error(`approval transition lost: expected ${states.join('|')}, got ${a?.status ?? 'no row'}`);
  return a as Extract<Approval, { status: S }>;
}

/**
 * pending -> approved | denied. Writes only status, resolved_by and resolved_at (the column grant).
 * The caller holds the row lock (lockApproval), so the guarded update always matches.
 */
export async function resolvePending(tx: AppTx, p: Pending, decision: 'approve' | 'deny', by: string): Promise<Approved | Denied> {
  const status = decision === 'approve' ? 'approved' : 'denied';
  const [row] = await approvalRows(tx, sql`
    update approvals set status = ${status}, resolved_by = ${by}, resolved_at = now()
    where id = ${p.id} and status = 'pending' returning *`);
  return expectState(row, status);
}

/** approved -> executed | failed. Writes only status, result and executed_at (the column grant). */
export async function finishApproved(
  tx: AppTx, a: Approved, outcome: { ok: true; result: unknown } | { ok: false; error: string },
): Promise<Executed | Failed> {
  const status = outcome.ok ? 'executed' : 'failed';
  const result = outcome.ok ? outcome.result : { error: outcome.error };
  const [row] = await approvalRows(tx, sql`
    update approvals set status = ${status}, result = ${toJsonb(result)}::jsonb, executed_at = now()
    where id = ${a.id} and status = 'approved' returning *`);
  return expectState(row, status);
}
