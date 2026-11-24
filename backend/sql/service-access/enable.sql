-- Apply after Prisma migrations as the owner of the application objects.
DO $service_access$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(915091);

  -- PUBLIC grants are inherited by every login and would defeat column/table boundaries.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace AS n
    CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) AS acl
    WHERE n.nspname = 'public' AND acl.grantee = 0 AND acl.privilege_type = 'CREATE'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS c
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) AS acl
    WHERE c.relnamespace = 'public'::regnamespace AND acl.grantee = 0
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute AS a
    JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) AS acl
    WHERE c.relnamespace = 'public'::regnamespace AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION 'Remove PUBLIC schema CREATE and PUBLIC relation grants before enabling SmartDesk access';
  END IF;

  -- Keep the policy reversible and prevent an existing permissive policy from widening it.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.search_index_jobs'::regclass
      AND polname NOT IN ('smartdesk_ticket_intents', 'smartdesk_knowledge_intents', 'smartdesk_indexer')
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
    WHERE oid = 'public.search_index_jobs'::regclass
      AND (relforcerowsecurity OR (
        relrowsecurity AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_policy
          WHERE polrelid = 'public.search_index_jobs'::regclass AND polname = 'smartdesk_indexer'
        )
      ))
  ) OR (
    pg_catalog.to_regclass('public.smartdesk_search_article_sources') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy
      WHERE polrelid = 'public.search_index_jobs'::regclass AND polname = 'smartdesk_indexer'
    )
  ) THEN
    RAISE EXCEPTION 'Resolve existing search access configuration before enabling SmartDesk access';
  END IF;

  GRANT USAGE ON SCHEMA public TO
    smartdesk_ticket, smartdesk_notifications, smartdesk_analytics, smartdesk_knowledge,
    smartdesk_identity, smartdesk_search;

  GRANT SELECT, INSERT, UPDATE ON
    public.tickets, public.support_teams, public.ticket_categories, public.classification_labels
    TO smartdesk_ticket;
  GRANT SELECT, INSERT, DELETE ON public.team_members TO smartdesk_ticket;
  GRANT SELECT, INSERT ON
    public.ticket_comments, public.ticket_events, public.ai_recommendations,
    public.recommendation_articles TO smartdesk_ticket;
  GRANT UPDATE (review_status, reviewer_id, reviewed_at, review_notes)
    ON public.ai_recommendations TO smartdesk_ticket;
  GRANT SELECT, INSERT ON public.ai_analysis_jobs TO smartdesk_ticket;
  GRANT INSERT ON public.service_outbox_events TO smartdesk_ticket;
  GRANT UPDATE (state, attempts, run_after, lease_token, locked_until, error_kind, updated_at, completed_at)
    ON public.ai_analysis_jobs TO smartdesk_ticket;
  GRANT SELECT (article_id, title, is_published) ON public.knowledge_articles TO smartdesk_ticket;

  GRANT SELECT, INSERT ON public.notifications, public.notification_deliveries
    TO smartdesk_notifications;
  GRANT UPDATE (read_at) ON public.notifications TO smartdesk_notifications;
  GRANT UPDATE (state, attempts, run_after, lease_token, locked_until, error_kind, updated_at, completed_at)
    ON public.notification_deliveries TO smartdesk_notifications;
  GRANT SELECT (ticket_id, title) ON public.tickets TO smartdesk_notifications;

  GRANT SELECT, INSERT, UPDATE ON public.knowledge_articles TO smartdesk_knowledge;
  GRANT SELECT (category_id, name, is_active) ON public.ticket_categories TO smartdesk_knowledge;

  GRANT SELECT, INSERT ON public.users, public.admin_audit_log TO smartdesk_identity;
  GRANT UPDATE (role, is_active, password_hash, token_version) ON public.users TO smartdesk_identity;

  -- Transitional account and membership reads used by existing guards. Credential hashes
  -- stay accessible only to Identity and to the legacy account during the migration.
  GRANT SELECT (user_id, email, display_name, role, is_active, token_version) ON public.users
    TO smartdesk_ticket, smartdesk_notifications, smartdesk_knowledge;
  GRANT SELECT (team_id, user_id) ON public.team_members TO smartdesk_notifications, smartdesk_knowledge;
  GRANT SELECT (team_id, is_active) ON public.support_teams TO smartdesk_notifications, smartdesk_knowledge;

  -- Q05–Q14 use source facts in-place, with column grants and no private text.
  GRANT SELECT (user_id, role, is_active) ON public.users TO smartdesk_analytics;
  GRANT SELECT (ticket_id, category_id, status, created_at, resolved_at, first_response_at)
    ON public.tickets TO smartdesk_analytics;
  GRANT SELECT (ticket_id, event_type, occurred_at) ON public.ticket_events TO smartdesk_analytics;
  GRANT SELECT (ticket_id, reference_category_id) ON public.classification_labels TO smartdesk_analytics;
  GRANT SELECT (category_id, name) ON public.ticket_categories TO smartdesk_analytics;
  GRANT SELECT (recommendation_id, ticket_id, proposed_category_id, model_version, created_at, review_status, reviewed_at)
    ON public.ai_recommendations TO smartdesk_analytics;

  -- Producers can enqueue only their own entity type and cannot set lease or state columns.
  GRANT INSERT (entity_type, entity_id, revision, event_kind) ON public.search_index_jobs
    TO smartdesk_ticket, smartdesk_knowledge;
  GRANT SELECT (entity_type, entity_id, revision, state, completed_at)
    ON public.search_index_jobs TO smartdesk_ticket;
  GRANT SELECT (entity_type, entity_id, revision) ON public.search_index_jobs TO smartdesk_knowledge;
  GRANT USAGE ON SEQUENCE public.search_index_jobs_sequence_seq TO smartdesk_ticket, smartdesk_knowledge;
  GRANT SELECT ON public.search_index_jobs, public.search_rebuilds TO smartdesk_search;
  GRANT UPDATE (state, attempts, available_at, lease_token, locked_until, error_kind, updated_at, completed_at)
    ON public.search_index_jobs TO smartdesk_search;
  GRANT SELECT (
    ticket_id, requester_id, assigned_team_id, assignee_id, category_id, status, priority,
    title, description, created_at, updated_at, version
  ) ON public.tickets TO smartdesk_search;

  -- The indexer needs metadata for unpublication tombstones. Only published text crosses.
  CREATE OR REPLACE VIEW public.smartdesk_search_article_sources
    WITH (security_barrier = true) AS
    SELECT article_id, category_id, is_published, search_revision,
           CASE WHEN is_published THEN title END AS title,
           CASE WHEN is_published THEN body END AS body
    FROM public.knowledge_articles;
  REVOKE ALL ON public.smartdesk_search_article_sources FROM PUBLIC;
  GRANT SELECT ON public.smartdesk_search_article_sources TO smartdesk_search;

  DROP POLICY IF EXISTS smartdesk_ticket_intents ON public.search_index_jobs;
  DROP POLICY IF EXISTS smartdesk_knowledge_intents ON public.search_index_jobs;
  DROP POLICY IF EXISTS smartdesk_indexer ON public.search_index_jobs;
  CREATE POLICY smartdesk_ticket_intents ON public.search_index_jobs TO smartdesk_ticket
    USING (entity_type = 'TICKET') WITH CHECK (entity_type = 'TICKET');
  CREATE POLICY smartdesk_knowledge_intents ON public.search_index_jobs TO smartdesk_knowledge
    USING (entity_type = 'KNOWLEDGE_ARTICLE') WITH CHECK (entity_type = 'KNOWLEDGE_ARTICLE');
  -- Legacy membership enables the row policy only. Existing object grants still apply.
  CREATE POLICY smartdesk_indexer ON public.search_index_jobs TO smartdesk_search, smartdesk_legacy_search
    USING (true) WITH CHECK (true);
  ALTER TABLE public.search_index_jobs ENABLE ROW LEVEL SECURITY;
END
$service_access$;
