// Type-level guards for the P5 approval state machine, compiled by tsc in CI via "pnpm typecheck".
// Exact assignability assertions, not @ts-expect-error: each one names the property it proves, and it only
// passes while that property holds (an unrelated error elsewhere cannot keep it green).
import type { issueRefund } from '../../src/approvals/refund.js';
import type { assertNever, finishApproved, resolvePending } from '../../src/approvals/state.js';
import type { Approval, ApprovalStatus, Approved, Denied, Executed, Failed, Pending, ToolHandler } from '../../src/approvals/types.js';
import type { WriteToolSpec } from '../../src/tools/framework.js';
import type { ToolInput } from '../../src/tools/framework.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assignable<From, To> = [From] extends [To] ? true : false;
type Assert<T extends true> = T;

// Executing takes Approved only: the handler contract, the shipped refund handler and defineWriteTool's execute.
type HandlerArg = Parameters<ToolHandler['execute']>[1];
type RefundArg = Parameters<typeof issueRefund.execute>[1];
type SpecArg = Parameters<WriteToolSpec<ToolInput>['execute']>[2];
export type ExecuteTakesApprovedOnly = [
  Assert<Equal<HandlerArg, Approved>>,
  Assert<Equal<RefundArg, Approved>>,
  Assert<Equal<SpecArg, Approved>>,
  Assert<Assignable<Approved, HandlerArg>>,
  Assert<Equal<Assignable<Pending, HandlerArg>, false>>,
  Assert<Equal<Assignable<Denied, HandlerArg>, false>>,
  Assert<Equal<Assignable<Executed, HandlerArg>, false>>,
  Assert<Equal<Assignable<Failed, HandlerArg>, false>>,
  Assert<Equal<Assignable<Approval, HandlerArg>, false>>, // an unnarrowed Approval must be switched on first
];

// The DB transitions take exactly the source state they are defined for and return only its target states.
export type TransitionsAreTyped = [
  Assert<Equal<Parameters<typeof resolvePending>[1], Pending>>,
  Assert<Equal<Awaited<ReturnType<typeof resolvePending>>, Approved | Denied>>,
  Assert<Equal<Parameters<typeof finishApproved>[1], Approved>>,
  Assert<Equal<Awaited<ReturnType<typeof finishApproved>>, Executed | Failed>>,
];

// Switches are exhaustive: assertNever accepts only never, so a switch on status that misses a case cannot
// reach it with a narrowed value. Removing one handled status leaves exactly that status unhandled.
type AfterHandling<H extends ApprovalStatus> = Exclude<Approval, { status: H }>;
export type SwitchesAreExhaustive = [
  Assert<Equal<Parameters<typeof assertNever>[0], never>>,
  Assert<Equal<AfterHandling<ApprovalStatus>, never>>,
  Assert<Equal<AfterHandling<'pending' | 'approved' | 'denied' | 'executed'>, Failed>>,
  Assert<Equal<Assignable<Failed, Parameters<typeof assertNever>[0]>, false>>,
];

// Each state carries the fields that state guarantees, discriminated by status.
export type StatesCarryTheirFields = [
  Assert<Equal<ApprovalStatus, 'pending' | 'approved' | 'denied' | 'executed' | 'failed'>>,
  Assert<Equal<Pending['resolved_by'], null>>,
  Assert<Equal<Approved['resolved_by'], string>>,
  Assert<Equal<Denied['resolved_by'], string>>,
  Assert<Equal<Executed['resolved_by'], string>>,
  Assert<Equal<Failed['resolved_by'], string>>,
  Assert<Equal<Pending['result'] | Approved['result'] | Denied['result'], null>>,
  Assert<Equal<Extract<Approval, { status: 'approved' }>, Approved>>,
];
