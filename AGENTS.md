# Agents

Every agent working here uses pstack. The skills are in `.cursor/skills/`, and `.cursor/rules/pstack.mdc` says how to apply them.

- Read `.cursor/skills/poteto-mode/SKILL.md` first.
- Order: types and invariants, then lint, tests and CI, then minimal prose.
- New behaviour starts with a failing test (`tdd`). TypeScript follows `typescript-best-practices`.
- Before calling a task done, prove it on the real artifact (`principle-prove-it-works`) and encode repeated mistakes as checks (`correct`).
- CI must pass: `pnpm lint`, `pnpm typecheck`, `pnpm test` on real Postgres 16.
- Commits are signed. Never force-push or push to `main`.

## Rules and enforcers

Each rule lists the files that enforce it, as backticked repo paths. `pnpm check:agents` (run in CI) fails if a path is missing, or if a row has nothing that runs: a `test/**/*.test.ts`, a `test/types/*.ts` type test, a script CI runs, or a migration in the journal. Add a row when you add a rule, in the same PR.

| Rule | Enforced by |
| --- | --- |
| Only the db module opens pools or drizzle clients. | `scripts/check-db-access.mjs`, `test/check-db-access.test.ts` |
| MCP tools register only through `defineReadTool`/`defineWriteTool`, and only `src/server.ts` constructs a server. | `scripts/check-mcp-register.mjs`, `test/check-mcp-register.test.ts`, `test/tools-framework.test.ts` |
| Tool inputs are strict at every depth, with no transforms, codecs, `any` or `unknown`. | `src/tools/framework.ts`, `test/tools-framework.test.ts` |
| Every tool call writes exactly one audit row, in the transaction it describes. | `src/audit/log.ts`, `test/tools-invariant.test.ts`, `test/types/audit-types.ts` |
| `audit_events` is append-only, and audit rows never hold secrets or contact data. | `drizzle/0001_guards.sql`, `test/app-role.test.ts`, `test/audit-redact.test.ts` |
| The server runs as `meridian_app`, which may update only `status`, `resolved_by`, `resolved_at`, `result` and `executed_at` on approvals. | `drizzle/0001_guards.sql`, `drizzle/0003_approvals_column_grants.sql`, `test/app-role.test.ts`, `test/approvals-grants.test.ts` |
| Approvals move only pending → approved/denied → executed/failed, request fields are frozen, and only an `Approved` can execute. | `drizzle/0001_guards.sql`, `src/approvals/state.ts`, `test/approval-state.test.ts`, `test/db.test.ts`, `test/types/approval-state-types.ts` |
| A resolved approval names its resolver, a pending one does not, and only executed or failed rows carry a result (migration 0004). | `drizzle/0004_approvals_row_invariants.sql`, `test/approval-state.test.ts`, `test/approvals-row-invariants-migration.test.ts` |
| The operator console's identity comes only from `APPROVER_ACTOR`/`APPROVER_ROLE`, never from arguments. Self-approval is refused, the role is checked on every approve, deny and execute, and the MCP caller is never admin. | `src/audit/log.ts`, `src/approvals/cli.ts`, `test/approvals-cli.test.ts`, `test/approval-state.test.ts` |
| A write needs an approval, one idempotency key gives one approval, and an approval executes once. | `test/threats/t1-t3.test.ts`, `test/approval-state.test.ts` |
| Money is bigint-backed `Paise` and ids are branded, with one refundable calculation. | `src/domain/brands.ts`, `test/types/brands-types.ts`, `test/refundable.test.ts` |
| `tools/list` is pinned: any change fails until the snapshot is regenerated with `pnpm tools:snapshot` and reviewed. | `test/snapshots/tools-list.json`, `test/tools-list-snapshot.test.ts` |
| CI runs the exact Node in `.nvmrc`, which sits inside `engines.node`; locally any Node in that range works. | `scripts/check-engines.mjs`, `test/check-engines.test.ts` |
| Real-Postgres suites never skip in CI. | `test/startup-guards.test.ts` |
| This table points only at enforcers that exist and run. | `scripts/check-agents-md-enforcers.mjs`, `test/check-agents-md.test.ts` |
