-- Run after stopping the scoped consumers and restoring the legacy connection/routing.
DO $service_access$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(915091);

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.search_index_jobs'::regclass AND polname = 'smartdesk_indexer'
  ) THEN
    RETURN;
  END IF;

  DROP POLICY smartdesk_ticket_intents ON public.search_index_jobs;
  DROP POLICY smartdesk_knowledge_intents ON public.search_index_jobs;
  DROP POLICY smartdesk_indexer ON public.search_index_jobs;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = 'public.search_index_jobs'::regclass
  ) THEN
    ALTER TABLE public.search_index_jobs DISABLE ROW LEVEL SECURITY;
  END IF;

  DROP VIEW public.smartdesk_search_article_sources;
  DROP POLICY IF EXISTS smartdesk_outbox_access ON public.service_outbox_events;
  DROP POLICY IF EXISTS smartdesk_notification_events ON public.service_outbox_events;
  DROP POLICY IF EXISTS smartdesk_outbox_access ON public.service_outbox_deliveries;
  DROP POLICY IF EXISTS smartdesk_notification_receipts ON public.service_outbox_deliveries;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = 'public.service_outbox_events'::regclass
  ) THEN
    ALTER TABLE public.service_outbox_events DISABLE ROW LEVEL SECURITY;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = 'public.service_outbox_deliveries'::regclass
  ) THEN
    ALTER TABLE public.service_outbox_deliveries DISABLE ROW LEVEL SECURITY;
  END IF;
  REVOKE ALL PRIVILEGES ON SEQUENCE public.search_index_jobs_sequence_seq
    FROM smartdesk_ticket, smartdesk_knowledge;
  REVOKE ALL PRIVILEGES ON TABLE
    public.tickets, public.support_teams, public.ticket_categories, public.classification_labels,
    public.team_members, public.ticket_comments, public.ticket_events, public.ai_recommendations,
    public.recommendation_articles, public.ai_analysis_jobs, public.knowledge_articles,
    public.notifications, public.notification_deliveries, public.users, public.admin_audit_log,
    public.search_index_jobs, public.search_rebuilds, public.service_outbox_events,
    public.service_outbox_deliveries
    FROM smartdesk_ticket, smartdesk_notifications, smartdesk_analytics, smartdesk_knowledge,
         smartdesk_identity, smartdesk_search;
  REVOKE USAGE ON SCHEMA public FROM
    smartdesk_ticket, smartdesk_notifications, smartdesk_analytics, smartdesk_knowledge,
    smartdesk_identity, smartdesk_search;
END
$service_access$;
