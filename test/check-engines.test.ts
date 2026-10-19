import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// One Node version story: .nvmrc pins the exact version CI runs (setup-node reads .nvmrc), package.json
// engines.node is the compatible range contributors need locally, and .nvmrc must sit inside that range.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const CI = (step: string) => `jobs:\n  test:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n${step}\n          cache: pnpm\n`;
const good = {
  engines: '>=22.12.0 <23',
  nvmrc: '22.23.3\n',
  ci: CI('          node-version-file: .nvmrc'),
};

function check(over: Partial<typeof good> = {}, args: string[] = []) {
  const f = { ...good, ...over };
  const root = mkdtempSync(join(tmpdir(), 'engines-'));
  dirs.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'x', engines: { node: f.engines } }),
    '.nvmrc': f.nvmrc,
    '.github/workflows/ci.yml': f.ci,
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const r = spawnSync(process.execPath, ['scripts/check-engines.mjs', root, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('check-engines', () => {
  it('passes on this repo with the pinned runtime, in both modes', () => {
    const pinned = readFileSync('.nvmrc', 'utf8').trim();
    for (const mode of [[], ['--exact']]) {
      const r = spawnSync(process.execPath, ['scripts/check-engines.mjs', '.', '--runtime', pinned, ...mode], { encoding: 'utf8' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    }
  });

  it('accepts quoted values and a second, correctly configured setup-node step', () => {
    const two = `${CI("          node-version-file: '.nvmrc'")}  other:\n    steps:\n      - name: node\n        uses: actions/setup-node@v4\n        with:\n          node-version-file: ".nvmrc" # pinned\n`;
    const r = check({ ci: two }, ['--runtime', '22.20.0']);
    expect(r.code, r.out).toBe(0);
  });

  it('locally a compatible runtime is enough; --exact (CI) requires the pinned version', () => {
    expect(check({}, ['--runtime', '22.20.0']).code).toBe(0);
    const exact = check({}, ['--runtime', '22.20.0', '--exact']);
    expect(exact.code).toBe(1);
    expect(exact.out).toMatch(/runtime 22\.20\.0 is not the pinned \.nvmrc version 22\.23\.3/);
    expect(check({}, ['--runtime', '22.23.3', '--exact']).code).toBe(0);
  });

  it.each([
    ['a runtime below the range', {}, ['--runtime', '20.19.2'], /runtime 20\.19\.2 does not satisfy engines\.node >=22\.12\.0 <23/],
    ['a runtime at the next major', {}, ['--runtime', '23.0.0'], /runtime 23\.0\.0 does not satisfy/],
    ['.nvmrc outside the range', { nvmrc: '22.11.0\n' }, ['--runtime', '22.20.0'], /\.nvmrc 22\.11\.0 does not satisfy engines\.node/],
    ['.nvmrc not an exact version', { nvmrc: '22\n' }, ['--runtime', '22.20.0'], /\.nvmrc must be an exact version/],
    ['.nvmrc with a v prefix', { nvmrc: 'v22.23.3\n' }, ['--runtime', '22.20.0'], /\.nvmrc must be an exact version/],
    ['engines.node pinned exactly', { engines: '22.23.3' }, ['--runtime', '22.23.3'], /engines\.node must be a range of the form/],
    ['engines.node missing', { engines: '' }, ['--runtime', '22.23.3'], /engines\.node must be a range of the form/],
    ['CI hard-codes node-version', { ci: CI('          node-version: 22') }, ['--runtime', '22.20.0'], /ci\.yml: setup-node must use node-version-file: \.nvmrc/],
    ['CI hard-codes it next to the file', { ci: CI('          node-version-file: .nvmrc\n          node-version: 22.23.3') }, ['--runtime', '22.20.0'], /ci\.yml: setup-node must use node-version-file: \.nvmrc/],
    ['.nvmrc only in another step', { ci: 'jobs:\n  test:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          cache: pnpm\n      - run: echo hi\n        env:\n          node-version-file: .nvmrc\n' }, ['--runtime', '22.20.0'], /ci\.yml: setup-node must use node-version-file: \.nvmrc/],
    ['the .nvmrc line commented out', { ci: CI('          # node-version-file: .nvmrc') }, ['--runtime', '22.20.0'], /ci\.yml: setup-node must use node-version-file: \.nvmrc/],
  ])('fails on %s', (_name, over, args, msg) => {
    const r = check(over, args);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(msg);
  });
});
