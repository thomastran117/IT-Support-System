-- Q10: Daily ticket intake.
-- $1/$2 = ticket creation period, half-open [start, end).
-- Groups by UTC calendar date. Dates with no submissions are omitted; any gap filling is done by
-- the presentation layer.
SELECT (created_at AT TIME ZONE 'UTC')::date AS report_date,
       COUNT(*) AS submitted_tickets
FROM tickets
WHERE created_at >= $1::timestamptz
  AND created_at < $2::timestamptz
GROUP BY report_date
ORDER BY report_date;
