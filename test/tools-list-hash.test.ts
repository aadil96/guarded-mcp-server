import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { createServer } from '../src/server.js';
import { AuditTracker, auditingTransport } from '../src/audit/transport.js';
import { freshDb } from './helpers.js';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

async function getToolsList(): Promise<unknown> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const tracker = new AuditTracker();
  const caller = { actor: 'snapshot', role: 'reader' as const };
  const ctx = await freshDb();
  const db = ctx.db as never;
  await createServer(db, caller, tracker).connect(auditingTransport(serverT, db, caller, tracker));
  const pending = new Map<number, (m: JSONRPCMessage) => void>();
  clientT.onmessage = (m) => { if ('id' in m && typeof m.id === 'number') pending.get(m.id)?.(m); };
  await clientT.start();
  let id = 0;
  const send = (method: string, params: unknown) => new Promise<Record<string, unknown>>((res) => {
    const n = ++id; pending.set(n, res as (m: JSONRPCMessage) => void);
    clientT.send({ jsonrpc: '2.0', id: n, method, params } as JSONRPCMessage);
  }).then((m) => (m as { result: Record<string, unknown> }).result);
  await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
  const list = await send('tools/list', {});
  await clientT.close();
  await ctx.client.close();
  return list;
}

describe('T6 tools/list snapshot', () => {
  it('matches the committed canonical snapshot (update with: pnpm tools:list:update)', async () => {
    const list = await getToolsList();
    const canonical = JSON.stringify(canonicalize(list), null, 2) + '\n';
    const snapPath = resolve(process.cwd(), 'tools-list.snapshot.json');
    const expected = readFileSync(snapPath, 'utf8');
    if (canonical !== expected) {
      // Helpful diff on failure
      const expLines = expected.split('\n');
      const gotLines = canonical.split('\n');
      const max = Math.max(expLines.length, gotLines.length);
      const context: string[] = [];
      for (let i = 0; i < max; i++) {
        const a = expLines[i] ?? '';
        const b = gotLines[i] ?? '';
        if (a !== b) context.push(`- ${a}\n+ ${b}`);
      }
      expect(canonical, `tools/list drifted.\nRun: pnpm tools:list:update\nDiff:\n${context.slice(0, 40).join('\n')}\n...`).toBe(expected);
    }
  });
});

