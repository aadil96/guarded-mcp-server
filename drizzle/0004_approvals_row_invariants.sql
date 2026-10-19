-- The typed approval row boundary (src/approvals/state.ts) parses each status into the fields it guarantees:
-- a resolved row (approved/denied/executed/failed) names who resolved it, a pending row does not, and only
-- executed/failed rows carry a result. Before this migration the database allowed rows that break this (for
-- example a status-only UPDATE by meridian_app), which would make every approval path throw at the parser.
-- Backfill first so the constraints apply on an upgraded database; the trigger allows these (non-frozen,
-- same-status) updates. 'unrecorded' is an honest marker, not an identity: the resolver was never stored.
UPDATE "approvals" SET "resolved_by" = 'unrecorded' WHERE "status" <> 'pending' AND "resolved_by" IS NULL;--> statement-breakpoint
UPDATE "approvals" SET "resolved_by" = NULL WHERE "status" = 'pending' AND "resolved_by" IS NOT NULL;--> statement-breakpoint
UPDATE "approvals" SET "result" = NULL WHERE "status" NOT IN ('executed', 'failed') AND "result" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_resolved_by_iff_resolved" CHECK (("approvals"."status" = 'pending') = ("approvals"."resolved_by" is null));--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_result_only_when_final" CHECK ("approvals"."result" is null or "approvals"."status" in ('executed', 'failed'));
