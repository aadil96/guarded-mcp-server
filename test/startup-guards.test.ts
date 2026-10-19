import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { freshDb } from './helpers.js';
import { connectAsApp } from '../src/db/index.js';

describe.runIf(process.env.DATABASE_URL)('owner connection mistake vs app role', () => {
  it('raw owner pool reports current_user != meridian_app; AppDb reports meridian_app', async () => {
    const ctx = await freshDb();
    try {
      // Owner session created by freshDb() is the login user.
      const whoOwner = await ctx.client.query<{ u: string }>('select current_user u');
      expect(whoOwner.rows[0].u).not.toBe('meridian_app');
      const app = await connectAsApp(ctx.url as string);
      const whoApp = await (app as any).execute({ query: 'select current_user u' });
      expect((whoApp as { rows: { u: string }[] }).rows[0].u).toBe('meridian_app');
      if (typeof (app as any).close === 'function') await (app as any).close();
    } finally {
      await ctx.client.close();
    }
  });
});

describe('server refuses to start without DATABASE_URL', () => {
  it('pnpm start exits non-zero when DATABASE_URL is missing', async () => {
    const child = spawn('pnpm', ['-s', 'start'], { env: { ...process.env, DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const [code] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    expect(code).not.toBe(0);
  });
});

