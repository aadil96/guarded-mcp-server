import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { auditEvents } from '../db/schema.js';
import type { AppTx } from '../db/types.js';

export type Caller = { actor: string; role: 'reader' | 'operator' | 'admin'; correlationId?: string };

export function callerFromEnv(env: NodeJS.ProcessEnv = process.env): Caller {
  const role = env.MCP_ROLE === 'operator' ? 'operator' : 'reader';
  return { actor: env.MCP_ACTOR || 'local-dev', role };
}

// Redaction and JSON-safety (single canonical implementation)
const SENSITIVE = /(email|phone|gstin|token|secret|password|api[_-]?key|authorization|cookie)/i;
export const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const jsonbSafe = (s: string) => s.replaceAll('\u0000', '\uFFFD').replace(LONE_SURROGATE, '\uFFFD');

function uniqueKey(out: Record<string, unknown>, k: string): string {
  if (!Object.hasOwn(out, k)) return k;
  for (let i = 2; ; i++) if (!Object.hasOwn(out, `${k}#${i}`)) return `${k}#${i}`;
}

const MAX_DEPTH = 8;
const MAX_KEYS = 100;
const MAX_NODES = 2000;

type Walk = { path: WeakSet<object>; budget: number; redact: boolean; truncate: boolean; keys?: RegExp };

export function redact(value: unknown, sensitiveKeys: RegExp = SENSITIVE): unknown {
  return walk(value, 0, { path: new WeakSet(), budget: MAX_NODES, redact: true, truncate: true, keys: sensitiveKeys });
}

export function jsonSafe(value: unknown): unknown {
  return walk(value, 0, { path: new WeakSet(), budget: MAX_NODES, redact: false, truncate: false });
}

export const jsonbSafeString = (s: string) => jsonbSafe(s);

export function toJsonb(value: unknown): string {
  try {
    return JSON.stringify(jsonSafe(value)) ?? 'null';
  } catch {
    return JSON.stringify('[unserializable]');
  }
}

function walk(value: unknown, depth: number, w: Walk): unknown {
  if (w.budget <= 0) return '[truncated]';
  w.budget -= 1;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'string') {
    const v = w.truncate && value.length > 200 ? `${value.slice(0, 200)}…` : value;
    return jsonbSafe(v);
  }
  if (typeof value === 'undefined') return null;
  if (typeof value !== 'object') return `[${typeof value}]`;
  if (w.path.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[truncated]';
  w.path.add(value);
  try {
    if (Array.isArray(value)) return value.slice(0, MAX_KEYS).map((v) => walk(v, depth + 1, w));
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(value).slice(0, MAX_KEYS)) {
      if (w.budget <= 0) { out['…'] = '[truncated]'; break; }
      let v: unknown;
      try { v = (value as Record<string, unknown>)[k]; } catch { v = '[unreadable]'; }
      out[uniqueKey(out, jsonbSafe(k))] = w.redact && (w.keys ?? SENSITIVE).test(k) ? '[redacted]' : walk(v, depth + 1, w);
    }
    return out;
  } finally {
    w.path.delete(value);
  }
}

function auditJson(args: unknown): string {
  try {
    return JSON.stringify(redact(args ?? {})) ?? 'null';
  } catch {
    return JSON.stringify('[unserializable]');
  }
}

export type AuditOutcome = 'ok' | 'error' | 'denied' | 'pending_approval' | 'duplicate' | 'conflict';
export type AuditRole = 'reader' | 'operator' | 'admin' | 'invalid';

export type AuditEntry = {
  actor: string; role: AuditRole; tool: string; args: unknown; outcome: AuditOutcome;
  approvalId?: string | null; idempotencyKey?: string | null; startedAt: number; correlationId: string; errorCode?: string | null;
};

/** Appends exactly one audit_events row through a transaction handle. */
export async function writeAudit(tx: AppTx, e: AuditEntry) {
  await tx.insert(auditEvents).values({
    id: randomUUID(),
    actor: e.actor,
    role: e.role,
    tool: e.tool,
    arguments: sql`${auditJson(e.args)}::jsonb`,
    outcome: e.outcome,
    approvalId: e.approvalId ?? null,
    idempotencyKey: e.idempotencyKey ?? null,
    durationMs: Math.max(0, Math.round(performance.now() - e.startedAt)),
    correlationId: e.correlationId,
    errorCode: e.errorCode ?? null,
  });
}
