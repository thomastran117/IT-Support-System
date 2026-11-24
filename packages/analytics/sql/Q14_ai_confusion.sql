-- Q14: Confusion summary: reference category versus the first valid recommended category.
-- $1/$2 = ticket creation period, half-open [start, end). predicted is NULL when the labelled
-- ticket has no valid recommendation (it is a miss, not omitted). Counts only; no ticket data.
WITH first_valid AS (
  SELECT DISTINCT ON (ticket_id) ticket_id, proposed_category_id
  FROM ai_recommendations
  WHERE proposed_category_id IS NOT NULL
  ORDER BY ticket_id, created_at, recommendation_id
)
SELECT ref.name AS reference_category,
       pred.name AS predicted_category,
       COUNT(*) AS ticket_count
FROM classification_labels l
JOIN tickets t ON t.ticket_id = l.ticket_id
JOIN ticket_categories ref ON ref.category_id = l.reference_category_id
LEFT JOIN first_valid r ON r.ticket_id = l.ticket_id
LEFT JOIN ticket_categories pred ON pred.category_id = r.proposed_category_id
WHERE t.created_at >= $1::timestamptz
  AND t.created_at < $2::timestamptz
GROUP BY ref.name, pred.name
ORDER BY ref.name, pred.name NULLS LAST;
