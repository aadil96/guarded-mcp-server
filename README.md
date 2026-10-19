# guarded-mcp-server

An MCP server for a **fake** wholesale business database (Meridian Supply Co.). Read tools run right away. Write tools need human approval and an idempotency key. Every call is written to an append-only audit log.

> **Warning:** this is a demo. All data is synthetic. Don't point it at a real database or real customer data.

## Status

Work in progress. The read tools run over stdio (`pnpm start`). Write tools and approvals are not built yet.

## Tools

All read tools are annotated `readOnlyHint: true`. Annotations are hints: clients must not trust them from servers they don't trust. Every `tools/call` writes one `audit_events` row, including calls the SDK rejects for invalid arguments (`error_code` `invalid_args`). The server's Postgres connections run `SET ROLE meridian_app`, so the least-privilege grants and append-only audit rules apply at runtime.

| Tool | What it does | Limits |
|---|---|---|
| `list_customers` | Customer list, oldest first | max 50 / page |
| `get_customer` | One customer by id | |
| `list_orders` | Orders, filter by `customer_id` and/or `status` | max 50 |
| `get_order` | One order with its line items | |
| `list_invoices` | Invoices, filter by `customer_id` and/or `status` | max 50 |
| `get_invoice` | One invoice by id | |
| `search_orders` | Text search on order number or customer name | parameterized, wildcards matched literally, max 50 |
| `list_pending_approvals` | Write requests waiting for a human | max 50 |

`pnpm start` needs `DATABASE_URL` and refuses to start without it. Every connection runs as `meridian_app`; if `SET ROLE meridian_app` fails or `current_user` is anything else, the server exits 1. `MCP_ACTOR` (default `local-dev`) and `MCP_ROLE` (`reader` or `operator`) set the audit identity.

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

Without `DATABASE_URL`, `pnpm test` uses in-memory PGlite and skips the suites that need separate login roles. With it (as in CI, on real Postgres 16), every suite runs, including the fail-closed tests. `pnpm check:db-access` fails if code outside `src/db/index.ts`, the owner scripts or the test fixture imports a database driver or changes role.

## Licence

MIT
