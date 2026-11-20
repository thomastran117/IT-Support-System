-- Q01: Employee ticket history.
-- $1 = authenticated employee user UUID (never taken from the URL or request body).
-- Returns the employee's own requests, most recent first. No rows when they have none.
SELECT ticket_id, title, status, priority, created_at, updated_at
FROM tickets
WHERE requester_id = $1::uuid
ORDER BY created_at DESC, ticket_id;
