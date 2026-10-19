#!/usr/bin/env node
// Fails CI if anything but the tool framework can register MCP handlers, or anything but src/server.ts can
// construct a server. Usage: node scripts/check-mcp-register.mjs [repoRoot]
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());
const SCAN = ['src', 'scripts'];
const EXTS = /\.(c|m)?[jt]sx?$/;

// Any mention of a registration API, in any form: method call, alias (`const r = s.registerTool`),
// bracket access (`s['registerTool']`), destructuring, or the low-level server's request handlers.
const REGISTER_API = /\b(?:registerTool|registerPrompt|registerResource|setRequestHandler|fallbackRequestHandler|removeRequestHandler|assertCanSetRequestHandler)\b/;
// The SDK's legacy shorthands: server.tool(...), server.prompt(...), server.resource(...), in dot or bracket form.
const LEGACY_API = /(?:\.\s*(?:tool|prompt|resource)\s*\(|\[\s*['"`](?:tool|prompt|resource)['"`]\s*\])/;
// Raw method names a hand-written handler would match on.
const RAW_METHOD = /['"`]tools\/(?:call|list)['"`]/;
// A second server instance, or the low-level Server class, would bypass the framework entirely.
const SERVER_CTOR = new RegExp([
  /\bnew\s+(?:[\w$]+\s*\.\s*)*(?:McpServer|Server)\b/.source,
  /\b(?:Server|McpServer)\s*\.\s*(?:prototype|call|apply)\b/.source,
  // Value imports of the server classes from any SDK entry point, aliased or not (`import type` is fine).
  /\bimport\s+(?!type\b)(?:[\w$]+\s*,\s*)?\{[^}]*?(?<!\btype\s+)\b(?:Mcp)?Server\b[^}]*\}\s*from\s*['"`]@modelcontextprotocol\//.source,
  // Namespace, default, dynamic and require imports of the server entry point, which expose the classes under any name.
  /\bimport\s+(?!type\b)(?:[\w$]+\s*,\s*)?\*\s*as\s+[\w$]+\s+from\s*['"`]@modelcontextprotocol\/(?:server|sdk)/.source,
  /\bimport\s+(?!type\b)[\w$]+\s+from\s*['"`]@modelcontextprotocol\/(?:server|sdk)/.source,
  /\b(?:import|require)\s*\(\s*['"`]@modelcontextprotocol\/(?:server|sdk)/.source,
  // Re-exports hand the classes on under another name, so any value re-export from the SDK counts.
  /\bexport\s+(?!type\b)(?:\*|\{[^}]*?(?<!\btype\s+)\b(?:Mcp)?Server\b[^}]*\})\s*(?:as\s+[\w$]+\s*)?from\s*['"`]@modelcontextprotocol\//.source,
].join('|'));

const RULES = [
  { re: REGISTER_API, allow: new Set(['src/tools/framework.ts']), msg: 'uses an MCP registration API; define tools with defineReadTool/defineWriteTool' },
  { re: LEGACY_API, allow: new Set(), msg: 'uses a legacy MCP registration shorthand (.tool/.prompt/.resource)' },
  // The transport audit backstop observes tools/call; the smoke script is a client.
  { re: RAW_METHOD, allow: new Set(['src/audit/transport.ts', 'scripts/smoke-stdio.mjs']), msg: 'handles a raw tools/* method; tools go through src/tools/framework.ts' },
  { re: SERVER_CTOR, allow: new Set(['src/server.ts']), msg: 'constructs an MCP server; only src/server.ts may' },
];
const SELF = 'scripts/check-mcp-register.mjs';

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
  if (rel === SELF) continue;
  const text = readFileSync(file, 'utf8');
  for (const { re, allow, msg } of RULES) if (!allow.has(rel) && re.test(text)) errors.push(`${rel}: ${msg}`);
}

if (errors.length) {
  console.error('check-mcp-register: MCP registration outside the tool framework:');
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}
console.log('check-mcp-register: OK');
