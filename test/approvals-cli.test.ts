import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApprovals, requestWrite } from '../src/approvals/index.js';
import { runApprovalsCli } from '../src/approvals/cli.js';
import { approverFromEnv, callerFromEnv } from '../src/audit/log.js';
import { closeAppDb, connectAsApp } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';
import type { AppDb } from '../src/db/types.js';
import { serverTools } from '../src/server.js';
import { approvalHandlers } from '../src/tools/framework.js';
import { freshDb } from './helpers.js';

// The sanctioned approve/deny/execute entrypoint (closes #18): identity from the process context, never argv.
let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: AppDb;
let invoiceId = '';
let seq = 0;
const op = { actor: 'op-cli', role: 'operator' as const };
const one = async <T>(q: string, p: unknown[] = []) => (await ctx.client.query<T>(q, p)).rows[0];
const audits = async () => (await one<{ n: number }>('select count(*)::int n from audit_events')).n;
const lastAudit = () => one<Record<string, unknown>>('select tool, outcome, error_code, actor, role from audit_events order by created_at desc, id desc limit 1');
const status = async (id: string) => (await one<{ status: string }>('select status from approvals where id = $1', [id])).status;
const cli = (argv: string[], caller: { actor: string; role: 'admin' | 'operator' }, singleOperator = false) =>
  runApprovalsCli(argv, { db, caller, approvals: createApprovals({ singleOperator }), handlers: approvalHandlers(serverTools) });
async function pending(by: { actor: string; role: 'admin' | 'operator' } = op) {
  const r = await requestWrite(db, { ...by, tool: 'issue_refund', args: { invoice_id: invoiceId, amount_paise: 1, reason: 'cli' }, idempotencyKey: `cli-${seq++}` });
  if (r.kind !== 'pending') throw new Error(r.kind);
  return r.approvalId;
}

beforeAll(async () => {
  ctx = await freshDb();
  await seed(ctx.db);
  invoiceId = (await one<{ id: string }>(`select id from invoices where status = 'paid' order by paid_paise desc limit 1`)).id;
  if (ctx.url) db = await connectAsApp(ctx.url);
  else { await ctx.client.query('set role meridian_app'); db = ctx.db as unknown as AppDb; }
});
afterAll(async () => { if (ctx.url) await closeAppDb(db); await ctx.client.close(); });

describe('approvals console', () => {
  const admin = { actor: 'admin-cli', role: 'admin' as const };

  it('list shows pending approvals; approve then execute moves the money once, audited as the console caller', async () => {
    const id = await pending();
    const list = await cli(['list'], admin);
    expect(list.code).toBe(0);
    expect(list.output).toEqual(expect.arrayContaining([expect.objectContaining({ id, tool: 'issue_refund', requested_by: op.actor })]));
    const a = await cli(['approve', id], admin);
    expect(a).toEqual({ code: 0, output: { kind: 'resolved', approvalId: id, status: 'approved' } });
    expect(await lastAudit()).toMatchObject({ tool: 'resolve_approval', outcome: 'ok', actor: admin.actor, role: 'admin' });
    const e = await cli(['execute', id], admin);
    expect(e).toMatchObject({ code: 0, output: { kind: 'executed', approvalId: id } });
    expect(await status(id)).toBe('executed');
    expect(await cli(['execute', id], admin)).toMatchObject({ code: 1, output: { kind: 'duplicate', status: 'executed' } });
  });

  it('deny works and the request can no longer execute', async () => {
    const id = await pending();
    expect(await cli(['deny', id], admin)).toEqual({ code: 0, output: { kind: 'resolved', approvalId: id, status: 'denied' } });
    expect(await cli(['execute', id], admin)).toEqual({ code: 1, output: { kind: 'not_approved', status: 'denied' } });
  });

  it('self-approval is refused through the console too', async () => {
    const id = await pending(admin);
    const before = await audits();
    expect(await cli(['approve', id], admin)).toEqual({ code: 1, output: { kind: 'denied', reason: 'self_approval_forbidden' } });
    expect(await audits()).toBe(before + 1);
    expect(await status(id)).toBe('pending');
  });

  it('an operator console cannot approve or deny (admin_required) but may execute an approved request', async () => {
    const id = await pending();
    const asOp = { actor: 'op-console', role: 'operator' as const };
    expect(await cli(['approve', id], asOp)).toEqual({ code: 1, output: { kind: 'denied', reason: 'admin_required' } });
    expect(await cli(['deny', id], asOp)).toEqual({ code: 1, output: { kind: 'denied', reason: 'admin_required' } });
    expect(await status(id)).toBe('pending');
    expect((await cli(['approve', id], admin)).code).toBe(0);
    expect(await cli(['execute', id], asOp)).toMatchObject({ code: 0, output: { kind: 'executed' } });
  });

  it('forged identity in argv (--actor, --role, actor=…) is refused, audited once, and changes nothing', async () => {
    const id = await pending();
    for (const argv of [['approve', id, '--actor', 'someone-else'], ['approve', id, '--role=admin'], ['approve', id, 'actor=admin-x'], ['approve', '--as', 'admin', id]]) {
      const before = await audits();
      expect(await cli(argv, { actor: 'op-console', role: 'operator' })).toMatchObject({ code: 2, output: { kind: 'usage', error: 'unexpected_arguments' } });
      expect(await audits()).toBe(before + 1);
      expect(await lastAudit()).toMatchObject({ tool: 'approvals_cli', outcome: 'error', error_code: 'unexpected_arguments', actor: 'op-console', role: 'operator' });
    }
    expect(await status(id)).toBe('pending');
  });

  it('rejected tokens are never stored: the audit row keeps only the command, a valid id and an argument count', async () => {
    const id = await pending();
    const secret = 'fake-token-not-a-secret';
    for (const argv of [['approve', id, '--token', secret], [secret], ['approve', secret]]) {
      await cli(argv, admin);
      const a = await one<{ arguments: unknown }>('select arguments from audit_events order by created_at desc, id desc limit 1');
      expect(JSON.stringify(a.arguments), argv.join(' ')).not.toContain(secret);
    }
    const a = await one<{ arguments: unknown }>(`select arguments from audit_events where tool = 'approvals_cli' and error_code = 'unexpected_arguments' order by created_at desc, id desc limit 1`);
    expect(a.arguments).toEqual({ command: 'approve', approvalId: id, argCount: 4 });
  });

  it('a malformed id or unknown command is a usage error, audited once', async () => {
    for (const argv of [['approve', 'not-a-uuid'], ['approve'], ['frobnicate', '00000000-0000-4000-8000-000000000000'], []]) {
      const before = await audits();
      const r = await cli(argv, admin);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(await audits()).toBe(before + 1);
    }
  });
});

describe('the console identity comes from the process context', () => {
  it('approverFromEnv requires APPROVER_ACTOR and APPROVER_ROLE (admin or operator); nothing defaults to admin', () => {
    expect(approverFromEnv({ APPROVER_ACTOR: 'alice', APPROVER_ROLE: 'admin' })).toEqual({ actor: 'alice', role: 'admin' });
    expect(approverFromEnv({ APPROVER_ACTOR: ' bob ', APPROVER_ROLE: 'operator' })).toEqual({ actor: 'bob', role: 'operator' });
    for (const env of [{}, { APPROVER_ACTOR: 'alice' }, { APPROVER_ROLE: 'admin' }, { APPROVER_ACTOR: ' ', APPROVER_ROLE: 'admin' }, { APPROVER_ACTOR: 'a', APPROVER_ROLE: 'reader' }, { APPROVER_ACTOR: 'a', APPROVER_ROLE: 'ADMIN' }]) {
      expect(() => approverFromEnv(env), JSON.stringify(env)).toThrow();
    }
  });

  it('the MCP server caller can never be admin, so no MCP path can approve', () => {
    expect(callerFromEnv({ MCP_ROLE: 'admin', MCP_ACTOR: 'x' }).role).toBe('reader');
    expect(serverTools.map((t) => t.name)).not.toEqual(expect.arrayContaining(['resolve_approval']));
    expect(serverTools.map((t) => t.name)).not.toEqual(expect.arrayContaining(['execute_approval']));
  });
});
