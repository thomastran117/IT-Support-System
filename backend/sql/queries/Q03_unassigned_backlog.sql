-- Q03: Unassigned ticket backlog.
-- OPEN tickets with no approved team (manual triage and AI-unavailable cases).
-- $1 = text[] of priorities, or NULL for all.
-- $2 = category UUID, or NULL for all (tickets with no category only match NULL).
-- $3 / $4 = created_at lower bound (inclusive) / upper bound (exclusive), or NULL.
-- $5 = 'age' (oldest first) or 'priority' (CRITICAL first, then oldest).
-- age_minutes is measured against the database clock when the query runs.
SELECT t.ticket_id, t.title, t.priority, t.created_at, t.status,
       t.category_id, c.name AS category_name, t.version,
       EXTRACT(EPOCH FROM (NOW() - t.created_at))/60 AS age_minutes
FROM tickets t
LEFT JOIN ticket_categories c ON c.category_id = t.category_id
WHERE t.assigned_team_id IS NULL AND t.status = 'OPEN'
  AND ($1::text[] IS NULL OR t.priority = ANY($1::text[]))
  AND ($2::uuid IS NULL OR t.category_id = $2::uuid)
  AND ($3::timestamptz IS NULL OR t.created_at >= $3::timestamptz)
  AND ($4::timestamptz IS NULL OR t.created_at < $4::timestamptz)
ORDER BY CASE WHEN $5::text = 'priority' THEN CASE t.priority
  WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2
  WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END ELSE 0 END,
  t.created_at, t.ticket_id;
