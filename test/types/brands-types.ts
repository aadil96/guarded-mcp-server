// Type-level guards for the P4 brands. Compiled by tsc in CI via "pnpm typecheck".
// Each @ts-expect-error must fail if its line is changed to valid code (tsc reports an unused directive).
import { executeApproval, resolveApproval } from '../../src/approvals/index.js';
import type { Approval, RequestWriteResult } from '../../src/approvals/types.js';
import type { AppDb, AppTx } from '../../src/db/types.js';
import { type ApprovalId, computeRefundable, type InvoiceId, type Paise, paise, zApprovalId, zInvoiceId } from '../../src/domain/brands.js';

declare const db: AppDb;
declare const tx: AppTx;
declare const approvalId: ApprovalId;
declare const invoiceId: InvoiceId;
declare const p: Paise;
declare const raw: string;
const admin = { actor: 'a', role: 'admin' as const };

// Constructors are the only way in: zod at the argument boundary, paise() at the number/bigint boundary.
const okInvoice: InvoiceId = zInvoiceId.parse(raw);
const okApproval: ApprovalId = zApprovalId.parse(raw);
const okPaise: Paise = paise(100);
void okInvoice; void okApproval; void okPaise;

// @ts-expect-error a raw number is not Paise
const badPaiseNumber: Paise = 100;
// @ts-expect-error a raw bigint is not Paise
const badPaiseBigint: Paise = 100n;
// @ts-expect-error Paise is bigint-backed: it is not a number
const paiseAsNumber: number = p;
// @ts-expect-error a raw string is not an ApprovalId
const badApproval: ApprovalId = raw;
// @ts-expect-error an InvoiceId is not an ApprovalId
const swappedApproval: ApprovalId = invoiceId;
// @ts-expect-error an ApprovalId is not an InvoiceId
const swappedInvoice: InvoiceId = approvalId;
void badPaiseNumber; void badPaiseBigint; void paiseAsNumber; void badApproval; void swappedApproval; void swappedInvoice;

// The approvals API carries ApprovalId end to end.
declare const r: RequestWriteResult & { kind: 'pending' };
const fromResult: ApprovalId = r.approvalId;
declare const row: Approval;
const fromRow: ApprovalId = row.id;
void fromResult; void fromRow;
void executeApproval(db, approvalId, admin);
// @ts-expect-error executeApproval takes an ApprovalId, not a raw string
void executeApproval(db, raw, admin);
// @ts-expect-error executeApproval takes an ApprovalId, not an InvoiceId
void executeApproval(db, invoiceId, admin);
void resolveApproval(db, { ...admin, approvalId, decision: 'approve' });
// @ts-expect-error resolveApproval takes an ApprovalId, not a raw string
void resolveApproval(db, { ...admin, approvalId: raw, decision: 'approve' });

// One refundable function, keyed by InvoiceId, returning exact Paise (or null for an unknown invoice).
const refundable: Promise<Paise | null> = computeRefundable(db, invoiceId);
const locked: Promise<Paise | null> = computeRefundable(tx, invoiceId, { lock: true });
void refundable; void locked;
// @ts-expect-error computeRefundable needs an InvoiceId, not a raw string
void computeRefundable(db, raw);
// @ts-expect-error computeRefundable needs an InvoiceId, not an ApprovalId
void computeRefundable(db, approvalId);
// @ts-expect-error locking needs a transaction, not the pool handle
void computeRefundable(db, invoiceId, { lock: true });
