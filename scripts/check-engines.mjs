#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
const nvm = readFileSync(resolve(process.cwd(), '.nvmrc'), 'utf8').trim();
const engine = pkg.engines?.node;
if (!engine) { console.error('No engines.node in package.json'); process.exit(1); }
const runtime = process.versions.node;
const ok = (a, b) => a === b;
if (!ok(engine, nvm)) {
  console.error(`Mismatch: package.json engines.node=${engine} vs .nvmrc=${nvm}`);
  process.exit(1);
}
if (!ok(engine, runtime)) {
  console.error(`Mismatch: engines.node=${engine} vs runtime=${runtime}`);
  process.exit(1);
}
console.log('check-engines: OK', engine);

