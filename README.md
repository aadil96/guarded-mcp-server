# guarded-mcp-server

An MCP server for a **fake** wholesale business database (Meridian Supply Co.). Read tools run right away. Write tools need human approval and an idempotency key. Every call is written to an append-only audit log.

> **Warning:** this is a demo. All data is synthetic. Don't point it at a real database or real customer data.

## Status

Work in progress. The tools run over stdio (`pnpm start`) or Streamable HTTP (`MCP_TRANSPORT=http pnpm start`, below). `issue_refund` only creates a pending approval; a human approves, denies and executes it with the approvals console:

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
| `issue_refund` | Requests a refund on an invoice. Returns `pending_approval` with an `approvalId`; nothing is refunded until a human approves it | `idempotency_key` required; reuse it on retry. Needs `MCP_ROLE=operator` on stdio, or the `refund:request` scope over HTTP |

`pnpm start` needs `DATABASE_URL` and refuses to start without it. Every connection runs as `meridian_app`; if `SET ROLE meridian_app` fails or `current_user` is anything else, the server exits 1. `MCP_ACTOR` (default `local-dev`) and `MCP_ROLE` (`reader` or `operator`) set the audit identity.

The exact `tools/list` result is pinned in `test/snapshots/tools-list.json`, and `pnpm test` fails on any change to it. After an intended tool change, run `pnpm tools:snapshot` and commit the reviewed diff.

## HTTP transport (local and demo use)

```sh
pnpm mint-token alice refund:request     # prints the raw token once, and its sha256 config line
# put only the config line in tokens.conf (git-ignored); give the raw token to the client
MCP_TRANSPORT=http MCP_HTTP_TOKENS_FILE=tokens.conf DATABASE_URL=… pnpm start
```

- Serves `POST /mcp` with the SDK's Streamable HTTP transport. In v0.1.0 HTTP mode is stateless and speaks only the 2025-era protocol: there are no sessions and no streaming (`GET`/`DELETE` get `405`, which is not audited because the SDK client probes `GET` on every connection), and 2026-07-28 clients fall back to the older initialize handshake. Support for the 2026-07-28 protocol, sessions and streaming is tracked in [#25](https://github.com/aadil96/guarded-mcp-server/issues/25). Binds `127.0.0.1:3333` by default (`MCP_HTTP_HOST`, `MCP_HTTP_PORT`).
- Clients send `Authorization: Bearer <token>`. The config (`MCP_HTTP_TOKENS_FILE`, or the same lines inline in `MCP_HTTP_TOKENS`) holds only SHA-256 hashes, one `sha256:<hex> <actor> <scopes>` per line. Tokens are compared in constant time. The server refuses to start with no tokens or any malformed line.
- Scopes: `read` gives the reader role; `refund:request` (which includes `read`) gives the operator role. No scope gives `admin`: approving and executing stay in the approvals console. The audit actor and role come from the token, never from tool arguments.
- Every token sees the same `tools/list` as stdio. A `tools/call` outside the token's scopes is refused with `insufficient_scope` and audited once. The SDK validates arguments before the scope check, so an out-of-scope call with invalid arguments is refused and audited once as `invalid_args` instead. Tool schemas are public through `tools/list` anyway. Checking scope first is tracked in [#26](https://github.com/aadil96/guarded-mcp-server/issues/26).
- Before any tool runs, requests are refused with `401` (missing or bad token, with a `WWW-Authenticate: Bearer` challenge), `403` (a `Host` or browser `Origin` outside the localhost allowlist, against DNS rebinding; extend with `MCP_HTTP_ALLOWED_HOSTS` / `MCP_HTTP_ALLOWED_ORIGINS`) or `413` (body over 1 MiB). No CORS headers are sent.
- These refusals are written to `audit_events` with no header values. Refusals before the token check (all `401`s and `403`s, and a `413` for a declared `Content-Length` over the cap) use actor `anonymous` and role `invalid`. A `413` for a body that only goes over the cap while streaming comes after authentication, so its row has the token's actor and role. Each row records the client IP, its status and the HTTP method. The server binds localhost by default, and the audit table holds no customer data.
- Each IP gets a burst of 10 refusal rows, refilled at 10 a minute. Up to 10,000 IPs are tracked. Past that, an old IP is forgotten only once its allowance has fully refilled; until then new IPs share one overflow allowance, so rotating source addresses doesn't reset the limit. Beyond that the request is still refused but not audited, and the dropped count goes into one `rejections_dropped` row a minute. Over the limit the response stays `401` on purpose: a `429` would reveal the limit.
- On SIGINT or SIGTERM the server stops accepting connections and lets in-flight requests finish (up to 10 seconds) before closing the database pool. A request that arrives on an existing connection after shutdown starts (for example, one pipelined on a keep-alive socket) gets `503 shutting_down` without touching the database. It isn't audited, because the database is closing.

Static bearer tokens are for local and demo use. A real multi-user deployment should use the MCP specification's OAuth 2.1 authorization (an authorization server, audience-bound short-lived tokens, protected resource metadata), which this project does not implement.

## Non-goals (v1)

- No free-form SQL or reporting-query tool.
- No email, HTTP or other outbound tools (nothing that can exfiltrate data).
- No production use and no real data.
- No full OAuth 2.1 in v1. The upgrade path is documented instead.

## Local dev

Node: any version in `engines.node` (`>=22.12.0 <23`) works locally, and CI runs exactly the version in `.nvmrc` (`nvm use` picks it up). `pnpm check:engines` checks your Node against the range, and CI adds `--exact`.

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
