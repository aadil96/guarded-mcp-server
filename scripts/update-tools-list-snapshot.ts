#!/usr/bin/env -S tsx
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from '../src/server.js';
import { AuditTracker, auditingTransport } from '../src/audit/transport.js';

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
  // Lazy import to avoid side effects during tooling
  const { freshDb } = await import('../test/helpers.js');
  const ctx = await freshDb();
  const db = ctx.db as never; // server enforces role only at app entrypoints; we just need schemas
  await createServer(db, caller, tracker).connect(auditingTransport(serverT, db, caller, tracker));
  const pending = new Map<number, (m: JSONRPCMessage) => void>();
  clientT.onmessage = (m) => { if ('id' in m && typeof m.id === 'number') pending.get(m.id)?.(m); };
  await clientT.start();
  let id = 0;
  const send = (method: string, params: unknown) => new Promise<Record<string, unknown>>((res) => {
    const n = ++id; pending.set(n, res as (m: JSONRPCMessage) => void);
    clientT.send({ jsonrpc: '2.0', id: n, method, params } as JSONRPCMessage);
  }).then((m) => (m as { result: Record<string, unknown> }).result);
  await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'snapshot', version: '0' } });
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
  const list = await send('tools/list', {});
  await clientT.close();
  await ctx.client.close();
  return list;
}

async function main() {
  const list = await getToolsList();
  const canonical = canonicalize(list);
  const json = JSON.stringify(canonical, null, 2) + '\n';
  const outPath = resolve(process.cwd(), 'tools-list.snapshot.json');
  writeFileSync(outPath, json, 'utf8');
  console.log('Updated tools-list snapshot at', outPath);
}

void main();

