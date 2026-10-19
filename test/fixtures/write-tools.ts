import { issueRefund, issueRefundSchema } from '../../src/approvals/refund.js';
import { defineWriteTool } from '../../src/tools/framework.js';

/** issue_refund through defineWriteTool, as the MCP wiring will register it. Test-only until that lands. */
export const refundTool = defineWriteTool({
  name: 'issue_refund',
  description: 'Request a refund on an invoice. Needs admin approval before it runs.',
  input: issueRefundSchema,
  summarize: (db, args) => issueRefund.summarize(db, args),
  execute: (tx, _args, approval) => issueRefund.execute(tx, approval),
});
