-- Q05: Average time to first approved routing.
-- $1/$2 = report start/end (timestamptz), half-open [start, end), cohort by ticket creation.
-- "Routing" is the first TEAM_ASSIGNED event; later TEAM_REASSIGNED events never replace it.
-- submitted = tickets created in the window, routed = those with a first routing, so unrouted
-- tickets stay visible. avg_minutes is NULL (not 0) when nothing was routed.
WITH first_routing AS (
  SELECT ticket_id, MIN(occurred_at) AS routed_at
  FROM ticket_events
  WHERE event_type = 'TEAM_ASSIGNED'
  GROUP BY ticket_id
)
SELECT COUNT(*) AS submitted,
       COUNT(f.routed_at) AS routed,
       ROUND(AVG(EXTRACT(EPOCH FROM
         (f.routed_at - t.created_at))/60), 2) AS avg_minutes
FROM tickets t
LEFT JOIN first_routing f ON f.ticket_id = t.ticket_id
WHERE t.created_at >= $1::timestamptz
  AND t.created_at < $2::timestamptz;
