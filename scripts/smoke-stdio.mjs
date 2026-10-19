// Spawns `pnpm start`, sends initialize + tools/list + tools/call get_order over stdin, prints the replies.
// Fails (exit 1) if the server exits early or non-zero, if a reply is missing or an error, or if the
// server does not exit cleanly on its own after stdin closes (e.g. a DB pool left open).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const orderId = process.argv[2];
const child = spawn('pnpm', ['-s', 'start'], { stdio: ['pipe', 'pipe', 'inherit'] });
const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
const replies = new Map();
let done = false;
const fail = (msg) => { console.error(`smoke: FAIL: ${msg}`); child.kill('SIGKILL'); process.exit(1); };
// Referenced on purpose: keeps the smoke process alive until the exchange and a clean exit both happen.
const deadline = setTimeout(() => fail(done ? 'server did not exit within 30s of stdin closing' : 'timed out waiting for replies'), 30000);

child.on('error', (e) => fail(`spawn error: ${e.message}`));
child.on('exit', (code, signal) => {
  if (!done) fail(`server exited early (code ${code}, signal ${signal}) after ${replies.size} replies`);
  if (code !== 0) fail(`server exited with code ${code}, signal ${signal} after stdin closed`);
  clearTimeout(deadline);
  console.log('server exited cleanly after stdin closed');
});

createInterface({ input: child.stdout }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { fail(`non-JSON line on stdout: ${line.slice(0, 200)}`); }
  if (m.error) fail(`reply ${m.id} is an error: ${JSON.stringify(m.error)}`);
  replies.set(m.id, m);
  if (m.id === 1) {
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_order', arguments: { order_id: orderId } } });
  }
  if (!done && replies.has(2) && replies.has(3)) {
    if (replies.get(3).result?.isError) fail(`get_order returned isError: ${JSON.stringify(replies.get(3).result)}`);
    console.log('initialize ->', replies.get(1).result.serverInfo, replies.get(1).result.protocolVersion);
    console.log('tools/list ->', replies.get(2).result.tools.map((t) => `${t.name}${t.annotations?.readOnlyHint ? ' (readOnly)' : ''}`).join(', '));
    console.log('tools/call get_order ->', replies.get(3).result.content[0].text);
    done = true;
    child.stdin.end(); // the server must now release its pool and exit 0 by itself
  }
});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
