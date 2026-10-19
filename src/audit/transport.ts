import { randomUUID } from 'node:crypto';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';
import type { AppDb } from '../db/types.js';
import { type Caller, writeAudit } from './log.js';

type Id = string | number;
type Pending = { tool: unknown; args: unknown; started: number };

/**
 * Shared between the tool handlers and the transport wrapper. Handlers mark the request ids
 * they audited themselves; any tools/call response for an id NOT marked never reached a
 * handler (the SDK rejected it first, e.g. zod input validation) and is audited here instead.
 */
export class AuditTracker {
  readonly handled = new Set<Id>();
  markHandled(id: Id) { this.handled.add(id); }
}

/** True when a tools/call reply is an SDK-side rejection (InvalidParams error or an isError result). */
function isRejection(m: JSONRPCMessage): boolean {
  if ('error' in m && m.error) return m.error.code === -32602;
  if ('result' in m && m.result) return (m.result as { isError?: boolean }).isError === true;
  return false;
}

/**
 * Wraps a transport so a tools/call that the SDK rejects before the handler runs still writes
 * exactly one audit row (outcome error, error_code invalid_args). Keyed by JSON-RPC request id.
 */
export function auditingTransport(
  inner: Transport, db: AppDb, caller: Caller, tracker: AuditTracker,
  /** Runs once when the connection closes (stdin EOF or close()), e.g. to end the DB pool so the process can exit. */
  onClosed?: () => void | Promise<void>,
): Transport {
  let closed = false;
  const pending = new Map<Id, Pending>();
  const wrapper: Transport = {
    start: () => inner.start(),
    close: () => inner.close(),
    async send(message, options) {
      const id = 'id' in message && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : undefined;
      const p = id === undefined || 'method' in message ? undefined : pending.get(id);
      if (id !== undefined && p) {
        pending.delete(id);
        const handled = tracker.handled.delete(id);
        if (!handled && isRejection(message)) {
          try {
            await writeAudit(db, caller, {
              tool: typeof p.tool === 'string' ? p.tool : '(missing)', arguments: p.args, outcome: 'error',
              durationMs: performance.now() - p.started, correlationId: randomUUID(), errorCode: 'invalid_args',
            });
          } catch (e) {
            console.error('audit write failed for rejected tools/call:', e);
          }
        }
      }
      return inner.send(message, options);
    },
  };
  inner.onmessage = (message, extra) => {
    if ('method' in message && message.method === 'tools/call' && 'id' in message) {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      pending.set(message.id, { tool: params.name, args: params.arguments ?? {}, started: performance.now() });
    }
    wrapper.onmessage?.(message, extra);
  };
  inner.onclose = () => {
    wrapper.onclose?.();
    if (closed) return;
    closed = true;
    Promise.resolve().then(onClosed).catch((e) => console.error('close hook failed:', e));
  };
  inner.onerror = (e) => wrapper.onerror?.(e);
  return wrapper;
}
