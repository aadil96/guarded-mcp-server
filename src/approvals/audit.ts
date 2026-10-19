import { randomUUID } from 'node:crypto';
import type { AuditOutcome, AuditRole, Sql } from './types.js';

const SENSITIVE = /(email|phone|gstin|token|secret|password|api[_-]?key)/i;

const MAX_DEPTH = 8;
const MAX_KEYS = 100;

/**
 * Redact and make JSON-safe in one bounded pass: runtime-rejected input may hold bigints,
 * functions, symbols or cycles, and none of those may stop the audit row from being written.
 */
export function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (typeof value === 'undefined') return null;
  if (typeof value !== 'object') return `[${typeof value}]`;
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[truncated]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.slice(0, MAX_KEYS).map((v) => redact(v, depth + 1, seen));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).slice(0, MAX_KEYS)) {
      let v: unknown;
      try { v = (value as Record<string, unknown>)[k]; } catch { v = '[unreadable]'; }
      out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
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
