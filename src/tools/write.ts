import { issueRefund, issueRefundSchema } from '../approvals/refund.js';
import { type DefinedTool, defineWriteTool } from './framework.js';

export const issueRefundTool = defineWriteTool({
  name: 'issue_refund',
  description:
    'Request a refund of amount_paise on an invoice. Nothing is refunded by this call: it needs a human to approve it, ' +
    'and returns status pending_approval with an approvalId and a summary of the refund. Pass a unique idempotency_key ' +
    'and reuse the same key with the same arguments when retrying; reusing a key with different arguments is a conflict.',
  input: issueRefundSchema,
  summarize: (db, args) => issueRefund.summarize(db, args),
  execute: (tx, _args, approval) => issueRefund.execute(tx, approval),
});

export const writeTools: readonly DefinedTool[] = [issueRefundTool];
