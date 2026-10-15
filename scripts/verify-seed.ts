import pg from 'pg';

const expected: Record<string, number> = {
  customers: 12, products: 20, orders: 40, order_items: 100, invoices: 30, notes: 15,
};
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://meridian:meridian@localhost:5432/meridian' });
let failed = false;
try {
  for (const [table, want] of Object.entries(expected)) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    const ok = rows[0].n === want;
    if (!ok) failed = true;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${table}: ${rows[0].n} (want ${want})`);
  }
} finally {
  await pool.end();
}
if (failed) process.exit(1);
