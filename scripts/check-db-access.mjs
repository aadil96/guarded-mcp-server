#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = process.cwd();

/** Returns a list of all files under dir with given extensions. */
function listFiles(dir, exts = ['.ts', '.tsx', '.js', '.mjs']) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listFiles(p, exts));
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

const allow = new Set([
  'src/db/index.ts',
  'src/db/types.ts',
  'src/db/schema.ts',
  'scripts/migrate.ts',
  'scripts/seed.ts',
]);

const banned = [
  { re: /\bnew\s+PGlite\s*\(/, msg: 'new PGlite() is only allowed in tests/helpers' },
  { re: /\bnew\s+pg\.Pool\s*\(/, msg: 'new pg.Pool() is restricted to src/db/index.ts' },
  { re: /\bdrizzle\s*\(/, msg: 'Direct drizzle(...) calls are restricted to src/db/index.ts' },
];

const errors = [];
for (const p of listFiles(join(repoRoot, 'src'))) {
  const rel = relative(repoRoot, p).replaceAll('\\', '/');
  if (allow.has(rel)) continue;
  const text = readFileSync(p, 'utf8');
  // Skip type-only imports of drizzle.
  for (const { re, msg } of banned) {
    const m = text.match(re);
    if (m) errors.push(`${rel}: ${msg}`);
  }
}

if (errors.length) {
  console.error('check-db-access found restricted DB access outside src/db/index.ts:');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
} else {
  console.log('check-db-access: OK');
}

