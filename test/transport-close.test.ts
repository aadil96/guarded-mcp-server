import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { AuditTracker, auditingTransport } from '../src/audit/transport.js';
import type { Db } from '../src/db/types.js';

function fakeTransport(): Transport {
  const t: Transport = {
    start: async () => {},
    send: async (_m: JSONRPCMessage) => {},
    close: async () => { t.onclose?.(); },
  };
  return t;
}
const caller = { actor: 'test', role: 'reader' } as never;

describe('auditingTransport close hook', () => {
  it('runs the close hook once on stdin EOF (inner onclose) and forwards onclose', async () => {
    const inner = fakeTransport();
    const hook = vi.fn(async () => {});
    const w = auditingTransport(inner, {} as Db, caller, new AuditTracker(), hook);
    const forwarded = vi.fn();
    w.onclose = forwarded;
    inner.onclose?.(); // what StdioServerTransport does when stdin ends
    inner.onclose?.();
    await new Promise((r) => setImmediate(r));
    expect(forwarded).toHaveBeenCalledTimes(2);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('runs the close hook when the wrapper is closed explicitly', async () => {
    const hook = vi.fn();
    const w = auditingTransport(fakeTransport(), {} as Db, caller, new AuditTracker(), hook);
    await w.close();
    await new Promise((r) => setImmediate(r));
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('a failing close hook is reported, not thrown', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const inner = fakeTransport();
    auditingTransport(inner, {} as Db, caller, new AuditTracker(), async () => { throw new Error('boom'); });
    expect(() => inner.onclose?.()).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
