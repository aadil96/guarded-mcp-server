import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callerFromEnv } from '../src/audit/log.js';
import { APP_ROLE, appDb, createAppPool } from '../src/db/connect.js';
import { seed, seedId } from '../src/db/seed.js';
import type { Db } from '../src/db/types.js';
import { callTool } from '../src/server.js';
import type { readTools } from '../src/tools/read.js';
import { freshDb } from './helpers.js';

// The server's own db handle: on real PG (CI) the production createAppPool(); on PGlite the
// same SET ROLE issued on the single connection. Seeding happens first, as the owner.
let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: Db;
let close = async () => {};

beforeAll(async () => {
  ctx = await freshDb();
  await seed(ctx.db);
  if (ctx.url) {
    const pool = createAppPool(ctx.url);
    db = appDb(pool);
    close = () => pool.end();
  } else {
    await ctx.client.query(`SET ROLE ${APP_ROLE}`);
    db = ctx.db;
  }
});
afterAll(async () => { await close(); });

const run = (q: string) => db.execute(sql.raw(q));

describe(`server db connection runs as ${APP_ROLE}`, () => {
  it('is the app role, not the owner', async () => {
    const r = await run('select current_user as u');
    expect((r as unknown as { rows: { u: string }[] }).rows[0].u).toBe(APP_ROLE);
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
