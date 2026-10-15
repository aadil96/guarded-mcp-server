-- audit_events is append-only: reject UPDATE, DELETE and TRUNCATE for every role, owner included.
CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update_delete BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
--> statement-breakpoint
-- Approval status machine: pending -> approved|denied, approved -> executed|failed. Everything else raises.
-- Frozen fields (tool, key, hash, arguments, requester) can never change after insert.
CREATE FUNCTION approvals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'approval must be created as pending, got %', NEW.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approvals cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.tool IS DISTINCT FROM OLD.tool OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.args_hash IS DISTINCT FROM OLD.args_hash OR NEW.arguments IS DISTINCT FROM OLD.arguments
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by THEN
    RAISE EXCEPTION 'approval % has frozen fields', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending'  AND NEW.status IN ('approved', 'denied')) OR
       (OLD.status = 'approved' AND NEW.status IN ('executed', 'failed'))) THEN
    RAISE EXCEPTION 'invalid approval transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approvals_guard BEFORE INSERT OR UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION approvals_guard();
--> statement-breakpoint
-- Least-privilege app role (NOLOGIN; grant it to a login user per environment, no password here).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meridian_app') THEN
    CREATE ROLE meridian_app NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO meridian_app;
--> statement-breakpoint
GRANT SELECT ON customers, products, orders, order_items, invoices, refunds, credit_notes, notes, approvals TO meridian_app;
--> statement-breakpoint
GRANT INSERT ON refunds, credit_notes, notes, approvals TO meridian_app;
--> statement-breakpoint
GRANT UPDATE (status, updated_at) ON orders TO meridian_app;
--> statement-breakpoint
GRANT UPDATE (status) ON invoices TO meridian_app;
--> statement-breakpoint
GRANT UPDATE ON approvals TO meridian_app;
--> statement-breakpoint
GRANT INSERT, SELECT ON audit_events TO meridian_app;
