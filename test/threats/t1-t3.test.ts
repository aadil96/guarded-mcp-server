import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApprovals, defaultHandlers, type HandlerMap, executeApproval, loadApprovalsConfig, requestWrite, resolveApproval } from '../../src/approvals/index.js';
import { seed, seedId } from '../../src/db/seed.js';
import { sql } from 'drizzle-orm';
import { closeAppDb, connectAsApp, queryRows } from '../../src/db/index.js';
import type { AppDb } from '../../src/db/types.js';
import { auditFailing, freshDb } from '../helpers.js';

let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: AppDb;
const op = { actor: 'op-1', role: 'operator' as const };
const admin = { actor: 'admin-1', role: 'admin' as const };
const reader = { actor: 'reader-1', role: 'reader' as const };

const n = async (q: string, p: unknown[] = []) => (await ctx.client.query<{ n: number }>(`select count(*)::int n from ${q}`, p)).rows[0].n;
const refundsFor = (inv: string) => n('refunds where invoice_id = $1', [inv]);
const lastAudit = async () => (await ctx.client.query<{ outcome: string; arguments: unknown; duration_ms: number; correlation_id: string; approval_id: string | null; error_code: string | null }>(
  'select * from audit_events order by created_at desc, ctid desc limit 1')).rows[0];
const used = new Set<string>();
async function invoice(status: 'paid' | 'part_paid' | 'unpaid' = 'paid') {
  const r = await ctx.client.query<{ id: string; total_paise: string; paid_paise: string; invoice_number: string }>(
    'select id, total_paise, paid_paise, invoice_number from invoices where status = $1 order by invoice_number', [status]);
  const row = r.rows.find((x) => !used.has(x.id));
  if (!row) throw new Error(`no unused ${status} invoice in seed`);
  used.add(row.id);
  return { id: row.id, total: Number(row.total_paise), paid: Number(row.paid_paise), number: row.invoice_number };
}
const refundArgs = (invoice_id: string, amount_paise: number) => ({ invoice_id, amount_paise, reason: 'damaged in transit' });
async function approved(key: string, args: Record<string, unknown>) {
  const r = await requestWrite(db, { ...op, tool: 'issue_refund', args, idempotencyKey: key });
  if (r.kind !== 'pending') throw new Error(`expected pending, got ${r.kind}`);
  const res = await resolveApproval(db, { ...admin, approvalId: r.approvalId, decision: 'approve' });
  expect(res).toMatchObject({ kind: 'resolved', status: 'approved' });
  return r.approvalId;
}

beforeAll(async () => {
  ctx = await freshDb();
  await seed(ctx.db);
  if (ctx.url) {
    db = await connectAsApp(ctx.url);
  } else {
    await ctx.client.query('set role meridian_app');
    db = ctx.db as unknown as AppDb;
  }
});
afterAll(async () => {
  await closeAppDb(db);
  await ctx.client.close();
});

describe('T1 idempotency', () => {
  it('same key + same args: one approval, pending repeat, duplicate replay after execution, one refund', async () => {
    const inv = await invoice();
    const args = refundArgs(inv.id, 100);
    const a = await requestWrite(db, { ...op, tool: 'issue_refund', args, idempotencyKey: 't1-same' });
    expect(a.kind).toBe('pending');
    if (a.kind !== 'pending') return;
    expect(a.summary).toBe(`Refund ₹1.00 on ${inv.number}`);
    expect((await lastAudit()).outcome).toBe('pending_approval');
    const b = await requestWrite(db, { ...op, tool: 'issue_refund', args: { reason: args.reason, amount_paise: 100, invoice_id: inv.id }, idempotencyKey: 't1-same' });
    expect(b).toMatchObject({ kind: 'pending', approvalId: a.approvalId });
    expect(await n(`approvals where idempotency_key = 't1-same'`)).toBe(1);
    await resolveApproval(db, { ...admin, approvalId: a.approvalId, decision: 'approve' });
    const ex = await executeApproval(db, a.approvalId, admin);
    expect(ex.kind).toBe('executed');
    expect((await lastAudit()).outcome).toBe('ok');
    const c = await requestWrite(db, { ...op, tool: 'issue_refund', args, idempotencyKey: 't1-same' });
    expect(c).toMatchObject({ kind: 'duplicate', approvalId: a.approvalId, status: 'executed' });
    if (c.kind === 'duplicate' && ex.kind === 'executed') expect(c.result).toEqual(ex.result);
    expect((await lastAudit()).outcome).toBe('duplicate');
    expect(await refundsFor(inv.id)).toBe(1);
  });

  it('same key + different args: conflict, zero changes', async () => {
    const inv = await invoice();
    await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 100), idempotencyKey: 't1-conf' });
    const before = await ctx.client.query('select * from approvals order by id');
    const refundsBefore = await n('refunds');
    const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 999), idempotencyKey: 't1-conf' });
    expect(r.kind).toBe('conflict');
    expect((await ctx.client.query('select * from approvals order by id')).rows).toEqual(before.rows);
    expect(await n('refunds')).toBe(refundsBefore);
    expect((await lastAudit()).outcome).toBe('conflict');
  });

  it('concurrent requestWrite with one key creates one approval', async () => {
    const inv = await invoice();
    const rs = await Promise.all([1, 2, 3].map(() => requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 100), idempotencyKey: 't1-race' })));
    expect(rs.every((r) => r.kind === 'pending')).toBe(true);
    expect(new Set(rs.map((r) => (r.kind === 'pending' ? r.approvalId : '')))).toHaveProperty('size', 1);
    expect(await n(`approvals where idempotency_key = 't1-race'`)).toBe(1);
  });

  it('two concurrent executeApproval calls produce exactly one refund', async () => {
    const inv = await invoice();
    const id = await approved('t1-exec', refundArgs(inv.id, 100));
    const [x, y] = await Promise.all([executeApproval(db, id, admin), executeApproval(db, id, admin)]);
    expect([x.kind, y.kind].sort()).toEqual(['duplicate', 'executed']);
    expect(await refundsFor(inv.id)).toBe(1);
    expect(await n(`audit_events where approval_id = $1 and outcome = 'duplicate'`, [id])).toBe(1);
  });
});

describe('T2 no approval, no write', () => {
  it('requestWrite alone inserts no refund, and execute on a pending approval does nothing', async () => {
    const inv = await invoice();
    const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 100), idempotencyKey: 't2-pending' });
    if (r.kind !== 'pending') throw new Error('expected pending');
    expect(await executeApproval(db, r.approvalId, admin)).toEqual({ kind: 'not_approved', status: 'pending' });
    expect((await lastAudit()).outcome).toBe('error');
    expect(await refundsFor(inv.id)).toBe(0);
  });
  it('denied approval inserts no refund and cannot be executed', async () => {
    const inv = await invoice();
    const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 100), idempotencyKey: 't2-denied' });
    if (r.kind !== 'pending') throw new Error('expected pending');
    expect(await resolveApproval(db, { ...admin, approvalId: r.approvalId, decision: 'deny' })).toMatchObject({ kind: 'resolved', status: 'denied' });
    expect(await executeApproval(db, r.approvalId, admin)).toEqual({ kind: 'not_approved', status: 'denied' });
    expect(await resolveApproval(db, { ...admin, approvalId: r.approvalId, decision: 'approve' })).toEqual({ kind: 'invalid_state', status: 'denied' });
    expect(await refundsFor(inv.id)).toBe(0);
  });
  it('reader role is denied and writes nothing but an audit row', async () => {
    const before = await n('approvals');
    const r = await requestWrite(db, { ...reader, tool: 'issue_refund', args: refundArgs(seedId('invoice:7'), 100), idempotencyKey: 't2-reader' });
    expect(r).toEqual({ kind: 'denied', reason: 'role_not_permitted' });
    expect(await n('approvals')).toBe(before);
    const a = await lastAudit();
    expect(a).toMatchObject({ outcome: 'denied', error_code: 'role_not_permitted' });
    expect(a.duration_ms).toBeGreaterThanOrEqual(0);
    expect(a.correlation_id).toBeTruthy();
  });
});

describe('T3 resolver binding', () => {
  it('non-admin cannot approve', async () => {
    const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(seedId('invoice:8'), 100), idempotencyKey: 't3-nonadmin' });
    if (r.kind !== 'pending') throw new Error('expected pending');
    expect(await resolveApproval(db, { actor: 'op-2', role: 'operator', approvalId: r.approvalId, decision: 'approve' })).toEqual({ kind: 'denied', reason: 'admin_required' });
    expect((await lastAudit()).outcome).toBe('denied');
  });
  it('self-approval is denied by default (config off)', async () => {
    const me = { actor: 'solo', role: 'admin' as const };
    const r = await requestWrite(db, { ...me, tool: 'issue_refund', args: refundArgs(seedId('invoice:9'), 100), idempotencyKey: 't3-self' });
    if (r.kind !== 'pending') throw new Error('expected pending');
    expect(await resolveApproval(db, { ...me, approvalId: r.approvalId, decision: 'approve' })).toEqual({ kind: 'denied', reason: 'self_approval_forbidden' });
    const off = createApprovals(loadApprovalsConfig({ NODE_ENV: 'development' }));
    expect(await off.resolveApproval(db, { ...me, approvalId: r.approvalId, decision: 'approve' })).toEqual({ kind: 'denied', reason: 'self_approval_forbidden' });
    expect((await lastAudit())).toMatchObject({ outcome: 'denied', error_code: 'self_approval_forbidden' });
  });
  it('a request carrying singleOperator is rejected as invalid_args (audited) and cannot self-approve', async () => {
    const me = { actor: 'solo-smuggle', role: 'admin' as const };
    const r = await requestWrite(db, { ...me, tool: 'issue_refund', args: refundArgs(seedId('invoice:9'), 101), idempotencyKey: 't3-smuggle' });
    if (r.kind !== 'pending') throw new Error('expected pending');
    const auditBefore = await n('audit_events');
    const smuggled = { ...me, approvalId: r.approvalId, decision: 'approve', singleOperator: true } as unknown as Parameters<typeof resolveApproval>[1];
    expect(await resolveApproval(db, smuggled)).toEqual({ kind: 'invalid_args' });
    expect(await n('audit_events')).toBe(auditBefore + 1);
    expect(await lastAudit()).toMatchObject({ outcome: 'error', error_code: 'invalid_args' });
    const st = await ctx.client.query<{ status: string }>('select status from approvals where id = $1', [r.approvalId]);
    expect(st.rows[0].status).toBe('pending');
  });
  it('self-approval is allowed only when server config enables single-operator mode', async () => {
    const me = { actor: 'solo-dev', role: 'admin' as const };
    const r = await requestWrite(db, { ...me, tool: 'issue_refund', args: refundArgs(seedId('invoice:9'), 102), idempotencyKey: 't3-solo-on' });
    if (r.kind !== 'pending') throw new Error('expected pending');
    const on = createApprovals(loadApprovalsConfig({ APPROVALS_SINGLE_OPERATOR: 'true', NODE_ENV: 'development' }));
    expect(on.config.singleOperator).toBe(true);
    expect(await on.resolveApproval(db, { ...me, approvalId: r.approvalId, decision: 'approve' })).toMatchObject({ kind: 'resolved', status: 'approved' });
  });
  it('startup refuses APPROVALS_SINGLE_OPERATOR=true unless NODE_ENV is exactly development', () => {
    for (const NODE_ENV of ['production', undefined, '', 'test', 'staging', 'Development', 'develop']) {
      expect(() => loadApprovalsConfig({ APPROVALS_SINGLE_OPERATOR: 'true', NODE_ENV })).toThrow(/only allowed when NODE_ENV=development/);
    }
    expect(loadApprovalsConfig({ APPROVALS_SINGLE_OPERATOR: 'true', NODE_ENV: 'development' })).toEqual({ singleOperator: true });
    expect(() => loadApprovalsConfig({ APPROVALS_SINGLE_OPERATOR: 'yes' })).toThrow();
    expect(loadApprovalsConfig({ NODE_ENV: 'production' })).toEqual({ singleOperator: false });
    expect(loadApprovalsConfig({})).toEqual({ singleOperator: false });
  });
  it('knowing the approval id alone is not enough', async () => {
    const inv = await invoice();
    const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 100), idempotencyKey: 't3-idonly' });
    if (r.kind !== 'pending') throw new Error('expected pending');
    expect((await resolveApproval(db, { ...reader, approvalId: r.approvalId, decision: 'approve' })).kind).toBe('denied');
    expect((await executeApproval(db, r.approvalId, reader)).kind).toBe('denied');
    expect((await executeApproval(db, r.approvalId, op)).kind).toBe('not_approved');
    expect(await refundsFor(inv.id)).toBe(0);
  });
  it('amount over remaining -> failed, no refund', async () => {
    const inv = await invoice();
    const id = await approved('t3-over', refundArgs(inv.id, inv.paid + 1));
    expect(await executeApproval(db, id, admin)).toEqual({ kind: 'failed', approvalId: id, error: 'amount_exceeds_remaining' });
    expect(await lastAudit()).toMatchObject({ outcome: 'error', error_code: 'amount_exceeds_remaining' });
    expect((await ctx.client.query<{ status: string }>('select status from approvals where id = $1', [id])).rows[0].status).toBe('failed');
    expect(await refundsFor(inv.id)).toBe(0);
  });
  it('two approved refunds that each fit but together exceed: second fails, total never exceeds invoice', async () => {
    const inv = await invoice();
    const part = Math.floor(inv.paid * 0.6);
    const a = await approved('t3-sum-a', refundArgs(inv.id, part));
    const b = await approved('t3-sum-b', refundArgs(inv.id, part));
    const rs = await Promise.all([executeApproval(db, a, admin), executeApproval(db, b, admin)]);
    expect(rs.map((r) => r.kind).sort()).toEqual(['executed', 'failed']);
    const sum = (await ctx.client.query<{ s: string }>('select coalesce(sum(amount_paise),0) s from refunds where invoice_id = $1', [inv.id])).rows[0].s;
    expect(Number(sum)).toBe(part);
    expect(Number(sum)).toBeLessThanOrEqual(inv.paid);
  });
  it('full refund of a paid invoice marks it refunded', async () => {
    const inv = await invoice();
    const id = await approved('t3-full', refundArgs(inv.id, inv.paid));
    expect((await executeApproval(db, id, admin)).kind).toBe('executed');
    expect((await ctx.client.query<{ status: string }>('select status from invoices where id = $1', [inv.id])).rows[0].status).toBe('refunded');
  });
});

describe('refund cap = paid minus prior refunds', () => {
  it('part-paid invoice: refund over the paid amount fails, no refund', async () => {
    const inv = await invoice('part_paid');
    expect(inv.paid).toBeLessThan(inv.total);
    const id = await approved('cap-pp-over', refundArgs(inv.id, inv.paid + 1));
    expect(await executeApproval(db, id, admin)).toMatchObject({ kind: 'failed', error: 'amount_exceeds_remaining' });
    expect(await refundsFor(inv.id)).toBe(0);
  });
  it('unpaid invoice: any refund fails', async () => {
    const inv = await invoice('unpaid');
    const id = await approved('cap-unpaid', refundArgs(inv.id, 1));
    expect(await executeApproval(db, id, admin)).toMatchObject({ kind: 'failed', error: 'amount_exceeds_remaining' });
    expect(await refundsFor(inv.id)).toBe(0);
  });
  it('part-paid invoice: refund up to the paid amount succeeds and marks it refunded', async () => {
    const inv = await invoice('part_paid');
    const id = await approved('cap-pp-full', refundArgs(inv.id, inv.paid));
    expect((await executeApproval(db, id, admin)).kind).toBe('executed');
    expect((await ctx.client.query<{ status: string }>('select status from invoices where id = $1', [inv.id])).rows[0].status).toBe('refunded');
  });
});

describe('argument validation and denied replay', () => {
  it('invalid args -> invalid_args with issues, audit error/invalid_args, no approval row', async () => {
    const before = await n('approvals');
    const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: { invoice_id: 'not-a-uuid', amount_paise: -5, reason: '' }, idempotencyKey: 'v-bad' });
    expect(r.kind).toBe('invalid_args');
    if (r.kind === 'invalid_args') expect(r.issues.map((i) => i.path[0]).sort()).toEqual(['amount_paise', 'invoice_id', 'reason']);
    expect(await lastAudit()).toMatchObject({ outcome: 'error', error_code: 'invalid_args' });
    expect(await n('approvals')).toBe(before);
    expect(await n(`approvals where idempotency_key = 'v-bad'`)).toBe(0);
  });
  it('hashes the parsed args: whitespace-only difference trimmed by the schema is the same request', async () => {
    const inv = await invoice('unpaid');
    const a = await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 100), idempotencyKey: 'v-trim' });
    const b = await requestWrite(db, { ...op, tool: 'issue_refund', args: { ...refundArgs(inv.id, 100), reason: '  damaged in transit ' }, idempotencyKey: 'v-trim' });
    expect(b.kind).toBe('pending');
    if (a.kind === 'pending' && b.kind === 'pending') expect(b.approvalId).toBe(a.approvalId);
  });
  it('same key after a denied approval -> denied/previously_denied', async () => {
    const inv = await invoice('unpaid');
    const args = refundArgs(inv.id, 100);
    const r = await requestWrite(db, { ...op, tool: 'issue_refund', args, idempotencyKey: 'v-denied' });
    if (r.kind !== 'pending') throw new Error('expected pending');
    await resolveApproval(db, { ...admin, approvalId: r.approvalId, decision: 'deny' });
    expect(await requestWrite(db, { ...op, tool: 'issue_refund', args, idempotencyKey: 'v-denied' })).toEqual({ kind: 'denied', reason: 'previously_denied' });
    expect(await lastAudit()).toMatchObject({ outcome: 'denied', error_code: 'previously_denied', approval_id: r.approvalId });
    expect(await refundsFor(inv.id)).toBe(0);
  });
});

describe('audit', () => {
  it('runs as meridian_app, which cannot UPDATE audit_events', async () => {
    const [who] = await queryRows<{ u: string }>(db, sql`select current_user u`);
    expect(who.u).toBe('meridian_app');
    await expect(db.execute(sql`update audit_events set outcome = 'ok'`))
      .rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied|append-only/) } });
  });
  it('redacts sensitive args and records every outcome', async () => {
    await requestWrite(db, { ...reader, tool: 'issue_refund', args: { ...refundArgs(seedId('invoice:14'), 1), customer_email: 'x@example.test' }, idempotencyKey: 't-audit' });
    expect((await lastAudit()).arguments).toMatchObject({ customer_email: '[redacted]' });
    const outcomes = (await ctx.client.query<{ outcome: string }>('select distinct outcome::text from audit_events')).rows.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['conflict', 'denied', 'duplicate', 'error', 'ok', 'pending_approval']);
  });
});


describe('audit atomicity (Codex P1/P2)', () => {
  it('requestWrite: forced audit failure rolls back the approval insert', async () => {
    const inv = await invoice('part_paid');
    const audits = await n('audit_events');
    await expect(requestWrite(auditFailing(db), { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 100), idempotencyKey: 'atom-req' }))
      .rejects.toThrow('forced audit failure');
    expect(await n(`approvals where idempotency_key = 'atom-req'`)).toBe(0);
    expect(await n('audit_events')).toBe(audits);
  });

  it('resolveApproval: forced audit failure rolls back the status change', async () => {
    const inv = await invoice('part_paid');
    const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 100), idempotencyKey: 'atom-res' });
    if (r.kind !== 'pending') throw new Error(r.kind);
    const audits = await n('audit_events');
    await expect(resolveApproval(auditFailing(db), { ...admin, approvalId: r.approvalId, decision: 'approve' }))
      .rejects.toThrow('forced audit failure');
    const row = (await ctx.client.query<{ status: string; resolved_by: string | null }>('select status, resolved_by from approvals where id = $1', [r.approvalId])).rows[0];
    expect(row).toEqual({ status: 'pending', resolved_by: null });
    expect(await n('audit_events')).toBe(audits);
  });
});

describe('execute audit atomicity', () => {
  const approvalRow = async (id: string) => (await ctx.client.query<{ status: string; result: unknown; executed_at: Date | null }>(
    'select status, result, executed_at from approvals where id = $1', [id])).rows[0];

  it('executeApproval (success): forced audit failure rolls back the refund, the status claim and the result', async () => {
    const inv = await invoice('part_paid');
    const id = await approved('atom-exec-ok', refundArgs(inv.id, 100));
    const audits = await n('audit_events');
    await expect(executeApproval(auditFailing(db), id, admin)).rejects.toThrow('forced audit failure');
    expect(await approvalRow(id)).toEqual({ status: 'approved', result: null, executed_at: null });
    expect(await refundsFor(inv.id)).toBe(0);
    expect(await n('audit_events')).toBe(audits);
    // Nothing was lost: the approval can still be executed once the audit write works.
    expect((await executeApproval(db, id, admin)).kind).toBe('executed');
    expect(await refundsFor(inv.id)).toBe(1);
  });

  it('executeApproval (failed outcome): forced audit failure rolls back the failed claim', async () => {
    const inv = await invoice('part_paid');
    const id = await approved('atom-exec-fail', refundArgs(inv.id, inv.paid + 1));
    const audits = await n('audit_events');
    await expect(executeApproval(auditFailing(db), id, admin)).rejects.toThrow('forced audit failure');
    expect(await approvalRow(id)).toEqual({ status: 'approved', result: null, executed_at: null });
    expect(await n('audit_events')).toBe(audits);
  });
});

describe('every approvals path writes exactly one audit row', () => {
  it('create, repeat, resolve, execute, replay and each rejection add +1 audit row', async () => {
    const inv = await invoice('part_paid');
    const args = refundArgs(inv.id, 100);
    let approvalId = '';
    const steps: [string, () => Promise<unknown>][] = [
      ['create', async () => { const r = await requestWrite(db, { ...op, tool: 'issue_refund', args, idempotencyKey: 'one-row' }); if (r.kind !== 'pending') throw new Error(r.kind); approvalId = r.approvalId; }],
      ['repeat while pending', () => requestWrite(db, { ...op, tool: 'issue_refund', args, idempotencyKey: 'one-row' })],
      ['key reused with other args', () => requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 101), idempotencyKey: 'one-row' })],
      ['resolve', () => resolveApproval(db, { ...admin, approvalId, decision: 'approve' })],
      ['resolve again (not pending)', () => resolveApproval(db, { ...admin, approvalId, decision: 'approve' })],
      ['execute', () => executeApproval(db, approvalId, admin)],
      ['execute again (duplicate)', () => executeApproval(db, approvalId, admin)],
      ['request replay after execution', () => requestWrite(db, { ...op, tool: 'issue_refund', args, idempotencyKey: 'one-row' })],
      ['reader request denied', () => requestWrite(db, { ...reader, tool: 'issue_refund', args, idempotencyKey: 'one-row-r' })],
      ['invalid args', () => requestWrite(db, { ...op, tool: 'issue_refund', args: { invoice_id: inv.id }, idempotencyKey: 'one-row-bad' })],
      ['invalid caller', () => requestWrite(db, { actor: '', role: 'operator', tool: 'issue_refund', args, idempotencyKey: 'one-row-c' })],
      ['resolve not found', () => resolveApproval(db, { ...admin, approvalId: '00000000-0000-4000-8000-000000000000', decision: 'approve' })],
      ['resolve by non-admin', () => resolveApproval(db, { ...op, approvalId, decision: 'deny' })],
      ['execute by reader', () => executeApproval(db, approvalId, reader)],
      ['execute malformed id', () => executeApproval(db, 'nope', admin)],
    ];
    for (const [label, step] of steps) {
      const before = await n('audit_events');
      await step();
      expect(await n('audit_events'), label).toBe(before + 1);
    }
    expect(await n(`approvals where idempotency_key like 'one-row%'`)).toBe(1);
    expect(await refundsFor(inv.id)).toBe(1);
  });
});

describe('malformed approval ids (Codex P2)', () => {
  for (const bad of ['not-a-uuid', '', "1' or '1'='1", '00000000-0000-0000-0000-00000000000g']) {
    it(`resolve + execute reject ${JSON.stringify(bad)} as invalid_args with an audit row`, async () => {
      const before = await n('audit_events');
      expect(await resolveApproval(db, { ...admin, approvalId: bad, decision: 'approve' })).toEqual({ kind: 'invalid_args' });
      let a = await lastAudit();
      expect(a).toMatchObject({ outcome: 'error', error_code: 'invalid_args', approval_id: null });
      expect(await executeApproval(db, bad, admin)).toEqual({ kind: 'invalid_args' });
      a = await lastAudit();
      expect(a).toMatchObject({ outcome: 'error', error_code: 'invalid_args', approval_id: null });
      expect(await n('audit_events')).toBe(before + 2);
    });
  }
});

describe('runtime input hardening (Codex re-review)', () => {
  let shared: Awaited<ReturnType<typeof invoice>>;
  const sharedInv = async () => (shared ??= await invoice('unpaid'));
  for (const [label, key] of [['missing', undefined], ['empty', ''], ['blank', '   '], ['non-string', 42]] as const) {
    it(`rejects a ${label} idempotency key as invalid_args, audited, no approval`, async () => {
      const inv = await sharedInv();
      const approvalsBefore = await n('approvals');
      const auditBefore = await n('audit_events');
      const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 100), idempotencyKey: key as unknown as string });
      expect(r.kind).toBe('invalid_args');
      expect(await n('approvals')).toBe(approvalsBefore);
      expect(await n('audit_events')).toBe(auditBefore + 1);
      expect(await lastAudit()).toMatchObject({ outcome: 'error', error_code: 'invalid_args', approval_id: null });
    });
  }

  for (const decision of ['APPROVE', 'yes', '', null, 1]) {
    it(`rejects decision ${JSON.stringify(decision)} as invalid_args and leaves the approval pending`, async () => {
      const inv = await sharedInv();
      const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 100), idempotencyKey: `dec-${String(decision)}-${inv.id}` });
      if (r.kind !== 'pending') throw new Error(r.kind);
      const res = await resolveApproval(db, { ...admin, approvalId: r.approvalId, decision: decision as unknown as 'approve' });
      expect(res).toEqual({ kind: 'invalid_args' });
      expect(await lastAudit()).toMatchObject({ outcome: 'error', error_code: 'invalid_args' });
      const st = await ctx.client.query<{ status: string }>('select status from approvals where id = $1', [r.approvalId]);
      expect(st.rows[0].status).toBe('pending');
    });
  }

  it('refund remaining is exact above Number.MAX_SAFE_INTEGER (bigint end to end)', async () => {
    const inv = await invoice('part_paid');
    // 2^53 + 1 is not representable as a double; Number() would round it down to 2^53.
    // Fixture setup runs as the owner (PGlite shares one session with the app role), then drops back.
    await ctx.client.query('reset role');
    try {
      await ctx.client.query(`update invoices set total_paise = 9007199254740993, paid_paise = 9007199254740993 where id = $1`, [inv.id]);
    } finally {
      if (!process.env.DATABASE_URL) await ctx.client.query('set role meridian_app');
    }
    const id = await approved(`big-${inv.id}`, refundArgs(inv.id, Number.MAX_SAFE_INTEGER));
    const ex = await executeApproval(db, id, admin);
    expect(ex.kind).toBe('executed');
    if (ex.kind !== 'executed') return;
    expect(ex.result).toMatchObject({ remainingPaise: '2', invoiceRefunded: false });
    const st = await ctx.client.query<{ status: string }>('select status from invoices where id = $1', [inv.id]);
    expect(st.rows[0].status).not.toBe('refunded');
  });

  it('approval summary shows the exact paise that execution will use', async () => {
    const inv = await sharedInv();
    const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, Number.MAX_SAFE_INTEGER), idempotencyKey: `sum-max-${inv.id}` });
    if (r.kind !== 'pending') throw new Error(r.kind);
    expect(r.summary).toBe(`Refund ₹9,00,71,99,25,47,409.91 on ${inv.number}`);
  });

  it('rejects an idempotency key over 200 UTF-8 bytes as invalid_args, audited, no approval', async () => {
    const inv = await sharedInv();
    const ok = 'é'.repeat(100); // exactly 200 bytes
    expect((await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 103), idempotencyKey: ok })).kind).toBe('pending');
    for (const key of ['é'.repeat(101), 'k'.repeat(201), 'x'.repeat(100_000)]) {
      const approvalsBefore = await n('approvals');
      const auditBefore = await n('audit_events');
      const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 103), idempotencyKey: key });
      expect(r.kind).toBe('invalid_args');
      expect(await n('approvals')).toBe(approvalsBefore);
      expect(await n('audit_events')).toBe(auditBefore + 1);
      expect(await lastAudit()).toMatchObject({ outcome: 'error', error_code: 'invalid_args', approval_id: null });
    }
  });

  const badCallers: [string, Record<string, unknown>][] = [
    ['missing role', { actor: 'x' }], ['unknown role', { actor: 'x', role: 'root' }],
    ['missing actor', { role: 'admin' }], ['blank actor', { actor: '  ', role: 'admin' }],
    ['non-string correlationId', { actor: 'x', role: 'admin', correlationId: 7 }],
  ];
  for (const [label, bad] of badCallers) {
    it(`invalid caller metadata (${label}) is audited with placeholders and returns invalid_args on every entry point`, async () => {
      const inv = await sharedInv();
      const p = await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 104), idempotencyKey: `caller-${label}` });
      if (p.kind !== 'pending') throw new Error(p.kind);
      const calls = [
        () => requestWrite(db, { ...bad, tool: 'issue_refund', args: refundArgs(inv.id, 105), idempotencyKey: `caller-bad-${label}` } as never),
        () => resolveApproval(db, { ...bad, approvalId: p.approvalId, decision: 'approve' } as never),
        () => executeApproval(db, p.approvalId, bad as never),
      ];
      for (const call of calls) {
        const auditBefore = await n('audit_events');
        expect((await call()).kind).toBe('invalid_args');
        expect(await n('audit_events')).toBe(auditBefore + 1);
        const a = await ctx.client.query<{ actor: string; role: string; outcome: string; error_code: string }>(
          'select actor, role, outcome, error_code from audit_events order by created_at desc, ctid desc limit 1');
        expect(a.rows[0]).toEqual({ actor: 'unknown', role: 'invalid', outcome: 'error', error_code: 'invalid_args' });
      }
      const st = await ctx.client.query<{ status: string }>('select status from approvals where id = $1', [p.approvalId]);
      expect(st.rows[0].status).toBe('pending');
    });
  }

  for (const tool of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    it(`inherited name ${tool} as tool is an audited tool_not_supported denial`, async () => {
      const auditBefore = await n('audit_events');
      const r = await requestWrite(db, { ...op, tool: tool as never, args: {}, idempotencyKey: `proto-${tool}` });
      expect(r).toEqual({ kind: 'denied', reason: 'tool_not_supported' });
      expect(await n('audit_events')).toBe(auditBefore + 1);
      expect(await lastAudit()).toMatchObject({ outcome: 'denied', error_code: 'tool_not_supported' });
    });
  }

  for (const [label, req] of [['null', null], ['undefined', undefined], ['a number', 5]] as const) {
    it(`requestWrite with ${label} as the whole request is audited with placeholders and returns invalid_args`, async () => {
      const auditBefore = await n('audit_events');
      expect((await requestWrite(db, req as never)).kind).toBe('invalid_args');
      expect(await n('audit_events')).toBe(auditBefore + 1);
      expect(await lastAudit()).toMatchObject({ outcome: 'error', error_code: 'invalid_args' });
      const a = await ctx.client.query<{ actor: string; role: string }>('select actor, role from audit_events order by created_at desc, ctid desc limit 1');
      expect(a.rows[0]).toEqual({ actor: 'unknown', role: 'invalid' });
    });
  }

  it('non-JSON-safe and cyclic rejected arguments still produce an audit row and invalid_args', async () => {
    const inv = await sharedInv();
    const cyclic: Record<string, unknown> = { invoice_id: inv.id, amount_paise: 100, reason: 'x' };
    cyclic.self = cyclic;
    for (const args of [{ invoice_id: inv.id, amount_paise: 1n, reason: 'x' }, cyclic, { invoice_id: inv.id, amount_paise: 100, reason: 'x', fn: () => 1 }]) {
      const auditBefore = await n('audit_events');
      const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: args as never, idempotencyKey: `unsafe-${auditBefore}` });
      expect(r.kind).toBe('invalid_args');
      expect(await n('audit_events')).toBe(auditBefore + 1);
      expect(await lastAudit()).toMatchObject({ outcome: 'error', error_code: 'invalid_args' });
    }
    const a = await ctx.client.query<{ arguments: Record<string, unknown> }>(`select arguments from audit_events where idempotency_key like 'unsafe-%' order by created_at, ctid`);
    expect(a.rows[0].arguments.amount_paise).toBe('1n');
    expect(a.rows[1].arguments.self).toBe('[circular]');
    expect(a.rows[2].arguments.fn).toBe('[function]');
  });

  it('shared-reference argument graphs are audited within a global traversal budget', async () => {
    const inv = await sharedInv();
    // 8 levels x 100 keys all pointing at the next level: ~100^8 paths without a global budget.
    let next: Record<string, unknown> = { leaf: true };
    for (let lvl = 0; lvl < 8; lvl++) {
      const o: Record<string, unknown> = {};
      for (let k = 0; k < 100; k++) o[`k${k}`] = next;
      next = o;
    }
    const auditBefore = await n('audit_events');
    const t0 = performance.now();
    const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: { invoice_id: inv.id, amount_paise: 100, reason: 'x', graph: next } as never, idempotencyKey: 'shared-graph' });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r.kind).toBe('invalid_args');
    expect(await n('audit_events')).toBe(auditBefore + 1);
    expect(await lastAudit()).toMatchObject({ outcome: 'error', error_code: 'invalid_args' });
  });

  it('an own __proto__ key in rejected arguments is kept in the audit row', async () => {
    const inv = await sharedInv();
    const args = JSON.parse(`{"invoice_id":"${inv.id}","amount_paise":100,"reason":"x","__proto__":{"hidden":"payload"}}`);
    const r = await requestWrite(db, { ...op, tool: 'issue_refund', args, idempotencyKey: 'own-proto' });
    expect(r.kind).toBe('invalid_args');
    const a = await ctx.client.query<{ arguments: Record<string, unknown> }>(`select arguments from audit_events where idempotency_key = 'own-proto'`);
    expect(Object.hasOwn(a.rows[0].arguments, '__proto__')).toBe(true);
    expect(JSON.stringify(a.rows[0].arguments)).toContain('"hidden":"payload"');
  });

  it('NUL characters in actor, correlationId, key, tool or args are audited rejections, never a thrown insert', async () => {
    const inv = await sharedInv();
    const p = await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 106), idempotencyKey: 'nul-target' });
    if (p.kind !== 'pending') throw new Error(p.kind);
    const cases: [() => Promise<{ kind: string }>, string][] = [
      [() => requestWrite(db, { actor: 'a\u0000b', role: 'operator', tool: 'issue_refund', args: refundArgs(inv.id, 107), idempotencyKey: 'nul-actor' }), 'invalid_args'],
      [() => requestWrite(db, { ...op, correlationId: 'c\u0000', tool: 'issue_refund', args: refundArgs(inv.id, 107), idempotencyKey: 'nul-corr' }), 'invalid_args'],
      [() => resolveApproval(db, { actor: 'a\u0000', role: 'admin', approvalId: p.approvalId, decision: 'approve' }), 'invalid_args'],
      [() => executeApproval(db, p.approvalId, { actor: 'a\u0000', role: 'admin' }), 'invalid_args'],
      [() => requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 107), idempotencyKey: 'k\u0000' }), 'invalid_args'],
      [() => requestWrite(db, { ...op, tool: 'issue_\u0000refund' as never, args: {}, idempotencyKey: 'nul-tool' }), 'denied'],
      [() => requestWrite(db, { ...op, tool: 'issue_refund', args: { ...refundArgs(inv.id, 107), reason: 'r\u0000' }, idempotencyKey: 'nul-reason' }), 'invalid_args'],
    ];
    for (const [call, kind] of cases) {
      const auditBefore = await n('audit_events');
      expect((await call()).kind).toBe(kind);
      expect(await n('audit_events')).toBe(auditBefore + 1);
    }
  });

  it('lone surrogates in rejected args or the reason are audited rejections, never a thrown jsonb insert', async () => {
    const inv = await sharedInv();
    const cases = [
      { ...refundArgs(inv.id, 108), extra: 'x\uD800y' },
      { ...refundArgs(inv.id, 108), ['k\uDC00']: 1 },
      { ...refundArgs(inv.id, 108), extra: `${'a'.repeat(199)}\uD83D\uDE00` }, // pair split by the 200-char cut
      { ...refundArgs(inv.id, 108), reason: 'r\uD800' },
    ];
    for (const [i, args] of cases.entries()) {
      const auditBefore = await n('audit_events');
      const r = await requestWrite(db, { ...op, tool: 'issue_refund', args, idempotencyKey: `surrogate-${i}` });
      expect(r.kind).toBe('invalid_args');
      expect(await n('audit_events')).toBe(auditBefore + 1);
    }
  });

  it('keys that collide after sanitizing are all kept in the audit row', async () => {
    const inv = await sharedInv();
    const args = { ...refundArgs(inv.id, 109), ['a\u0000']: 'first', ['a\uFFFD']: 'second' };
    expect((await requestWrite(db, { ...op, tool: 'issue_refund', args, idempotencyKey: 'key-collide' })).kind).toBe('invalid_args');
    const a = await ctx.client.query<{ arguments: Record<string, unknown> }>(`select arguments from audit_events where idempotency_key = 'key-collide'`);
    expect(Object.values(a.rows[0].arguments)).toEqual(expect.arrayContaining(['first', 'second']));
  });

  it('a lone surrogate in actor cannot alias the requester to bypass self-approval', async () => {
    const inv = await sharedInv();
    const r = await requestWrite(db, { actor: 'eve\uFFFD', role: 'admin', tool: 'issue_refund', args: refundArgs(inv.id, 110), idempotencyKey: 'alias-actor' });
    if (r.kind !== 'pending') throw new Error(r.kind);
    const auditBefore = await n('audit_events');
    // Would previously be treated as a different actor and approved.
    expect(await resolveApproval(db, { actor: 'eve\uD800', role: 'admin', approvalId: r.approvalId, decision: 'approve' })).toEqual({ kind: 'invalid_args' });
    expect(await n('audit_events')).toBe(auditBefore + 1);
    expect(await lastAudit()).toMatchObject({ outcome: 'error', error_code: 'invalid_args' });
    const st = await ctx.client.query<{ status: string }>('select status from approvals where id = $1', [r.approvalId]);
    expect(st.rows[0].status).toBe('pending');
    expect((await requestWrite(db, { actor: 'x\uDC00', role: 'operator', tool: 'issue_refund', args: refundArgs(inv.id, 110), idempotencyKey: 'alias-actor-2' })).kind).toBe('invalid_args');
    expect((await executeApproval(db, r.approvalId, { actor: 'y\uD800', role: 'admin' })).kind).toBe('invalid_args');
  });

  it('idempotency keys with lone surrogates are rejected so they cannot alias U+FFFD keys', async () => {
    const inv = await sharedInv();
    expect((await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 111), idempotencyKey: 'alias-\uFFFD' })).kind).toBe('pending');
    const approvalsBefore = await n('approvals');
    const auditBefore = await n('audit_events');
    const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 112), idempotencyKey: 'alias-\uD800' });
    expect(r.kind).toBe('invalid_args');
    expect(await n('approvals')).toBe(approvalsBefore);
    expect(await n('audit_events')).toBe(auditBefore + 1);
  });

  it('unsafe handler results and errors are persisted JSON-safe: executed/failed + audit always commit', async () => {
    const inv = await sharedInv();
    const base = defaultHandlers.issue_refund as NonNullable<HandlerMap['issue_refund']>;
    const cyclic: Record<string, unknown> = { big: 12345678901234567890n, nul: 'a\u0000b', lone: 'c\uD800' };
    cyclic.self = cyclic;
    const variants: [string, HandlerMap['issue_refund'], 'executed' | 'failed'][] = [
      ['result', { ...base, execute: async () => ({ ok: true, result: cyclic }) }, 'executed'],
      ['returned-error', { ...base, execute: async () => ({ ok: false, error: 'bad\u0000\uDC00' }) }, 'failed'],
      ['thrown-error', { ...base, execute: async () => { throw new Error('boom\u0000\uD800'); } }, 'failed'],
    ];
    for (const [label, handler, want] of variants) {
      const handlers: HandlerMap = { issue_refund: handler };
      const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 113), idempotencyKey: `unsafe-out-${label}` }, handlers);
      if (r.kind !== 'pending') throw new Error(r.kind);
      await resolveApproval(db, { ...admin, approvalId: r.approvalId, decision: 'approve' });
      const ex = await executeApproval(db, r.approvalId, admin, handlers);
      expect(ex.kind).toBe(want);
      const row = await ctx.client.query<{ status: string; result: Record<string, unknown> }>('select status, result from approvals where id = $1', [r.approvalId]);
      expect(row.rows[0].status).toBe(want);
      const a = await lastAudit();
      expect(a).toMatchObject({ approval_id: r.approvalId, outcome: want === 'executed' ? 'ok' : 'error' });
      if (label === 'result') expect(row.rows[0].result).toMatchObject({ big: '12345678901234567890n', nul: 'a\uFFFDb', lone: 'c\uFFFD', self: '[circular]' });
      else expect(JSON.stringify(row.rows[0].result)).not.toMatch(/\\u0000/);
    }
  });

  it('a handler query error is stored as the driver message, without the statement or its parameters', async () => {
    const inv = await sharedInv();
    const base = defaultHandlers.issue_refund as NonNullable<HandlerMap['issue_refund']>;
    const handlers: HandlerMap = {
      issue_refund: { ...base, execute: async (tx) => { await tx.execute(sql`update orders set total_paise = ${987654321}`); return { ok: true, result: {} }; } },
    };
    const r = await requestWrite(db, { ...op, tool: 'issue_refund', args: refundArgs(inv.id, 114), idempotencyKey: 'driver-error' }, handlers);
    if (r.kind !== 'pending') throw new Error(r.kind);
    await resolveApproval(db, { ...admin, approvalId: r.approvalId, decision: 'approve' });
    const ex = await executeApproval(db, r.approvalId, admin, handlers);
    if (ex.kind !== 'failed') throw new Error(ex.kind);
    expect(ex.error).toMatch(/permission denied/);
    expect(ex.error).not.toMatch(/Failed query|update orders|987654321/);
    expect((await lastAudit()).error_code).toBe(ex.error);
  });
});
