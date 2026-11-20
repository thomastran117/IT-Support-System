-- CreateIndex
CREATE INDEX "idx_ai_recommendations_ticket_created" ON "ai_recommendations"("ticket_id", "created_at", "recommendation_id");

-- CreateIndex
CREATE INDEX "idx_classification_labels_category" ON "classification_labels"("reference_category_id");

-- CreateIndex
CREATE INDEX "idx_recommendation_articles_article" ON "recommendation_articles"("article_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_recommendation_articles_rank" ON "recommendation_articles"("recommendation_id", "relevance_rank");

-- CreateIndex
CREATE INDEX "idx_team_members_user" ON "team_members"("user_id");

-- CreateIndex
CREATE INDEX "idx_ticket_comments_ticket_created" ON "ticket_comments"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_ticket_events_ticket_occurred" ON "ticket_events"("ticket_id", "occurred_at", "event_id");

-- CreateIndex
CREATE INDEX "idx_tickets_requester_created" ON "tickets"("requester_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_tickets_team_status_created" ON "tickets"("assigned_team_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "idx_tickets_category_created" ON "tickets"("category_id", "created_at");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assigned_team_id_assignee_id_fkey" FOREIGN KEY ("assigned_team_id", "assignee_id") REFERENCES "team_members"("team_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written integrity rules (SD-007). Prisma cannot express these.
-- Convention: ck_<table>_<rule>. Blank = empty after trimming whitespace.
-- ===========================================================================

-- Identity and reference data ------------------------------------------------
ALTER TABLE "users"
  ADD CONSTRAINT "ck_users_role" CHECK ("role" IN ('EMPLOYEE', 'TECHNICIAN', 'ADMIN')),
  ADD CONSTRAINT "ck_users_email_normalized" CHECK ("email" = lower("email") AND btrim("email") <> ''),
  ADD CONSTRAINT "ck_users_display_name_nonblank" CHECK (btrim("display_name") <> '');

ALTER TABLE "support_teams"
  ADD CONSTRAINT "ck_support_teams_name_nonblank" CHECK (btrim("name") <> '');

ALTER TABLE "ticket_categories"
  ADD CONSTRAINT "ck_ticket_categories_name_nonblank" CHECK (btrim("name") <> '');

-- Tickets and lifecycle invariants --------------------------------------------
ALTER TABLE "tickets"
  ADD CONSTRAINT "ck_tickets_status"
    CHECK ("status" IN ('OPEN', 'TRIAGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')),
  ADD CONSTRAINT "ck_tickets_priority"
    CHECK ("priority" IN ('UNSET', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  ADD CONSTRAINT "ck_tickets_title_nonblank" CHECK (btrim("title") <> ''),
  ADD CONSTRAINT "ck_tickets_description_nonblank" CHECK (btrim("description") <> ''),
  -- The composite FK is MATCH SIMPLE (skipped when either column is NULL), so this CHECK
  -- closes the gap: an assignee can never exist without a team.
  ADD CONSTRAINT "ck_tickets_assignee_requires_team"
    CHECK ("assignee_id" IS NULL OR "assigned_team_id" IS NOT NULL),
  ADD CONSTRAINT "ck_tickets_triaged_requirements"
    CHECK ("status" NOT IN ('TRIAGED', 'IN_PROGRESS')
           OR ("category_id" IS NOT NULL AND "priority" <> 'UNSET' AND "assigned_team_id" IS NOT NULL)),
  ADD CONSTRAINT "ck_tickets_resolution_required"
    CHECK ("status" NOT IN ('RESOLVED', 'CLOSED')
           OR ("resolved_at" IS NOT NULL AND "resolution_summary" IS NOT NULL AND btrim("resolution_summary") <> '')),
  -- Reopening to OPEN (or any unresolved status) must clear the current resolution fields;
  -- earlier RESOLVED/REOPENED history stays in ticket_events.
  ADD CONSTRAINT "ck_tickets_no_stale_resolution"
    CHECK ("status" IN ('RESOLVED', 'CLOSED')
           OR ("resolved_at" IS NULL AND "resolution_summary" IS NULL)),
  ADD CONSTRAINT "ck_tickets_resolved_after_created"
    CHECK ("resolved_at" IS NULL OR "resolved_at" >= "created_at");

ALTER TABLE "ticket_comments"
  ADD CONSTRAINT "ck_ticket_comments_body_nonblank" CHECK (btrim("body") <> '');

-- Audit events -----------------------------------------------------------------
ALTER TABLE "ticket_events"
  ADD CONSTRAINT "ck_ticket_events_type"
    CHECK ("event_type" IN (
      'CREATED', 'STATUS_CHANGED', 'TEAM_ASSIGNED', 'TEAM_REASSIGNED', 'COMMENT_ADDED',
      'AI_REVIEWED', 'RESOLVED', 'REOPENED',
      'CATEGORY_UPDATED', 'PRIORITY_UPDATED', 'ASSIGNEE_UPDATED')),
  ADD CONSTRAINT "ck_ticket_events_details_object" CHECK (jsonb_typeof("details") = 'object');

-- ticket_events is append-only: reject UPDATE and DELETE for every database role, so the
-- guarantee does not depend on how the application account is granted privileges.
-- (TRUNCATE is not a row operation and is reserved for test resets / administrators.)
CREATE FUNCTION "ticket_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ticket_events is append-only (% not allowed)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "trg_ticket_events_append_only"
  BEFORE UPDATE OR DELETE ON "ticket_events"
  FOR EACH ROW EXECUTE FUNCTION "ticket_events_append_only"();

-- AI recommendations -----------------------------------------------------------
ALTER TABLE "ai_recommendations"
  ADD CONSTRAINT "ck_ai_recommendations_priority"
    CHECK ("proposed_priority" IS NULL OR "proposed_priority" IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  ADD CONSTRAINT "ck_ai_recommendations_confidence"
    CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)),
  ADD CONSTRAINT "ck_ai_recommendations_model_version_nonblank" CHECK (btrim("model_version") <> ''),
  ADD CONSTRAINT "ck_ai_recommendations_review_status"
    CHECK ("review_status" IN ('PENDING', 'ACCEPTED', 'OVERRIDDEN', 'REJECTED')),
  ADD CONSTRAINT "ck_ai_recommendations_review_complete"
    CHECK (("review_status" = 'PENDING' AND "reviewer_id" IS NULL AND "reviewed_at" IS NULL)
           OR ("review_status" <> 'PENDING' AND "reviewer_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)),
  ADD CONSTRAINT "ck_ai_recommendations_reviewed_after_created"
    CHECK ("reviewed_at" IS NULL OR "reviewed_at" >= "created_at");

-- Knowledge base ----------------------------------------------------------------
ALTER TABLE "knowledge_articles"
  ADD CONSTRAINT "ck_knowledge_articles_title_nonblank" CHECK (btrim("title") <> ''),
  ADD CONSTRAINT "ck_knowledge_articles_body_nonblank" CHECK (btrim("body") <> '');

ALTER TABLE "recommendation_articles"
  ADD CONSTRAINT "ck_recommendation_articles_rank_positive" CHECK ("relevance_rank" > 0);
