#!/usr/bin/env node
// One Node version story, checked in CI:
//  - .nvmrc pins the exact version CI runs (every setup-node step reads it with node-version-file).
//  - package.json engines.node is the compatible range a contributor needs locally: ">=X.Y.Z <M".
//  - .nvmrc must sit inside that range, and the running Node must satisfy it.
//  - With --exact (CI), the running Node must be exactly the .nvmrc version.
// Usage: node scripts/check-engines.mjs [repoRoot] [--exact] [--runtime <version>]  (--runtime is for tests)
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readWorkflows } from './lib/workflow.mjs';

const argv = process.argv.slice(2);
const exact = argv.includes('--exact');
const ri = argv.indexOf('--runtime');
const runtime = ri >= 0 ? argv[ri + 1] : process.versions.node;
const root = resolve(argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--runtime') ?? process.cwd());

const errors = [];
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const RANGE = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/;
const parse = (v) => VERSION.exec(v)?.slice(1).map(Number);
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const engine = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).engines?.node ?? '';
const range = RANGE.exec(engine)?.slice(1).map(Number);
if (!range) errors.push(`package.json engines.node must be a range of the form ">=X.Y.Z <M", got "${engine}"`);
const satisfies = (v) => range && cmp(v, range.slice(0, 3)) >= 0 && v[0] < range[3];

const nvmrc = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
const pinned = parse(nvmrc);
if (!pinned) errors.push(`.nvmrc must be an exact version like 22.23.3, got "${nvmrc}"`);
else if (range && !satisfies(pinned)) errors.push(`.nvmrc ${nvmrc} does not satisfy engines.node ${engine}`);

for (const [f, steps] of readWorkflows(root)) {
  // Each setup-node step must read .nvmrc itself, with no hard-coded version beside it.
  const bad = steps.some((st) => /^actions\/setup-node@/.test(st.uses ?? '') && (st.with['node-version-file'] !== '.nvmrc' || 'node-version' in st.with));
  if (bad) errors.push(`${f}: setup-node must use node-version-file: .nvmrc, with no node-version`);
}

const rt = parse(runtime ?? '');
if (!rt) errors.push(`cannot parse the runtime version "${runtime}"`);
else if (range && !satisfies(rt)) errors.push(`runtime ${runtime} does not satisfy engines.node ${engine}`);
else if (exact && pinned && cmp(rt, pinned) !== 0) errors.push(`runtime ${runtime} is not the pinned .nvmrc version ${nvmrc} (--exact)`);

if (errors.length) {
  console.error(`check-engines:\n${errors.map((e) => ` - ${e}`).join('\n')}`);
  process.exit(1);
}
console.log(`check-engines: OK (runtime ${runtime}, engines.node ${engine}, .nvmrc ${nvmrc}${exact ? ', exact' : ''})`);
