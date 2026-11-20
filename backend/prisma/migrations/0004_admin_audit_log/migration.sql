-- SD-017: audit trail for administrator account actions.
--
-- One row per account change (create, activate, deactivate, role change, password reset).
-- Append-only like ticket_events: UPDATE and DELETE are rejected for every role. Rows never
-- contain credentials, hashes or tokens; `details` holds only non-sensitive facts (e.g. old/new role).
CREATE TABLE "admin_audit_log" (
    "audit_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" UUID NOT NULL,
    "target_user_id" UUID NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("audit_id")
);

ALTER TABLE "admin_audit_log"
  ADD CONSTRAINT "admin_audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "admin_audit_log_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_admin_audit_action"
    CHECK ("action" IN ('USER_CREATED', 'USER_ACTIVATED', 'USER_DEACTIVATED', 'ROLE_CHANGED', 'PASSWORD_RESET')),
  ADD CONSTRAINT "ck_admin_audit_details_object" CHECK (jsonb_typeof("details") = 'object');

CREATE INDEX "idx_admin_audit_created" ON "admin_audit_log"("created_at" DESC, "audit_id");
CREATE INDEX "idx_admin_audit_target" ON "admin_audit_log"("target_user_id", "created_at" DESC);

CREATE FUNCTION "admin_audit_log_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only (% not allowed)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "trg_admin_audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "admin_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "admin_audit_log_append_only"();
