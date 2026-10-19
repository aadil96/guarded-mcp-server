import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function check(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'mcpreg-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const r = spawnSync(process.execPath, ['scripts/check-mcp-register.mjs', root], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('check-mcp-register', () => {
  it('passes on this repo', () => {
    const r = spawnSync(process.execPath, ['scripts/check-mcp-register.mjs'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });

  it.each([
    ['method call', `server.registerTool('x', {}, h);`],
    ['alias', 'const reg = server.registerTool.bind(server); reg("x", {}, h);'],
    ['bracket access', `server['registerTool']('x', {}, h);`],
    ['destructuring', 'const { registerTool } = server;'],
    ['prompt registration', `server.registerPrompt('p', {}, h);`],
    ['resource registration', `server.registerResource('r', 'u://x', {}, h);`],
    ['low-level request handler', `server.server.setRequestHandler(CallToolRequestSchema, h);`],
    ['fallback request handler', 'server.server.fallbackRequestHandler = h;'],
  ])('rejects a registration API used via %s outside the framework', (_name, line) => {
    const r = check({ 'src/tools/x.ts': line });
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/tools/x.ts: uses an MCP registration API');
  });

  it.each([
    ['.tool(', `server.tool('x', h);`],
    ['.prompt(', `server.prompt('x', h);`],
    ['.resource(', `server.resource('x', 'u://x', h);`],
    ["['tool']", `server['tool']('x', h);`],
  ])('rejects the legacy shorthand %s, even in the framework', (_name, line) => {
    for (const file of ['src/tools/x.ts', 'src/tools/framework.ts']) {
      const r = check({ [file]: line });
      expect(r.code, file).toBe(1);
      expect(r.out).toContain('legacy MCP registration shorthand');
    }
  });

  it('rejects a raw tools/call handler and a second server outside the allowed files', () => {
    expect(check({ 'src/x.ts': `if (msg.method === 'tools/call') run(msg);` }).out).toContain('handles a raw tools/* method');
    expect(check({ 'src/x.ts': `const s = new McpServer({ name: 'x', version: '0' });` }).out).toContain('constructs an MCP server');
    expect(check({ 'src/x.ts': `import { Server } from '@modelcontextprotocol/server';` }).out).toContain('constructs an MCP server');
    expect(check({ 'scripts/x.ts': `server.registerTool('x', {}, h);` }).code).toBe(1);
  });

  it('allows exactly the framework, the server constructor and the audit backstop', () => {
    expect(check({
      'src/tools/framework.ts': `server.registerTool(tool.name, {}, h);`,
      'src/server.ts': `const server = new McpServer({ name: 'x', version: '0' });`,
      'src/audit/transport.ts': `if (message.method === 'tools/call') pending.set(id, p);`,
      'src/tools/read.ts': 'export const readTools = [defineReadTool({ name: "x" })];',
    }).code).toBe(0);
    expect(check({ 'src/server.ts': `server.registerTool('x', {}, h);` }).code).toBe(1);
  });
});
