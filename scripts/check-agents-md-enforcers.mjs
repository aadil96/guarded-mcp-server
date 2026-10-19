#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const md = readFileSync(resolve(process.cwd(), 'AGENTS.md'), 'utf8');
const rows = [];
let inTable = false;
for (const line of md.split('\n')) {
  if (line.startsWith('|') && line.includes('|')) {
    if (line.includes('---')) { inTable = true; continue; }
    if (!inTable) continue;
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length >= 4) {
      const path = parts[3];
      if (path && path !== 'Enforcer') rows.push(path);
    }
  } else if (inTable && line.trim() === '') {
    break;
  }
}
const missing = rows.filter((p) => !existsSync(resolve(process.cwd(), p)));
if (missing.length) {
  console.error('AGENTS.md enforcer paths missing:\n' + missing.map((p) => ` - ${p}`).join('\n'));
  process.exit(1);
}
console.log('check-agents-md-enforcers: OK');

