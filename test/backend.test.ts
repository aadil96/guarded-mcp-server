import { describe, expect, it } from 'vitest';
import { freshDb } from './helpers.js';

describe.runIf(process.env.DATABASE_URL)('test backend', () => {
  it('runs on a real Postgres 16 server, not PGlite', async () => {
    const { client } = await freshDb();
    const r = await client.query<{ v: string }>('show server_version');
    await client.close();
    expect(r.rows[0].v).toMatch(/^16\./);
  });
});
