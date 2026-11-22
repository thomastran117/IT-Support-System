-- Q13: AI recommendation acceptance per model version (not accuracy).
-- $1/$2 = review period on reviewed_at, half-open [start, end). Same rule as Q08, grouped by
-- model_version. PENDING is excluded; OVERRIDDEN and REJECTED count against acceptance.
SELECT model_version,
       COUNT(*) AS reviewed,
       COUNT(*) FILTER (WHERE review_status = 'ACCEPTED') AS accepted,
       ROUND(100.0 * COUNT(*) FILTER (WHERE review_status = 'ACCEPTED') / COUNT(*), 2)
         AS acceptance_pct
FROM ai_recommendations
WHERE review_status IN ('ACCEPTED','OVERRIDDEN','REJECTED')
  AND reviewed_at >= $1::timestamptz
  AND reviewed_at < $2::timestamptz
GROUP BY model_version
ORDER BY model_version;
