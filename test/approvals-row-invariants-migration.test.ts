import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from './helpers.js';

// Migration 0004 adds the row invariants the typed approval parser relies on. A database upgraded from
// before 0004 may hold rows the old schema accepted but the new constraints refuse; the migration must
// backfill them so the upgrade applies and every row then parses. Runs the real migration file, as owner.
let ctx: Awaited<ReturnType<typeof freshDb>>;
const file = readdirSync('drizzle').find((f) => f.startsWith('0004_'));
const statements = () => readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
const q = <T>(text: string, p: unknown[] = []) => ctx.client.query<T>(text, p);

async function legacyRow(status: 'pending' | 'approved' | 'denied' | 'executed' | 'failed', set: string): Promise<string> {
  const id = randomUUID();
  await q(`insert into approvals (id, tool, idempotency_key, args_hash, arguments, summary, requested_by)
           values ($1, 'issue_refund', $2, repeat('a', 64), '{}'::jsonb, 'legacy', 'op')`, [id, `legacy-${id}`]);
  if (status === 'executed' || status === 'failed') await q(`update approvals set status = 'approved', resolved_by = 'adm' where id = $1`, [id]);
  if (status !== 'pending') await q(`update approvals set status = $2 where id = $1`, [id, status]);
  await q(`update approvals set ${set} where id = $1`, [id]);
  return id;
}

beforeAll(async () => { ctx = await freshDb(); });
afterAll(async () => { await ctx.client.close(); });

describe('migration 0004 (approvals row invariants)', () => {
  it('backfills rows the pre-0004 schema allowed, then adds both constraints', async () => {
    expect(file).toBeDefined();
    // Recreate the pre-0004 schema, then the rows it permitted.
    await q('alter table approvals drop constraint approvals_resolved_by_iff_resolved');
    await q('alter table approvals drop constraint approvals_result_only_when_final');
    const approvedNoBy = await legacyRow('approved', 'resolved_by = null');
    const executedNoBy = await legacyRow('executed', 'resolved_by = null');
    const pendingWithBy = await legacyRow('pending', `resolved_by = 'stray'`);
    const deniedWithResult = await legacyRow('denied', `result = '{"x":1}'::jsonb`);
    const executedOk = await legacyRow('executed', `result = '{"ok":true}'::jsonb`);

    for (const s of statements()) await q(s);

    const rows = new Map((await q<{ id: string; status: string; resolved_by: string | null; result: unknown }>(
      'select id, status, resolved_by, result from approvals')).rows.map((r) => [r.id, r]));
    expect(rows.get(approvedNoBy)).toMatchObject({ status: 'approved', resolved_by: 'unrecorded' });
    expect(rows.get(executedNoBy)).toMatchObject({ status: 'executed', resolved_by: 'unrecorded' });
    expect(rows.get(pendingWithBy)).toMatchObject({ status: 'pending', resolved_by: null });
    expect(rows.get(deniedWithResult)).toMatchObject({ status: 'denied', resolved_by: 'unrecorded', result: null });
    expect(rows.get(executedOk)).toMatchObject({ status: 'executed', resolved_by: 'adm', result: { ok: true } });

    const cons = (await q<{ conname: string }>(
      `select conname from pg_constraint where conrelid = 'approvals'::regclass and contype = 'c' order by conname`)).rows.map((r) => r.conname);
    expect(cons).toEqual(expect.arrayContaining(['approvals_resolved_by_iff_resolved', 'approvals_result_only_when_final']));
  });
});
