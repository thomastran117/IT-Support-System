-- Q04 (requester variant): the same history restricted for the employee who owns the ticket.
-- Deviation from Q04, recorded in docs/database/queries.md: only employee-relevant event types are
-- returned, public comment events only (internal notes are hidden), and details are reduced to the
-- status change itself so team routing, AI review payloads and system reasons are never exposed.
SELECT e.event_type, e.occurred_at, u.display_name AS actor,
       CASE WHEN e.event_type = 'STATUS_CHANGED'
            THEN jsonb_build_object('from', e.details->'from', 'to', e.details->'to')
            ELSE '{}'::jsonb END AS details
FROM ticket_events e
LEFT JOIN users u ON u.user_id = e.actor_id
WHERE e.ticket_id = $1::uuid
  AND e.event_type IN ('CREATED','STATUS_CHANGED','RESOLVED','REOPENED','COMMENT_ADDED')
  AND COALESCE((e.details->>'isInternal')::boolean, false) = false
ORDER BY e.occurred_at, e.event_id;
