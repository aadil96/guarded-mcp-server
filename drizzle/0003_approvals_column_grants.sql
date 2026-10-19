-- Narrow meridian_app's UPDATE on approvals from the whole row (0001_guards) to exactly the columns
-- the app writes: resolveApproval sets status, resolved_by, resolved_at; executeApproval sets
-- status, result, executed_at (success and failure paths). Frozen request fields (tool,
-- idempotency_key, args_hash, arguments, requested_by) and summary, id, created_at are now refused
-- by the grant itself (42501), before the approvals_guard trigger ever runs.
REVOKE UPDATE ON approvals FROM meridian_app;
--> statement-breakpoint
GRANT UPDATE (status, resolved_by, resolved_at, result, executed_at) ON approvals TO meridian_app;
