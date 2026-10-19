# Agents

Every agent working here uses pstack. The skills are in `.cursor/skills/`, and `.cursor/rules/pstack.mdc` says how to apply them.

- Read `.cursor/skills/poteto-mode/SKILL.md` first.
- Order: types and invariants, then lint, tests and CI, then minimal prose.
- New behaviour starts with a failing test (`tdd`). TypeScript follows `typescript-best-practices`.
- Before calling a task done, prove it on the real artifact (`principle-prove-it-works`) and encode repeated mistakes as checks (`correct`).
- CI must pass: `pnpm lint`, `pnpm typecheck`, `pnpm test` on real Postgres 16.
- Commits are signed. Never force-push or push to `main`.
