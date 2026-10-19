// The approvals console: pnpm approvals list | approve <id> | deny <id> | execute <id>
// Identity comes from APPROVER_ACTOR / APPROVER_ROLE in the environment, never from arguments.
import { loadApprovalsConfig, createApprovals } from '../src/approvals/index.js';
import { runApprovalsCli } from '../src/approvals/cli.js';
import { approverFromEnv } from '../src/audit/log.js';
import { closeAppDb, connectAsApp } from '../src/db/index.js';
import { serverTools } from '../src/server.js';
import { approvalHandlers } from '../src/tools/framework.js';

let caller: ReturnType<typeof approverFromEnv>;
let approvals: ReturnType<typeof createApprovals>;
try {
  caller = approverFromEnv();
  approvals = createApprovals(loadApprovalsConfig());
} catch (e) {
  console.error(`approvals: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
}
const db = await connectAsApp(process.env.DATABASE_URL);
try {
  const r = await runApprovalsCli(process.argv.slice(2), { db, caller, approvals, handlers: approvalHandlers(serverTools) });
  console.log(JSON.stringify(r.output, null, 2));
  process.exitCode = r.code;
} finally {
  await closeAppDb(db);
}
