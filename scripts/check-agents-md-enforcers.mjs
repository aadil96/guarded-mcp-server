#!/usr/bin/env node
// Fails CI unless every rule in AGENTS.md's "## Rules and enforcers" table points at enforcers that exist
// and actually run. Each row is `| Rule | Enforced by |`, the second cell a comma-separated list of
// backticked repo paths. A row needs at least one running enforcer:
//  - test/**/*.test.ts (run by `pnpm test` in CI), or test/types/*.ts (compiled by `pnpm typecheck` in CI);
//  - scripts/* run by a CI workflow, directly or through a package.json script;
//  - drizzle/NNNN_*.sql listed in drizzle/meta/_journal.json (applied by migrate).
// Other paths (src/...) may be listed for context but do not count as enforcement on their own.
// Usage: node scripts/check-agents-md-enforcers.mjs [repoRoot]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const errors = [];

const wfDir = join(root, '.github/workflows');
const workflows = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => read(`.github/workflows/${f}`)).join('\n') : '';
const scripts = JSON.parse(read('package.json')).scripts ?? {};
const ciRuns = (name) => new RegExp(`\\bpnpm\\s+(?:run\\s+)?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'm').test(workflows);
const journal = existsSync(join(root, 'drizzle/meta/_journal.json'))
  ? new Set(JSON.parse(read('drizzle/meta/_journal.json')).entries.map((e) => e.tag)) : new Set();

/** Why `path` runs in CI, or a reason it does not (null when it is context only). */
function runs(path) {
  if (/^test\/types\/[^/]+\.ts$/.test(path)) return ciRuns('typecheck') ? true : `${path} is a type test but CI does not run pnpm typecheck`;
  if (/^test\/.+\.test\.ts$/.test(path)) return ciRuns('test') ? true : `${path} is a test but CI does not run pnpm test`;
  if (path.startsWith('scripts/')) {
    const wired = workflows.includes(path) || Object.entries(scripts).some(([name, cmd]) => cmd.includes(path) && ciRuns(name));
    return wired ? true : `${path} is not run by CI (no workflow step runs it, directly or via a package.json script)`;
  }
  const m = /^drizzle\/(\d{4}_[^/]+)\.sql$/.exec(path);
  if (m) return journal.has(m[1]) ? true : `${path} is not in drizzle/meta/_journal.json, so migrate never applies it`;
  return null;
}

const md = read('AGENTS.md').split('\n');
const start = md.findIndex((l) => l.trim() === '## Rules and enforcers');
if (start < 0) errors.push('AGENTS.md: no "## Rules and enforcers" section');
else {
  const body = md.slice(start + 1);
  const end = body.findIndex((l) => /^#{1,2} /.test(l));
  const table = (end < 0 ? body : body.slice(0, end)).filter((l) => l.trim().startsWith('|'));
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  if (!table.length || cells(table[0]).join('|') !== 'Rule|Enforced by') errors.push('AGENTS.md: the table header must be "| Rule | Enforced by |"');
  else {
    const rows = table.slice(2);
    if (!rows.length) errors.push('AGENTS.md: the table has no rows');
    for (const [i, line] of rows.entries()) {
      const c = cells(line);
      if (c.length !== 2) { errors.push(`row ${i + 1}: expected 2 columns, got ${c.length}`); continue; }
      const [rule, cell] = c;
      if (!rule) { errors.push(`row ${i + 1}: empty rule`); continue; }
      if (!/^`[^`]+`(\s*,\s*`[^`]+`)*$/.test(cell)) { errors.push(`${rule}: list enforcers as backticked repo paths, comma-separated`); continue; }
      const paths = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      let running = 0;
      for (const p of paths) {
        if (!existsSync(join(root, p))) { errors.push(`${rule}: ${p} does not exist`); continue; }
        if (!statSync(join(root, p)).isFile()) { errors.push(`${rule}: ${p} is not a file`); continue; }
        const r = runs(p);
        if (r === true) running++;
        else if (r) errors.push(`${rule}: ${r}`);
      }
      if (!running && !errors.some((e) => e.startsWith(`${rule}:`))) errors.push(`${rule}: nothing here runs (add a test, a CI-run script or a journaled migration)`);
    }
    if (!errors.length) console.log(`check-agents-md-enforcers: OK (${rows.length} rules)`);
  }
}

if (errors.length) {
  console.error(`check-agents-md-enforcers:\n${errors.map((e) => ` - ${e}`).join('\n')}`);
  process.exit(1);
}
