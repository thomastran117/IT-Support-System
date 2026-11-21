-- Q02: Prioritized technician queue.
-- $1 = support team UUID already authorized for the caller (member technician or admin).
-- $2 = text[] of statuses, or NULL for the unresolved set (OPEN, TRIAGED, IN_PROGRESS).
-- $3 = text[] of priorities, or NULL for all.
-- $4 = category UUID, or NULL for all.
-- $5 / $6 = created_at lower bound (inclusive) / upper bound (exclusive), or NULL.
-- $7 = assignee UUID, or NULL for all (the "assigned to me" view).
-- $8 = 'priority' (CRITICAL first, then oldest) or 'age' (oldest first).
-- Ties always break on creation time then id, so paging is deterministic. No rows for an empty queue.
SELECT t.ticket_id, t.title, t.priority, t.status, t.assignee_id, t.created_at,
       t.category_id, c.name AS category_name, u.display_name AS assignee_name, t.version,
       EXTRACT(EPOCH FROM (NOW() - t.created_at))/60 AS age_minutes
FROM tickets t
LEFT JOIN ticket_categories c ON c.category_id = t.category_id
LEFT JOIN users u ON u.user_id = t.assignee_id
WHERE t.assigned_team_id = $1::uuid
  AND t.status = ANY(COALESCE($2::text[], ARRAY['OPEN','TRIAGED','IN_PROGRESS']))
  AND ($3::text[] IS NULL OR t.priority = ANY($3::text[]))
  AND ($4::uuid IS NULL OR t.category_id = $4::uuid)
  AND ($5::timestamptz IS NULL OR t.created_at >= $5::timestamptz)
  AND ($6::timestamptz IS NULL OR t.created_at < $6::timestamptz)
  AND ($7::uuid IS NULL OR t.assignee_id = $7::uuid)
ORDER BY CASE WHEN $8::text = 'age' THEN 0 ELSE CASE t.priority
  WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2
  WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END END,
  t.created_at, t.ticket_id;
