// Spawns `pnpm start`, sends initialize + tools/list + tools/call get_order over stdin, prints the replies.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const orderId = process.argv[2];
const child = spawn('pnpm', ['-s', 'start'], { stdio: ['pipe', 'pipe', 'inherit'] });
const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
const replies = new Map();
createInterface({ input: child.stdout }).on('line', (line) => {
  const m = JSON.parse(line);
  replies.set(m.id, m);
  if (m.id === 1) {
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_order', arguments: { order_id: orderId } } });
  }
  if (replies.has(2) && replies.has(3)) {
    console.log('initialize ->', replies.get(1).result.serverInfo, replies.get(1).result.protocolVersion);
    console.log('tools/list ->', replies.get(2).result.tools.map((t) => `${t.name}${t.annotations?.readOnlyHint ? ' (readOnly)' : ''}`).join(', '));
    console.log('tools/call get_order ->', replies.get(3).result.content[0].text);
    child.stdin.end();
    setTimeout(() => child.kill(), 2000).unref();
  }
});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
setTimeout(() => { console.error('timeout'); child.kill(); process.exit(1); }, 30000).unref();
