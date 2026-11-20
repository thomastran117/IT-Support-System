-- Q04: Ticket audit history (staff view: every event, full details).
-- $1 = ticket UUID already authorized for the caller. actor is NULL for system events.
SELECT e.event_type, e.occurred_at, u.display_name AS actor,
       e.details
FROM ticket_events e
LEFT JOIN users u ON u.user_id = e.actor_id
WHERE e.ticket_id = $1::uuid
ORDER BY e.occurred_at, e.event_id;
