-- Q11: Average time to first public technician response.
-- $1/$2 = report start/end (timestamptz), half-open [start, end), cohort by ticket creation
-- (same cohort as Q05). The response is tickets.first_response_at: the first public comment by a
-- technician/administrator who is not the requester (see backend/src/domain/firstResponse.ts).
-- submitted = tickets created in the window, responded = those with a first response, so tickets
-- still waiting stay visible. avg_minutes is NULL (not 0) when nothing was answered.
SELECT COUNT(*) AS submitted,
       COUNT(first_response_at) AS responded,
       ROUND(AVG(EXTRACT(EPOCH FROM
         (first_response_at - created_at))/60), 2) AS avg_minutes
FROM tickets
WHERE created_at >= $1::timestamptz
  AND created_at < $2::timestamptz;
