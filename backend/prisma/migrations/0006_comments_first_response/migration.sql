-- SD-021: stable first public response and append-only comments.
--
-- `first_response_at` is the posting time of the first public (non-internal) comment written by a
-- technician or administrator other than the requester, on or after ticket creation. It is stored
-- (not derived on read) so reporting and the UI see one stable value even if an author's role
-- changes later. The service sets it in the same transaction as the comment; it can only move to an
-- earlier time (two racing first replies), never later and never back to NULL.
ALTER TABLE "tickets"
  ADD COLUMN "first_response_at" TIMESTAMPTZ(6),
  ADD CONSTRAINT "ck_tickets_first_response_after_created"
    CHECK ("first_response_at" IS NULL OR "first_response_at" >= "created_at");

-- Backfill from existing comments with the same definition the service uses.
UPDATE "tickets" t
SET "first_response_at" = fr."first_at"
FROM (
  SELECT c."ticket_id", MIN(c."created_at") AS "first_at"
  FROM "ticket_comments" c
  JOIN "users" u ON u."user_id" = c."author_id"
  JOIN "tickets" tk ON tk."ticket_id" = c."ticket_id"
  WHERE NOT c."is_internal"
    AND u."role" IN ('TECHNICIAN', 'ADMIN')
    AND c."author_id" <> tk."requester_id"
    AND c."created_at" >= tk."created_at"
  GROUP BY c."ticket_id"
) fr
WHERE t."ticket_id" = fr."ticket_id";

-- Comments are append-only for the MVP (no edit or delete is modelled with audit history).
-- Like ticket_events, UPDATE and DELETE are rejected for every role; TRUNCATE is not blocked.
CREATE FUNCTION "ticket_comments_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ticket_comments is append-only (% not allowed)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "trg_ticket_comments_append_only"
  BEFORE UPDATE OR DELETE ON "ticket_comments"
  FOR EACH ROW EXECUTE FUNCTION "ticket_comments_append_only"();
