-- Q08: AI recommendation acceptance rate (not accuracy).
-- $1/$2 = review period on reviewed_at, half-open [start, end).
-- Reviewed records only: PENDING is excluded; OVERRIDDEN and REJECTED count against acceptance.
-- acceptance_pct is NULL (not 0) when nothing was reviewed in the window.
SELECT COUNT(*) AS reviewed,
       COUNT(*) FILTER (WHERE review_status = 'ACCEPTED') AS accepted,
       ROUND(100.0 * COUNT(*) FILTER (
         WHERE review_status = 'ACCEPTED')
         / NULLIF(COUNT(*), 0), 2) AS acceptance_pct
FROM ai_recommendations
WHERE review_status IN ('ACCEPTED','OVERRIDDEN','REJECTED')
  AND reviewed_at >= $1::timestamptz
  AND reviewed_at < $2::timestamptz;
