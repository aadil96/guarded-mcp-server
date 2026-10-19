import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// AGENTS.md's rule table must point at enforcers that exist and run: a vitest file, a type test that
// `pnpm typecheck` compiles, a script CI runs, or a migration in the journal.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const HEAD = '# Agents\n\nIntro.\n\n## Rules and enforcers\n\nProse.\n\n| Rule | Enforced by |\n| --- | --- |\n';
const base: Record<string, string> = {
  'package.json': JSON.stringify({ scripts: { 'check:x': 'node scripts/check-x.mjs', 'check:unused': 'node scripts/unused.mjs' } }),
  '.github/workflows/ci.yml': 'steps:\n  - run: pnpm check:x\n  - run: pnpm typecheck\n  - run: pnpm test --reporter=verbose\n',
  'drizzle/meta/_journal.json': JSON.stringify({ entries: [{ idx: 0, tag: '0000_init' }] }),
  'drizzle/0000_init.sql': 'select 1;',
  'drizzle/0001_unjournaled.sql': 'select 1;',
  'scripts/check-x.mjs': '',
  'scripts/unused.mjs': '',
  'src/thing.ts': '',
  'test/thing.test.ts': '',
  'test/types/thing-types.ts': '',
};

function check(table: string, extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agentsmd-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries({ ...base, 'AGENTS.md': table, ...extra })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const r = spawnSync(process.execPath, ['scripts/check-agents-md-enforcers.mjs', root], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('check-agents-md-enforcers', () => {
  it('passes on this repo', () => {
    const r = spawnSync(process.execPath, ['scripts/check-agents-md-enforcers.mjs'], { encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it('accepts every kind of running enforcer, and rows can be appended later', () => {
    const r = check(`${HEAD}| A | \`src/thing.ts\`, \`test/thing.test.ts\` |\n| B | \`scripts/check-x.mjs\` |\n| C | \`drizzle/0000_init.sql\` |\n| D | \`test/types/thing-types.ts\` |\n| Added later | \`test/thing.test.ts\` |\n\nTrailing prose.\n`);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/5 rules/);
  });

  it.each([
    ['a missing path', '| A | `test/gone.test.ts` |', /A: test\/gone\.test\.ts does not exist/],
    ['a row with no path', '| A | the framework |', /A: list enforcers as backticked repo paths/],
    ['prose mixed into the paths', '| A | `test/thing.test.ts` and CI |', /A: list enforcers as backticked repo paths/],
    ['an empty rule', '|  | `test/thing.test.ts` |', /row 1: empty rule/],
    ['only non-running files', '| A | `src/thing.ts` |', /A: nothing here runs/],
    ['a script CI never runs', '| A | `scripts/unused.mjs` |', /A: scripts\/unused\.mjs is not run by CI/],
    ['a migration not in the journal', '| A | `drizzle/0001_unjournaled.sql` |', /A: drizzle\/0001_unjournaled\.sql is not in drizzle\/meta\/_journal\.json/],
    ['a directory instead of a file', '| A | `test` |', /A: test is not a file/],
    ['an extra column', '| A | `test/thing.test.ts` | x |', /row 1: expected 2 columns/],
  ])('fails on %s', (_name, row, msg) => {
    const r = check(`${HEAD}${row}\n`);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(msg);
  });

  it('fails when the section or its table is missing or empty', () => {
    expect(check('# Agents\n\nNo table.\n').out).toMatch(/no "## Rules and enforcers" section/);
    expect(check(HEAD).out).toMatch(/the table has no rows/);
    expect(check('# Agents\n\n## Rules and enforcers\n\n| Rule | Enforcer | Path |\n| --- | --- | --- |\n| A | x | `test/thing.test.ts` |\n').out)
      .toMatch(/header must be "\| Rule \| Enforced by \|"/);
  });
});
