import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function check(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'dbaccess-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const r = spawnSync(process.execPath, ['scripts/check-db-access.mjs', root], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('check-db-access', () => {
  it('passes on this repo', () => {
    const r = spawnSync(process.execPath, ['scripts/check-db-access.mjs'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });

  it.each([
    ['default import', `import pg from 'pg';`],
    ['named import', `import { Pool } from "pg";`],
    ['dynamic import', 'const { Pool } = await import(`pg`);'],
    ['require', `const pg = require('pg');`],
    ['re-export', `export { Pool } from 'pg';`],
    ['side-effect import', `import 'pg';`],
    ['aliased drizzle adapter', `import { drizzle as d } from 'drizzle-orm/node-postgres';`],
    ['PGlite', `import { PGlite } from '@electric-sql/pglite';`],
    ['PGlite drizzle adapter', `import { drizzle } from 'drizzle-orm/pglite';`],
  ])('rejects a driver %s outside the DB module', (_name, line) => {
    const r = check({ 'src/tools/x.ts': line });
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/tools/x.ts: imports a database driver');
  });

  it('rejects role changes outside the DB module', () => {
    for (const q of ['RESET ROLE', 'set role meridian_owner', 'SET SESSION AUTHORIZATION x']) {
      const r = check({ 'src/approvals/x.ts': `await db.execute(sql\`${q}\`);` });
      expect(r.code, q).toBe(1);
      expect(r.out).toContain('src/approvals/x.ts: changes the database role');
    }
  });

  it('allows exactly the DB module, owner scripts and the test fixture', () => {
    const imp = `import pg from 'pg';`;
    expect(check({
      'src/db/index.ts': `${imp} await c.query('SET ROLE meridian_app');`,
      'scripts/migrate.ts': imp, 'scripts/seed.ts': imp, 'scripts/verify-seed.ts': imp, 'test/helpers.ts': imp,
      'src/db/types.ts': `import type { PgDatabase } from 'drizzle-orm/pg-core';`,
    }).code).toBe(0);
    expect(check({ 'src/db/other.ts': imp }).code).toBe(1);
    expect(check({ 'scripts/backfill.ts': imp }).code).toBe(1);
    expect(check({ 'test/some.test.ts': imp }).code).toBe(1);
  });
});
