import type { AppQueryable, AppTx } from '../db/types.js';
import type { z } from 'zod';
import type { ApprovalId } from '../domain/brands.js';

export type WriteTool = 'issue_refund' | 'update_order_status' | 'create_credit_note' | 'add_customer_note';
export type { AuditOutcome, AuditRole, Role } from '../audit/log.js';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'executed' | 'failed';

export type Approval = {
  id: ApprovalId;
  tool: WriteTool;
  idempotency_key: string;
  args_hash: string;
  arguments: Record<string, unknown>;
  summary: string;
  status: ApprovalStatus;
  requested_by: string;
  resolved_by: string | null;
  result: unknown;
};

export type RequestWriteResult =
  | { kind: 'pending'; approvalId: ApprovalId; summary: string; approval: Approval }
  | { kind: 'duplicate'; approvalId: ApprovalId; status: ApprovalStatus; result: unknown }
  | { kind: 'conflict'; approvalId: ApprovalId }
  | { kind: 'denied'; reason: string }
  | { kind: 'invalid_args'; issues: z.core.$ZodIssue[] };

export type ResolveResult =
  | { kind: 'resolved'; approvalId: ApprovalId; status: 'approved' | 'denied' }
  | { kind: 'denied'; reason: string }
  | { kind: 'not_found' }
  | { kind: 'invalid_state'; status: ApprovalStatus }
  | { kind: 'invalid_args' };

export type ExecuteResult =
  | { kind: 'executed'; approvalId: ApprovalId; result: unknown }
  | { kind: 'failed'; approvalId: ApprovalId; error: string }
  | { kind: 'duplicate'; approvalId: ApprovalId; status: ApprovalStatus; result: unknown }
  | { kind: 'not_approved'; status: ApprovalStatus }
  | { kind: 'denied'; reason: string }
  | { kind: 'not_found' }
  | { kind: 'invalid_args' };

export type HandlerOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

/** One entry per write tool. execute runs inside the claiming transaction. */
export type ToolHandler = {
  /** Validated before hashing; the parsed output is what gets hashed and stored. */
  schema: z.ZodType<Record<string, unknown>>;
  summarize(db: AppQueryable, args: Record<string, unknown>): Promise<string>;
  execute(tx: AppTx, approval: Approval): Promise<HandlerOutcome>;
};
export type HandlerMap = Partial<Record<WriteTool, ToolHandler>>;
