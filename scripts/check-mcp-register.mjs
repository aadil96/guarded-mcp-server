#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const repo = process.cwd();
const allow = new Set(['src/tools/framework.ts']);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const violations = [];
for (const p of walk(join(repo, 'src'))) {
  const rel = relative(repo, p).replaceAll('\\', '/');
  if (allow.has(rel)) continue;
  const text = readFileSync(p, 'utf8');
  if (text.includes('.registerTool(')) {
    violations.push(rel);
  }
}

if (violations.length) {
  console.error('Forbidden MCP registration found outside src/tools/framework.ts:');
  for (const v of violations) console.error(' -', v);
  process.exit(1);
} else {
  console.log('check-mcp-register: OK');
}

