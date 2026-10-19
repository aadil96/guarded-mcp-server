import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callerFromEnv } from '../src/audit/log.js';
import { connectAsApp } from '../src/db/index.js';
import { seed, seedId } from '../src/db/seed.js';
import type { AppDb } from '../src/db/types.js';
import { callTool } from '../src/server.js';
import type { readTools } from '../src/tools/read.js';
import { freshDb } from './helpers.js';

// The server's own db handle: on real PG (CI) the production createAppPool(); on PGlite the
// same SET ROLE issued on the single connection. Seeding happens first, as the owner.
let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: AppDb;
let close = async () => {};

beforeAll(async () => {
  ctx = await freshDb();
  await seed(ctx.db);
  if (ctx.url) {
    db = await connectAsApp(ctx.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    close = async () => { if (typeof (db as any).close === 'function') await (db as any).close(); };
  } else {
    await ctx.client.query(`SET ROLE meridian_app`);
    db = ctx.db as unknown as AppDb;
  }
});
afterAll(async () => { await close(); });

const run = (q: string) => db.execute(sql.raw(q));

describe(`server db connection runs as meridian_app`, () => {
  it('is the app role, not the owner', async () => {
    const r = await run('select current_user as u');
    expect((r as unknown as { rows: { u: string }[] }).rows[0].u).toBe('meridian_app');
  });

  it('every read tool and its audit insert work under the app role', async () => {
    const caller = callerFromEnv({});
    const calls: [keyof typeof readTools, Record<string, unknown>][] = [
      ['list_customers', {}], ['get_customer', { customer_id: seedId('customer:1') }],
      ['list_orders', { status: 'pending' }], ['get_order', { order_id: seedId('order:1') }],
      ['list_invoices', {}], ['get_invoice', { invoice_id: seedId('invoice:1') }],
      ['search_orders', { query: 'ORD-00%' }], ['list_pending_approvals', {}],
    ];
    for (const [name, args] of calls) {
      const r = await callTool(db, caller, name, args);
      expect(r.isError, `${name}: ${r.content[0].text}`).not.toBe(true);
    }
    const n = await run('select count(*)::int as n from audit_events');
    expect((n as unknown as { rows: { n: number }[] }).rows[0].n).toBe(calls.length);
  });

  it('cannot UPDATE or DELETE audit_events', async () => {
    await expect(run(`update audit_events set tool = 'tampered'`)).rejects.toThrow();
    await expect(run('delete from audit_events')).rejects.toThrow();
  });

  it('cannot change order totals or insert customers', async () => {
    await expect(run('update orders set total_paise = 1')).rejects.toThrow();
    await expect(run(`insert into customers (id, name, city, gstin, phone, email) values (gen_random_uuid(), 'x', 'x', 'x', 'x', 'x')`)).rejects.toThrow();
  });
});

// Real PG only: PGlite is a single in-process session with no separate login roles.
describe.runIf(process.env.DATABASE_URL)('fails closed when SET ROLE is not allowed', () => {
  it('a login without meridian_app membership cannot obtain an AppDb', async () => {
    const login = `t_nomember_${Math.random().toString(36).slice(2, 10)}`;
    const dbName = new URL(ctx.url as string).pathname.slice(1);
    await ctx.client.query(`CREATE ROLE ${login} LOGIN PASSWORD 'pw'`);
    await ctx.client.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${login}`);
    // Give the login direct read access, so a silent fallback to the login user WOULD succeed.
    await ctx.client.query(`GRANT USAGE ON SCHEMA public TO ${login}`);
    await ctx.client.query(`GRANT SELECT ON orders TO ${login}`);
    const u = new URL(ctx.url as string);
    u.username = login;
    u.password = 'pw';
    await expect(connectAsApp(u.toString())).rejects.toThrow();
    try {
      await ctx.client.query(`REVOKE ALL ON orders FROM ${login}`);
      await ctx.client.query(`REVOKE ALL ON SCHEMA public FROM ${login}`);
      await ctx.client.query(`REVOKE ALL ON DATABASE ${dbName} FROM ${login}`);
      await ctx.client.query(`DROP ROLE ${login}`);
    // eslint-disable-next-line no-empty
    } finally {}
  });
});
