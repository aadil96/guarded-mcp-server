import { approve, deny, executeApproved, type Pending, type Approved, type Denied, type Executed } from '../../src/approvals/state.js';

declare const p: Pending;
declare const a: Approved;
declare const d: Denied;
declare const e: Executed;

// ok
const x = approve(p, 'admin');
const y = deny(p, 'admin');
const z = executeApproved(a, { ok: true, result: {} });
void x; void y; void z;

// @ts-expect-error cannot execute a pending approval
executeApproved(p, { ok: true, result: {} });

// @ts-expect-error cannot execute a denied approval
executeApproved(d, { ok: true, result: {} });

// @ts-expect-error cannot execute an executed approval
executeApproved(e, { ok: true, result: {} });

