## Agent Rules and Enforcers

| Rule | Enforcer | How it's enforced | Path |
|------|----------|-------------------|------|
| Single DB module only (no ad-hoc pools/drizzle) | check-db-access | CI script scans repo for forbidden constructors outside approved modules | scripts/check-db-access.mjs |
| MCP tool registration only via helpers | check-mcp-register | CI forbids `.registerTool(` outside framework | scripts/check-mcp-register.mjs |
| Strict schemas (reject unknown keys); no input transforms | Framework assertions | Helper registers tools with strict Zod schemas and refuses transforms in inputs | src/tools/framework.ts |
| Single audit writer; audit via transaction only | Type + usage | Only `writeAudit(tx, ...)` exists; read/write paths call it with `AppTx` | src/audit/log.ts |
| Column grants: meridian_app can update only allowed columns | DB migrations | Grants and guards defined in migrations | drizzle/0001_guards.sql |
| Column-level grants for approvals/invoices | DB migrations | Column UPDATE grants for `status`, `resolved_by`, `resolved_at`, `result`, `executed_at` | drizzle/0003_approvals_column_grants.sql |
| Approval state machine | Types + tests | Discriminated union and pure transitions in code; behaviour tests cover transitions | src/approvals/state.ts |
| Tools/list stable surface | Snapshot test | Canonical tools/list JSON compared against committed snapshot in CI | test/tools-list-hash.test.ts |

All paths in the table are verified to exist in CI (`pnpm check:agents`).

# Agents

Every agent working here uses pstack. The skills are in `.cursor/skills/`, and `.cursor/rules/pstack.mdc` says how to apply them.

- Read `.cursor/skills/poteto-mode/SKILL.md` first.
- Order: types and invariants, then lint, tests and CI, then minimal prose.
- New behaviour starts with a failing test (`tdd`). TypeScript follows `typescript-best-practices`.
- Before calling a task done, prove it on the real artifact (`principle-prove-it-works`) and encode repeated mistakes as checks (`correct`).
- CI must pass: `pnpm lint`, `pnpm typecheck`, `pnpm test` on real Postgres 16.
- Commits are signed. Never force-push or push to `main`.
