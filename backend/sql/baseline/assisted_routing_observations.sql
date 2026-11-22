-- Assisted-routing observations for the SD-047 baseline comparison (read-only).
-- $1/$2 = ticket creation window, half-open [start, end), UTC. $3 = restrict to tickets whose AI
-- recommendation was accepted or overridden by a reviewer (true), or take every ticket (false).
-- One row per ticket: the same cohort and first-routing rule as report Q05 (the first TEAM_ASSIGNED
-- event; reassignments never replace it). assigned_at is NULL for tickets never routed, so unrouted
-- tickets stay visible. No requester, title, description or comment text is selected.
WITH first_routing AS (
  SELECT ticket_id, MIN(occurred_at) AS assigned_at
  FROM ticket_events
  WHERE event_type = 'TEAM_ASSIGNED'
  GROUP BY ticket_id
)
SELECT t.ticket_id,
       COALESCE(c.name, 'Uncategorized') AS category,
       t.created_at AS started_at,
       f.assigned_at
FROM tickets t
LEFT JOIN ticket_categories c ON c.category_id = t.category_id
LEFT JOIN first_routing f ON f.ticket_id = t.ticket_id
WHERE t.created_at >= $1::timestamptz
  AND t.created_at < $2::timestamptz
  AND ($3::boolean = false OR EXISTS (
        SELECT 1 FROM ai_recommendations r
        WHERE r.ticket_id = t.ticket_id AND r.review_status IN ('ACCEPTED', 'OVERRIDDEN')))
ORDER BY t.created_at, t.ticket_id;
