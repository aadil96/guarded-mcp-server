import { randomUUID } from 'node:crypto';
import { jsonbSafeString } from '../approvals/audit.js';
import { auditEvents } from '../db/schema.js';
import type { Db } from '../db/types.js';

export type Caller = { actor: string; role: 'reader' | 'operator' };

export function callerFromEnv(env: NodeJS.ProcessEnv = process.env): Caller {
  const role = env.MCP_ROLE === 'operator' ? 'operator' : 'reader';
  return { actor: env.MCP_ACTOR || 'local-dev', role };
}

const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|authorization|cookie/i;

/**
 * Copy of the arguments with secret-looking keys replaced, recursively. Strings and keys are made
 * jsonb-safe (U+0000 and unpaired surrogates -> U+FFFD) so the audit insert itself can't be rejected.
 */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return jsonbSafeString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [jsonbSafeString(k), SECRET_KEY.test(k) ? '[redacted]' : redact(v)]),
    );
  }
  return value;
}

export type AuditEntry = {
  tool: string;
  arguments: unknown;
  outcome: 'ok' | 'error';
  durationMs: number;
  correlationId: string;
  errorCode?: string | null;
};

/** Appends exactly one audit_events row. App code never updates or deletes these rows. */
export async function writeAudit(db: Db, caller: Caller, e: AuditEntry) {
  await db.insert(auditEvents).values({
    id: randomUUID(),
    actor: caller.actor,
    role: caller.role,
    tool: jsonbSafeString(e.tool),
    arguments: redact(e.arguments ?? {}),
    outcome: e.outcome,
    durationMs: Math.max(0, Math.round(e.durationMs)),
    correlationId: e.correlationId,
    errorCode: e.errorCode ?? null,
  });
}
