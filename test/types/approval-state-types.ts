// Type-level guards for the P5 approval state machine. Compiled by tsc in CI via "pnpm typecheck".
// Each @ts-expect-error must fail if its line is changed to valid code (tsc reports an unused directive).
import { issueRefund } from '../../src/approvals/refund.js';
import { assertNever, finishApproved, resolvePending } from '../../src/approvals/state.js';
import type { Approval, Approved, Denied, Executed, Failed, Pending, ToolHandler } from '../../src/approvals/types.js';
import type { AppTx } from '../../src/db/types.js';
import { defineWriteTool } from '../../src/tools/framework.js';
import * as z from 'zod';

declare const tx: AppTx;
declare const pending: Pending;
declare const approved: Approved;
declare const denied: Denied;
declare const executed: Executed;
declare const failed: Failed;
declare const any: Approval;
declare const handler: ToolHandler;

// Executing takes Approved only: the handler contract, the shipped refund handler and defineWriteTool's execute.
void handler.execute(tx, approved);
void issueRefund.execute(tx, approved);
// @ts-expect-error a pending approval cannot be executed
void handler.execute(tx, pending);
// @ts-expect-error a denied approval cannot be executed
void handler.execute(tx, denied);
// @ts-expect-error an executed approval cannot be executed again
void handler.execute(tx, executed);
// @ts-expect-error a failed approval cannot be executed again
void handler.execute(tx, failed);
// @ts-expect-error an unnarrowed Approval cannot be executed: switch on status first
void handler.execute(tx, any);
// @ts-expect-error the refund handler also refuses a pending approval
void issueRefund.execute(tx, pending);
defineWriteTool({
  name: 'issue_refund', description: 'x', input: z.strictObject({ n: z.number() }), summarize: async () => 's',
  execute: async (_tx, _args, a) => {
    const ok: Approved = a;
    // @ts-expect-error defineWriteTool's execute receives Approved, never Pending
    const notPending: Pending = a;
    void ok; void notPending;
    return { ok: true, result: {} };
  },
});

// The DB transitions take the source state they are defined for, and return only the target states.
const resolved: Promise<Approved | Denied> = resolvePending(tx, pending, 'approve', 'admin');
const finished: Promise<Executed | Failed> = finishApproved(tx, approved, { ok: true, result: {} });
void resolved; void finished;
// @ts-expect-error only a pending approval can be approved or denied
void resolvePending(tx, approved, 'approve', 'admin');
// @ts-expect-error only an approved approval can be finished
void finishApproved(tx, pending, { ok: true, result: {} });
// @ts-expect-error a denied approval cannot be finished
void finishApproved(tx, denied, { ok: false, error: 'x' });

// Switches on status are exhaustive: dropping a case is a compile error at assertNever.
function describeStatus(a: Approval): string {
  switch (a.status) {
    case 'pending': return 'p';
    case 'approved': return 'a';
    case 'denied': return 'd';
    case 'executed': return 'e';
    case 'failed': return 'f';
    default: return assertNever(a);
  }
}
function missingCase(a: Approval): string {
  switch (a.status) {
    case 'pending': return 'p';
    case 'approved': return 'a';
    case 'denied': return 'd';
    case 'executed': return 'e';
    // @ts-expect-error 'failed' is not handled, so a is not never
    default: return assertNever(a);
  }
}
void describeStatus; void missingCase;

// Narrowing: each state carries the fields that state guarantees.
const resolver: string = approved.resolved_by;
// @ts-expect-error a pending approval has no resolver yet
const pendingResolver: string = pending.resolved_by;
void resolver; void pendingResolver;
