# guarded-mcp-server

An MCP server for a **fake** wholesale business database (Meridian Supply Co.). Read tools run right away. Write tools need human approval and an idempotency key. Every call is written to an append-only audit log.

> **Warning:** this is a demo. All data is synthetic. Don't point it at a real database or real customer data.

## Status

Work in progress. Right now the repo has the scaffold plus the database schema and seed. No tools are wired up yet.

## Non-goals (v1)

- No free-form SQL or reporting-query tool.
- No email, HTTP or other outbound tools (nothing that can exfiltrate data).
- No production use and no real data.
- No full OAuth 2.1 in v1. The upgrade path is documented instead.

## Local dev

```sh
pnpm install
docker compose up -d
pnpm db:migrate
pnpm seed
pnpm test
```

`pnpm test` runs against in-memory PGlite. CI also runs the migrations and seed against a real Postgres 16.

## Licence

MIT
