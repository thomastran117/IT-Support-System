-- Q02: Prioritized technician queue.
-- $1 = support team UUID already authorized for the caller (member technician or admin).
-- Unresolved tickets, CRITICAL first, then oldest first. No rows for an empty queue.
SELECT ticket_id, title, priority, status, assignee_id, created_at
FROM tickets
WHERE assigned_team_id = $1::uuid
  AND status IN ('OPEN','TRIAGED','IN_PROGRESS')
ORDER BY CASE priority
  WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2
  WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
  created_at, ticket_id;
