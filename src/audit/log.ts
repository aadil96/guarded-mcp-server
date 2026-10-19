import { randomUUID } from 'node:crypto';
import { redact as boundedRedact, jsonbSafeString } from '../approvals/audit.js';
import { auditEvents } from '../db/schema.js';
import type { AppDb } from '../db/types.js';

export type Caller = { actor: string; role: 'reader' | 'operator' };

export function callerFromEnv(env: NodeJS.ProcessEnv = process.env): Caller {
  const role = env.MCP_ROLE === 'operator' ? 'operator' : 'reader';
  return { actor: env.MCP_ACTOR || 'local-dev', role };
}

const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|authorization|cookie/i;

/**
 * Copy of the arguments with secret-looking keys replaced. Uses the bounded, jsonb-safe walk shared
 * with the approvals audit (depth, width and total-node caps; NUL/unpaired surrogates -> U+FFFD), so
 * deeply nested or malformed input can neither overflow the stack nor make the insert fail.
 */
export function redact(value: unknown): unknown {
  // Round-trip to plain objects: the walk builds null-prototype objects, which Drizzle's jsonb mapper can't take.
  try {
    return JSON.parse(JSON.stringify(boundedRedact(value, SECRET_KEY)) ?? 'null');
  } catch {
    return '[unserializable]';
  }
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
export async function writeAudit(db: AppDb, caller: Caller, e: AuditEntry) {
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
