import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeApproval, resolveApproval } from '../src/approvals/index.js';
import { closeAppDb, connectAsApp } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';
import type { AppDb } from '../src/db/types.js';
import { serverTools } from '../src/server.js';
import { approvalHandlers } from '../src/tools/framework.js';
import { freshDb, mcpClient } from './helpers.js';
import { zApprovalId } from '../src/domain/brands.js';

// issue_refund as the shipped server registers it: default tool list, MCP client/server pair, app role.
let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: AppDb;
let cli: Awaited<ReturnType<typeof mcpClient>>;
let invoiceId = '';
let invoiceNumber = '';
const op = { actor: 'op-refund', role: 'operator' as const };
const admin = { actor: 'admin-refund', role: 'admin' as const };

const one = async <T>(q: string, p: unknown[] = []) => (await ctx.client.query<T>(q, p)).rows[0];
const auditCount = async () => (await one<{ n: number }>('select count(*)::int n from audit_events')).n;
const moneyState = async () => one<{ refunds: number; credit_notes: number; invoices: string }>(
  `select (select count(*)::int from refunds) refunds, (select count(*)::int from credit_notes) credit_notes,
          (select md5(string_agg(i::text, '|' order by i.id)) from invoices i) invoices`,
);
const args = (amount: number, key: string, reason = 'damaged in transit') =>
  ({ invoice_id: invoiceId, amount_paise: amount, reason, idempotency_key: key });

beforeAll(async () => {
  ctx = await freshDb();
  await seed(ctx.db);
  ({ id: invoiceId, invoice_number: invoiceNumber } = await one<{ id: string; invoice_number: string }>(
    `select id, invoice_number from invoices where status = 'paid' order by invoice_number limit 1`));
  if (ctx.url) db = await connectAsApp(ctx.url);
  else { await ctx.client.query('set role meridian_app'); db = ctx.db as unknown as AppDb; }
  cli = await mcpClient(db, op);
});
afterAll(async () => { await cli.close(); if (ctx.url) await closeAppDb(db); await ctx.client.close(); });

let before = 0;
let money: Awaited<ReturnType<typeof moneyState>>;
beforeEach(async () => { before = await auditCount(); money = await moneyState(); });

const lastAudit = () => one<Record<string, unknown>>(
  'select tool, outcome, error_code, approval_id, idempotency_key, actor, role, arguments from audit_events order by created_at desc, id desc limit 1');

describe('issue_refund over MCP', () => {
  it('is registered on the shipped server with honest annotations and a strict schema', async () => {
    expect(serverTools.map((t) => t.name)).toContain('issue_refund');
    const t = (await cli.list()).find((x) => x.name === 'issue_refund');
    expect(t?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    expect(t?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(['invoice_id', 'amount_paise', 'reason', 'idempotency_key']),
    });
    expect((t as { description?: string }).description).toMatch(/approval/i);
    expect((t as { description?: string }).description).toMatch(/idempotency_key/);
  });

  it('pending: approvalId and summary, one pending_approval audit row, no money moves', async () => {
    const r = await cli.call('issue_refund', args(1500, 'r-pending'));
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({ status: 'pending_approval', approvalId: expect.any(String), summary: expect.stringMatching(new RegExp(`^Refund ₹15\\.00 on ${invoiceNumber}; ₹[\\d,]+\\.\\d{2} refundable when requested$`)) });
    expect(await auditCount()).toBe(before + 1);
    expect(await lastAudit()).toMatchObject({
      tool: 'issue_refund', outcome: 'pending_approval', error_code: null, approval_id: r.data.approvalId,
      idempotency_key: 'r-pending', actor: 'op-refund', role: 'operator',
    });
    expect(await one('select status, summary from approvals where id = $1', [r.data.approvalId]))
      .toEqual({ status: 'pending', summary: r.data.summary });
    expect(await moneyState()).toEqual(money);
  });

  it('same key, same args while pending: same approvalId, no second approval, no result yet', async () => {
    const first = await cli.call('issue_refund', args(1500, 'r-pending'));
    const again = await cli.call('issue_refund', args(1500, 'r-pending'));
    expect(again.data).toEqual({ status: 'pending_approval', approvalId: first.data.approvalId, summary: first.data.summary });
    expect(await one('select count(*)::int n, max(result::text) r from approvals where idempotency_key = $1', ['r-pending'])).toEqual({ n: 1, r: null });
    expect(await auditCount()).toBe(before + 2);
    expect(await moneyState()).toEqual(money);
  });

  it('same key, different args: conflict tool error naming the existing approval', async () => {
    const first = await cli.call('issue_refund', args(1500, 'r-pending'));
    const r = await cli.call('issue_refund', args(1501, 'r-pending'));
    expect(r).toMatchObject({ isError: true, data: { error: 'conflict', reason: 'idempotency_key_reused', approvalId: first.data.approvalId } });
    expect(await auditCount()).toBe(before + 2);
    expect(await lastAudit()).toMatchObject({ outcome: 'conflict', error_code: 'idempotency_key_reused', approval_id: first.data.approvalId });
  });

  it('previously denied key: denied with reason previously_denied', async () => {
    const { data } = await cli.call('issue_refund', args(700, 'r-deny'));
    expect((await resolveApproval(db, { ...admin, approvalId: data.approvalId, decision: 'deny' })).kind).toBe('resolved');
    const r = await cli.call('issue_refund', args(700, 'r-deny'));
    expect(r).toMatchObject({ isError: true, data: { error: 'denied', reason: 'previously_denied' } });
    expect(await lastAudit()).toMatchObject({ outcome: 'denied', error_code: 'previously_denied', approval_id: data.approvalId });
    expect(await moneyState()).toEqual(money);
  });

  it('bad args: invalid_args with zod issues, no input values echoed, audited once', async () => {
    const secret = 'SENSITIVE-VALUE-7731';
    const r = await cli.call('issue_refund', { invoice_id: secret, amount_paise: -5, reason: secret, extra_field: secret, idempotency_key: 'r-bad' });
    expect(r.isError).toBe(true);
    const wire = JSON.stringify(r.raw);
    expect(wire).toContain('Input validation error');
    expect(wire).toMatch(/invoice_id/);
    expect(wire).toMatch(/amount_paise/);
    expect(wire).not.toContain(secret);
    expect(await auditCount()).toBe(before + 1);
    expect(await lastAudit()).toMatchObject({ tool: 'issue_refund', outcome: 'error', error_code: 'invalid_args', role: 'operator' });
    expect(await one('select count(*)::int n from approvals where idempotency_key = $1', ['r-bad'])).toEqual({ n: 0 });
  });

  it('bad args the approvals core rejects return its zod issues without values', async () => {
    const key = 'é'.repeat(150);
    const r = await cli.call('issue_refund', args(100, key));
    expect(r).toMatchObject({ isError: true, data: { error: 'invalid_args', issues: [expect.objectContaining({ path: ['idempotencyKey'] })] } });
    expect(JSON.stringify(r.data)).not.toContain(key);
    expect(await auditCount()).toBe(before + 1);
  });

  it('nothing executes until approve + execute; then the same call is a duplicate with the result', async () => {
    const { data } = await cli.call('issue_refund', args(2500, 'r-exec'));
    const id = zApprovalId.parse(data.approvalId);
    expect(await moneyState()).toEqual(money);
    expect((await resolveApproval(db, { ...admin, approvalId: id, decision: 'approve' })).kind).toBe('resolved');
    expect(await moneyState()).toEqual(money);
    const ex = await executeApproval(db, id, admin, approvalHandlers(serverTools));
    if (ex.kind !== 'executed') throw new Error(`expected executed, got ${ex.kind}`);
    expect((await moneyState()).refunds).toBe(money.refunds + 1);
    const r = await cli.call('issue_refund', args(2500, 'r-exec'));
    expect(r).toMatchObject({ isError: false, data: { status: 'duplicate', approvalId: id, approvalStatus: 'executed', result: ex.result } });
    expect((await moneyState()).refunds).toBe(money.refunds + 1);
  });
});
