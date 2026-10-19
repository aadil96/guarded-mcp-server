import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { auditEvents } from '../db/schema.js';
import type { AppQueryable } from '../db/types.js';
import type { AuditOutcome, AuditRole } from './types.js';

const SENSITIVE = /(email|phone|gstin|token|secret|password|api[_-]?key)/i;

/** jsonb rejects U+0000 and unpaired surrogate escapes; replace both (after any slicing) with U+FFFD. */
export const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const jsonbSafe = (s: string) => s.replaceAll('\u0000', '\uFFFD').replace(LONE_SURROGATE, '\uFFFD');

/** Sanitizing can map distinct keys onto one; never overwrite, suffix instead so no value is dropped. */
function uniqueKey(out: Record<string, unknown>, k: string): string {
  if (!Object.hasOwn(out, k)) return k;
  for (let i = 2; ; i++) if (!Object.hasOwn(out, `${k}#${i}`)) return `${k}#${i}`;
}

const MAX_DEPTH = 8;
const MAX_KEYS = 100;
const MAX_NODES = 2000;

type Walk = { path: WeakSet<object>; budget: number; redact: boolean; truncate: boolean; keys?: RegExp };

/**
 * Redact and make JSON-safe in one bounded pass: runtime-rejected input may hold bigints,
 * functions, symbols or cycles, and none of those may stop the audit row from being written.
 * A global node budget bounds total work even for shared-reference graphs.
 */
export function redact(value: unknown, sensitiveKeys: RegExp = SENSITIVE): unknown {
  return walk(value, 0, { path: new WeakSet(), budget: MAX_NODES, redact: true, truncate: true, keys: sensitiveKeys });
}

/**
 * The same bounded JSON-safe pass without redaction or string truncation, for values that are
 * persisted as data (handler results) rather than as an audit record.
 */
export function jsonSafe(value: unknown): unknown {
  return walk(value, 0, { path: new WeakSet(), budget: MAX_NODES, redact: false, truncate: false });
}

/** JSON text Postgres jsonb will accept for any value; never throws. */
export function toJsonb(value: unknown): string {
  try {
    return JSON.stringify(jsonSafe(value)) ?? 'null';
  } catch {
    return JSON.stringify('[unserializable]');
  }
}

export const jsonbSafeString = (s: string) => jsonbSafe(s);

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
    // Null prototype: an own '__proto__' key becomes a plain field instead of hitting the legacy setter.
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

export type AuditEntry = {
  actor: string; role: AuditRole; tool: string; args: unknown; outcome: AuditOutcome;
  approvalId?: string | null; idempotencyKey?: string | null; startedAt: number; correlationId: string; errorCode?: string | null;
};

export async function writeAudit(db: AppQueryable, e: AuditEntry) {
  await db.insert(auditEvents).values({
    id: randomUUID(),
    actor: e.actor,
    role: e.role,
    tool: e.tool,
    // auditJson is already redacted, bounded JSON text; cast it so the driver does not encode it a second time.
    arguments: sql`${auditJson(e.args)}::jsonb`,
    outcome: e.outcome,
    approvalId: e.approvalId ?? null,
    idempotencyKey: e.idempotencyKey ?? null,
    durationMs: Math.max(0, Math.round(performance.now() - e.startedAt)),
    correlationId: e.correlationId,
    errorCode: e.errorCode ?? null,
  });
}
