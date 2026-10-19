# guarded-mcp-server

An MCP server for a **fake** wholesale business database (Meridian Supply Co.). Read tools run right away. Write tools need human approval and an idempotency key. Every call is written to an append-only audit log.

> **Warning:** this is a demo. All data is synthetic. Don't point it at a real database or real customer data.

## Status

Work in progress. The tools run over stdio (`pnpm start`). `issue_refund` only creates a pending approval; a human approves, denies and executes it with the approvals console:

```sh
APPROVER_ACTOR=alice APPROVER_ROLE=admin pnpm approvals list
APPROVER_ACTOR=alice APPROVER_ROLE=admin pnpm approvals approve <approval-id>   # or: deny <approval-id>
APPROVER_ACTOR=alice APPROVER_ROLE=admin pnpm approvals execute <approval-id>
```

The console's identity comes only from `APPROVER_ACTOR` and `APPROVER_ROLE` (both required; arguments like `--actor` or `--role` are refused and audited). Approving or denying needs `admin` and is refused for the requester (`self_approval_forbidden`); executing needs `operator` or `admin`. Every approve, deny, execute and refusal writes one audit row. The MCP server's caller is never `admin`, so no MCP client can approve.

## Tools

All read tools are annotated `readOnlyHint: true`; `issue_refund` is `destructiveHint: true`, `idempotentHint: true`. Annotations are hints: clients must not trust them from servers they don't trust. Every `tools/call` writes one `audit_events` row, including calls the SDK rejects for invalid arguments (`error_code` `invalid_args`). The server's Postgres connections run `SET ROLE meridian_app`, so the least-privilege grants and append-only audit rules apply at runtime.

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
| `issue_refund` | Requests a refund on an invoice. Returns `pending_approval` with an `approvalId`; nothing is refunded until a human approves it | `idempotency_key` required; reuse it on retry. Needs `MCP_ROLE=operator` |

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
