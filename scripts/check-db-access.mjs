#!/usr/bin/env node
// Fails CI if code outside the DB module can open its own connection or change role.
// Usage: node scripts/check-db-access.mjs [repoRoot]
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());
const SCAN = ['src', 'scripts', 'test'];
const EXTS = /\.(c|m)?[jt]sx?$/;

// Drivers and drizzle adapters. Importing any of them is how a second, unchecked connection gets made.
const DRIVER = String.raw`(?:pg|pg-pool|postgres|@electric-sql/pglite(?:/[\w./-]*)?|drizzle-orm/(?:node-postgres|pglite|postgres-js|neon[\w-]*|vercel-postgres|pg-proxy)(?:/[\w./-]*)?)`;
const DRIVER_IMPORT = new RegExp(
  String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"\x60]${DRIVER}['"\x60]`,
);
// Role switching anywhere but the DB module could undo SET ROLE meridian_app.
const ROLE_CHANGE = /\b(?:RESET\s+ROLE|SET\s+(?:SESSION\s+|LOCAL\s+)?ROLE|SET\s+SESSION\s+AUTHORIZATION|RESET\s+SESSION\s+AUTHORIZATION)\b/i;

// Exactly these files may import a driver: the app entrypoint, owner-only scripts, and the test fixture
// that creates throwaway databases as the owner.
const DRIVER_ALLOWED = new Set([
  'src/db/index.ts',
  'scripts/migrate.ts',
  'scripts/seed.ts',
  'scripts/verify-seed.ts',
  'test/helpers.ts',
]);
// Role changes are allowed in the DB module and in tests that set up or probe roles on purpose.
const roleAllowed = (rel) => rel === 'src/db/index.ts' || rel.startsWith('test/');
// The guard and its own test contain the banned patterns as data.
const SELF = new Set(['scripts/check-db-access.mjs', 'test/check-db-access.test.ts']);

function listFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : listFiles(p);
    return EXTS.test(e.name) ? [p] : [];
  });
}

const errors = [];
for (const file of SCAN.flatMap((d) => listFiles(join(root, d)))) {
  const rel = relative(root, file).replaceAll('\\', '/');
  if (SELF.has(rel)) continue;
  const text = readFileSync(file, 'utf8');
  if (!DRIVER_ALLOWED.has(rel) && DRIVER_IMPORT.test(text)) {
    errors.push(`${rel}: imports a database driver; use connectAsApp() from src/db/index.ts`);
  }
  if (!roleAllowed(rel) && ROLE_CHANGE.test(text)) {
    errors.push(`${rel}: changes the database role; only src/db/index.ts may`);
  }
}

if (errors.length) {
  console.error('check-db-access: restricted database access found:');
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}
console.log('check-db-access: OK');
