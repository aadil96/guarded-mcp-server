import type { Approval } from './types.js';

type ApprovalCore = Omit<Approval, 'status'>;
export type Pending = ApprovalCore & { status: 'pending' };
export type Approved = ApprovalCore & { status: 'approved' };
export type Denied = ApprovalCore & { status: 'denied' };
export type Executed = ApprovalCore & { status: 'executed' };
export type Failed = ApprovalCore & { status: 'failed' };
export type AnyNonPending = Approved | Denied | Executed | Failed;
export type AnyTerminal = Executed | Failed | Denied;

export function isPending(a: Approval): a is Pending { return a.status === 'pending'; }
export function isApproved(a: Approval): a is Approved { return a.status === 'approved'; }
export function isDenied(a: Approval): a is Denied { return a.status === 'denied'; }
export function isExecuted(a: Approval): a is Executed { return a.status === 'executed'; }
export function isFailed(a: Approval): a is Failed { return a.status === 'failed'; }

// Pure transition helpers (types only; DB writes happen elsewhere)
export function approve(p: Pending, approver: string): Approved {
  return { ...p, status: 'approved', resolved_by: approver };
}

export function deny(p: Pending, approver: string): Denied {
  return { ...p, status: 'denied', resolved_by: approver };
}

export type ExecuteResultPure =
  | { kind: 'executed'; approvalId: Approval['id']; result: unknown }
  | { kind: 'failed'; approvalId: Approval['id']; error: string };

export function executeApproved(_a: Approved, _resultOrError: { ok: true; result: unknown } | { ok: false; error: string }): ExecuteResultPure {
  if (_resultOrError.ok) return { kind: 'executed', approvalId: _a.id, result: _resultOrError.result };
  return { kind: 'failed', approvalId: _a.id, error: _resultOrError.error };
}

export function assertNever(x: never): never {
  throw new Error(`unreachable: ${String(x)}`);
}

