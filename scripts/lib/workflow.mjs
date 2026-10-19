// Minimal GitHub Actions workflow reader for the CI guards: per-step fields and the commands a step's
// `run` actually executes. Comments, step names, env values and echoed text never count.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Drops a YAML comment: `#` at the start or after whitespace, outside quotes. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}
const indent = (l) => /^ */.exec(l)[0].length;
const unquote = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
const KEY = /^(\s*)([\w.-]+):\s*(.*)$/;

/** Every step under any `steps:` key: { uses, name, run, with: { key: value } }. */
export function workflowSteps(text) {
  const lines = text.split('\n').map(stripComment);
  const steps = [];
  for (let i = 0; i < lines.length; i++) {
    const s = /^(\s*)steps:\s*$/.exec(lines[i]);
    if (!s) continue;
    const base = s[1].length;
    let item = -1;
    let cur = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) continue;
      const dash = /^(\s*)-\s+(.*)$/.exec(l);
      if (item < 0 && dash && dash[1].length >= base) item = dash[1].length;
      if (item < 0 || indent(l) < item || (indent(l) === item && !dash)) break;
      if (dash && dash[1].length === item) { cur = []; steps.push(cur); cur.push(' '.repeat(item + 2) + dash[2]); }
      else cur.push(l);
    }
  }
  return steps.map(parseStep);
}

function parseStep(lines) {
  const step = { with: {} };
  const k = indent(lines[0] ?? '');
  for (let i = 0; i < lines.length; i++) {
    const m = KEY.exec(lines[i]);
    if (!m || m[1].length !== k) continue;
    const [, , key, value] = m;
    const body = [];
    while (i + 1 < lines.length && indent(lines[i + 1]) > k) body.push(lines[++i]);
    if (key === 'with') {
      for (const b of body) { const w = KEY.exec(b); if (w) step.with[w[2]] = unquote(w[3]); }
    } else if (key === 'run') {
      step.run = /^[|>][-+]?$/.test(value.trim()) ? body.map((b) => b.trim()).join('\n') : unquote(value);
    } else if (key === 'uses' || key === 'name') {
      step[key] = unquote(value);
    }
  }
  return step;
}

/** Commands a run string executes: { pnpm: scriptName } or { file: path run by node/tsx }. */
export function invocations(run) {
  const out = [];
  for (const cmd of run.split(/\n|&&|\|\||;/)) {
    const t = cmd.trim().split(/\s+/).filter(Boolean);
    let k = 1;
    const skipFlags = () => { while (t[k]?.startsWith('-')) k++; };
    skipFlags();
    if (t[0] === 'pnpm') {
      if (t[k] === 'run') { k++; skipFlags(); }
      if (t[k]) out.push({ pnpm: t[k] });
    } else if (t[0] === 'node' || t[0] === 'tsx') {
      if (t[k]) out.push({ file: t[k].replace(/^\.\//, '') });
    }
  }
  return out;
}

/** [fileName, steps] for each workflow under root/.github/workflows. */
export function readWorkflows(root) {
  const dir = join(root, '.github/workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, workflowSteps(readFileSync(join(dir, f), 'utf8'))]);
}
