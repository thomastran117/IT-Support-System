-- Q06: Average time to resolution.
-- $1/$2 = resolution period on resolved_at, half-open [start, end).
-- Uses the latest resolution of tickets currently RESOLVED/CLOSED; a reopened ticket has NULL
-- resolved_at and is excluded until it is resolved again. avg_hours is NULL when none qualify.
SELECT COUNT(*) AS resolved_tickets,
       ROUND(AVG(EXTRACT(EPOCH FROM
         (resolved_at - created_at))/3600), 2) AS avg_hours
FROM tickets
WHERE status IN ('RESOLVED','CLOSED')
  AND resolved_at >= $1::timestamptz
  AND resolved_at < $2::timestamptz;
