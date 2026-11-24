-- Q12: AI category accuracy per model version.
-- $1/$2 = ticket creation period, half-open [start, end). Same cohort and "first valid
-- recommendation" rule as Q07; each labelled ticket is attributed to the model_version that produced
-- that recommendation. Labelled tickets with no valid recommendation have no model and are not in
-- this result: they are the difference between Q07 labelled_tickets and the sum of labelled_tickets here.
WITH first_valid AS (
  SELECT DISTINCT ON (ticket_id) ticket_id, proposed_category_id, model_version
  FROM ai_recommendations
  WHERE proposed_category_id IS NOT NULL
  ORDER BY ticket_id, created_at, recommendation_id
)
SELECT r.model_version,
       COUNT(*) AS labelled_tickets,
       COUNT(*) FILTER (WHERE r.proposed_category_id = l.reference_category_id) AS correct,
       ROUND(100.0 * COUNT(*) FILTER (
         WHERE r.proposed_category_id = l.reference_category_id) / COUNT(*), 2) AS accuracy_pct
FROM classification_labels l
JOIN tickets t ON t.ticket_id = l.ticket_id
JOIN first_valid r ON r.ticket_id = l.ticket_id
WHERE t.created_at >= $1::timestamptz
  AND t.created_at < $2::timestamptz
GROUP BY r.model_version
ORDER BY r.model_version;
