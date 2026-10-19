// Type-level guard: writeAudit must accept only AppTx, not AppDb.
// This file is compiled by tsc in CI via "pnpm typecheck".
import type { AppDb, AppTx } from '../../src/db/types.js';
import { writeAudit } from '../../src/audit/log.js';

declare const db: AppDb;
declare const tx: AppTx;

// ok: AppTx is allowed
void writeAudit(tx, {
  actor: 'a', role: 'reader', tool: 'get_order', args: {},
  outcome: 'ok', startedAt: 0, correlationId: 'c',
});

// not ok: AppDb must be rejected at compile time
// @ts-expect-error writeAudit requires an AppTx, not an AppDb
void writeAudit(db, {
  actor: 'a', role: 'reader', tool: 'get_order', args: {},
  outcome: 'ok', startedAt: 0, correlationId: 'c',
});

