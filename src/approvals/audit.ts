import { randomUUID } from 'node:crypto';
import type { AuditOutcome, AuditRole, Sql } from './types.js';

const SENSITIVE = /(email|phone|gstin|token|secret|password|api[_-]?key)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE.test(k) ? '[redacted]' : redact(v)]),
    );
  }
  if (typeof value === 'string' && value.length > 200) return `${value.slice(0, 200)}…`;
  return value;
}

export type AuditEntry = {
  actor: string; role: AuditRole; tool: string; args: unknown; outcome: AuditOutcome;
  approvalId?: string | null; idempotencyKey?: string | null; startedAt: number; correlationId: string; errorCode?: string | null;
};

export async function writeAudit(sql: Sql, e: AuditEntry) {
  await sql.query(
    `insert into audit_events (id, actor, role, tool, arguments, outcome, approval_id, idempotency_key, duration_ms, correlation_id, error_code)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [randomUUID(), e.actor, e.role, e.tool, JSON.stringify(redact(e.args ?? {})), e.outcome, e.approvalId ?? null,
      e.idempotencyKey ?? null, Math.max(0, Math.round(performance.now() - e.startedAt)), e.correlationId, e.errorCode ?? null],
  );
}
