import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { type Caller, writeAudit } from '../audit/log.js';
import { inAppTx, queryRows } from '../db/index.js';
import type { AppDb } from '../db/types.js';
import { zApprovalId } from '../domain/brands.js';
import type { createApprovals } from './index.js';
import type { HandlerMap } from './types.js';

export type ApprovalsCliDeps = {
  db: AppDb;
  /** From the process context (approverFromEnv), never from argv. */
  caller: Caller;
  approvals: ReturnType<typeof createApprovals>;
  handlers: HandlerMap;
};
export type CliResult = { code: 0 | 1 | 2; output: unknown };

const USAGE = 'usage: pnpm approvals list | approve <id> | deny <id> | execute <id>';
const COMMANDS = new Set(['list', 'approve', 'deny', 'execute']);

/**
 * What a refused invocation records: the command if it is one, the id if it parses, and how many tokens there were.
 * Never the raw tokens: a mistyped secret (`--token sk-…`) must not land in the append-only audit table.
 */
function refusedArgs(argv: readonly string[]) {
  const [command, id] = argv;
  return {
    command: command !== undefined && COMMANDS.has(command) ? command : null,
    approvalId: zApprovalId.safeParse(id).data ?? null,
    argCount: argv.length,
  };
}

/**
 * The sanctioned approve/deny/execute entrypoint. Argv carries only a command and an approval id: any other
 * token (a forged --actor or --role, say) is refused and audited, so identity can only come from deps.caller.
 * Every outcome writes exactly one audit row: approvals functions audit their own, the console audits the rest.
 */
export async function runApprovalsCli(argv: readonly string[], deps: ApprovalsCliDeps): Promise<CliResult> {
  const { db, caller, approvals, handlers } = deps;
  const startedAt = performance.now();
  const refuse = async (error: string): Promise<CliResult> => {
    await inAppTx(db, (tx) => writeAudit(tx, {
      actor: caller.actor, role: caller.role, tool: 'approvals_cli', args: refusedArgs(argv),
      outcome: 'error', startedAt, correlationId: randomUUID(), errorCode: error,
    }));
    return { code: 2, output: { kind: 'usage', error, usage: USAGE } };
  };
  const [command, id, ...rest] = argv;
  if (command === undefined || !COMMANDS.has(command)) return refuse('unknown_command');
  if (command === 'list') {
    if (id !== undefined) return refuse('unexpected_arguments');
    const rows = await queryRows<Record<string, unknown>>(db, sql`
      select id, tool, summary, requested_by, created_at from approvals where status = 'pending' order by created_at limit 50`);
    await inAppTx(db, (tx) => writeAudit(tx, {
      actor: caller.actor, role: caller.role, tool: 'approvals_cli', args: { command }, outcome: 'ok', startedAt, correlationId: randomUUID(),
    }));
    return { code: 0, output: rows };
  }
  if (rest.length > 0 || id?.startsWith('-')) return refuse('unexpected_arguments');
  const approvalId = zApprovalId.safeParse(id);
  if (!approvalId.success) return refuse('invalid_args');
  const r = command === 'execute'
    ? await approvals.executeApproval(db, approvalId.data, caller, handlers)
    : await approvals.resolveApproval(db, { ...caller, approvalId: approvalId.data, decision: command === 'approve' ? 'approve' : 'deny' });
  return { code: r.kind === 'resolved' || r.kind === 'executed' ? 0 : 1, output: r };
}
