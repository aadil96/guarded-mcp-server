import { randomUUID } from 'node:crypto';
import type { AuditOutcome, AuditRole, Sql } from './types.js';

const SENSITIVE = /(email|phone|gstin|token|secret|password|api[_-]?key)/i;

const MAX_DEPTH = 8;
const MAX_KEYS = 100;
const MAX_NODES = 2000;

type Walk = { path: WeakSet<object>; budget: number };

/**
 * Redact and make JSON-safe in one bounded pass: runtime-rejected input may hold bigints,
 * functions, symbols or cycles, and none of those may stop the audit row from being written.
 * A global node budget bounds total work even for shared-reference graphs.
 */
export function redact(value: unknown): unknown {
  return walk(value, 0, { path: new WeakSet(), budget: MAX_NODES });
}

function walk(value: unknown, depth: number, w: Walk): unknown {
  if (w.budget <= 0) return '[truncated]';
  w.budget -= 1;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (typeof value === 'undefined') return null;
  if (typeof value !== 'object') return `[${typeof value}]`;
  if (w.path.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[truncated]';
  w.path.add(value);
  try {
    if (Array.isArray(value)) return value.slice(0, MAX_KEYS).map((v) => walk(v, depth + 1, w));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).slice(0, MAX_KEYS)) {
      if (w.budget <= 0) { out['…'] = '[truncated]'; break; }
      let v: unknown;
      try { v = (value as Record<string, unknown>)[k]; } catch { v = '[unreadable]'; }
      out[k] = SENSITIVE.test(k) ? '[redacted]' : walk(v, depth + 1, w);
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

export async function writeAudit(sql: Sql, e: AuditEntry) {
  await sql.query(
    `insert into audit_events (id, actor, role, tool, arguments, outcome, approval_id, idempotency_key, duration_ms, correlation_id, error_code)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [randomUUID(), e.actor, e.role, e.tool, auditJson(e.args), e.outcome, e.approvalId ?? null,
      e.idempotencyKey ?? null, Math.max(0, Math.round(performance.now() - e.startedAt)), e.correlationId, e.errorCode ?? null],
  );
}
