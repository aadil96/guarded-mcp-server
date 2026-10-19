import type { Paise, ApprovalId, InvoiceId } from '../../src/domain/brands.js';

declare const p: Paise;
declare const a: ApprovalId;
declare const i: InvoiceId;

// @ts-expect-error raw number is not Paise
const badPaise: Paise = 100;

// @ts-expect-error raw string is not ApprovalId
const badAppr: ApprovalId = '00000000-0000-4000-8000-000000000000';

// @ts-expect-error ApprovalId and InvoiceId are not interchangeable
const mixId: ApprovalId = i;

// ok assignments for branded types themselves (no runtime)
const okP: Paise = p;
const okA: ApprovalId = a;
const okI: InvoiceId = i;

