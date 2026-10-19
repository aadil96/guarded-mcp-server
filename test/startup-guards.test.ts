import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { closeAppDb, connectAsApp, queryRows } from '../src/db/index.js';
import { freshDb, startServer } from './helpers.js';

describe('fails closed without a database URL', () => {
  it('connectAsApp rejects a missing URL before opening a pool', async () => {
    await expect(connectAsApp(undefined)).rejects.toThrow('DATABASE_URL is required');
    await expect(connectAsApp('')).rejects.toThrow('DATABASE_URL is required');
  });

  it('the server exits 1 when DATABASE_URL is empty, with no PGlite fallback', async () => {
    const { code, stderr } = await startServer({ DATABASE_URL: '', MCP_DEV_PGLITE: '1' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/refusing to start, could not run as meridian_app: DATABASE_URL is required/);
  });
});

describe('HTTP transport fails closed on token config', () => {
  const hash = 'a'.repeat(64);
  it('exits 1 with no tokens configured, before touching the database', async () => {
    const { code, stderr } = await startServer({ MCP_TRANSPORT: 'http', MCP_HTTP_TOKENS: '', MCP_HTTP_TOKENS_FILE: '', DATABASE_URL: '' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/refusing to start, HTTP token config: no tokens configured/);
  });

  it('exits 1 on a malformed or admin-scoped token line, without echoing it', async () => {
    for (const cfg of ['gms_SECRETRAW alice read', `sha256:${hash} root admin`]) {
      const { code, stderr } = await startServer({ MCP_TRANSPORT: 'http', MCP_HTTP_TOKENS: cfg, DATABASE_URL: '' });
      expect(code).toBe(1);
      expect(stderr).toMatch(/refusing to start, HTTP token config: token config line 1/);
      expect(stderr).not.toContain('SECRETRAW');
    }
  });

  it('exits 1 on an unknown MCP_TRANSPORT', async () => {
    const { code } = await startServer({ MCP_TRANSPORT: 'websocket', DATABASE_URL: '' });
    expect(code).toBe(1);
  });
});

describe('fail-closed tests are not skipped in CI', () => {
  it('CI sets DATABASE_URL, so the real-Postgres suites run', () => {
    if (process.env.CI) expect(process.env.DATABASE_URL, 'CI must run against real Postgres').toBeTruthy();
  });
});

// The past mistake: serving on the owner login. The owner session is not meridian_app; connectAsApp is.
describe.runIf(process.env.DATABASE_URL)('owner login vs app role on real Postgres', () => {
  it('the owner session is not meridian_app, an AppDb from the same URL is', async () => {
    const ctx = await freshDb();
    try {
      const owner = await ctx.client.query<{ u: string }>('select current_user u');
      expect(owner.rows[0].u).not.toBe('meridian_app');
      const app = await connectAsApp(ctx.url);
      try {
        const [who] = await queryRows<{ u: string }>(app, sql`select current_user u`);
        expect(who.u).toBe('meridian_app');
      } finally {
        await closeAppDb(app);
      }
    } finally {
      await ctx.client.close();
    }
  });
});
