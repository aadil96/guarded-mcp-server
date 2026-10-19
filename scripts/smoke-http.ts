// Starts the server (src/index.ts) with MCP_TRANSPORT=http on an ephemeral port and drives it with the SDK client:
// 401 without a token, read token lists every tool and is refused issue_refund, refund token gets a pending
// refund. Usage: pnpm smoke:http <invoice id>   (needs DATABASE_URL with migrated, seeded data)
import { spawn } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { mintToken } from '../src/auth/tokens.js';

const invoiceId = process.argv[2];
if (!invoiceId) throw new Error('usage: pnpm smoke:http <invoice id>');
const read = mintToken('smoke-reader', ['read']);
const refund = mintToken('smoke-operator', ['refund:request']);
const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  env: { ...process.env, MCP_TRANSPORT: 'http', MCP_HTTP_PORT: '0', MCP_HTTP_TOKENS: `${read.line}\n${refund.line}` },
  stdio: ['ignore', 'inherit', 'pipe'],
});
const timer = setTimeout(() => { console.error('timeout'); child.kill(); process.exit(1); }, 30_000);
const url = await new Promise<URL>((resolve, reject) => {
  let buf = '';
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    process.stderr.write(d);
    buf += d;
    const m = /listening on (\S+)/.exec(buf);
    if (m) resolve(new URL(m[1]));
  });
  child.once('exit', (code) => reject(new Error(`server exited early with ${code}`)));
});

const check = (ok: boolean, what: string) => { if (!ok) { console.error(`FAIL: ${what}`); child.kill(); process.exit(1); } };
const textOf = (r: { content: unknown }) => JSON.parse((r.content as { text: string }[])[0].text);
const connect = async (token: string) => {
  const c = new Client({ name: 'smoke-http', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
};

const anon = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
console.log('no token ->', anon.status, anon.headers.get('www-authenticate'));
check(anon.status === 401, 'unauthenticated request must be 401');

const r = await connect(read.token);
const tools = (await r.listTools()).tools.map((t) => t.name);
console.log('read token tools/list ->', tools.join(', '));
const inv = await r.callTool({ name: 'get_invoice', arguments: { invoice_id: invoiceId } });
console.log('read token get_invoice ->', textOf(inv).invoiceNumber);
const denied = await r.callTool({ name: 'issue_refund', arguments: { invoice_id: invoiceId, amount_paise: 100, reason: 'smoke', idempotency_key: `smoke-r-${Date.now()}` } });
console.log('read token issue_refund ->', JSON.stringify(textOf(denied)));
check(denied.isError === true && textOf(denied).error === 'insufficient_scope', 'read token must get insufficient_scope');
await r.close();

const o = await connect(refund.token);
const pending = await o.callTool({ name: 'issue_refund', arguments: { invoice_id: invoiceId, amount_paise: 100, reason: 'smoke', idempotency_key: `smoke-o-${Date.now()}` } });
console.log('refund token issue_refund ->', JSON.stringify(textOf(pending)));
check(!pending.isError && textOf(pending).status === 'pending_approval', 'refund token must get pending_approval');
await o.close();

child.removeAllListeners('exit');
child.kill('SIGTERM');
const [code, signal] = await new Promise<[number | null, string | null]>((res) => child.once('exit', (c, s) => res([c, s])));
clearTimeout(timer);
check(code === 0 && signal === null, `server must handle SIGTERM and exit 0 on its own (code ${code}, signal ${signal})`);
console.log(`server exited on SIGTERM (code ${code}, signal ${signal})`);
console.log('http smoke OK');
process.exit(0);
