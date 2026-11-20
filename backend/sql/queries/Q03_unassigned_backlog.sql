-- Q03: Unassigned ticket backlog.
-- No parameters. OPEN tickets with no approved team (manual triage and AI-unavailable cases),
-- oldest first. age_minutes is measured against the database clock when the query runs.
SELECT ticket_id, title, priority, created_at,
       EXTRACT(EPOCH FROM (NOW() - created_at))/60 AS age_minutes
FROM tickets
WHERE assigned_team_id IS NULL AND status = 'OPEN'
ORDER BY created_at, ticket_id;
