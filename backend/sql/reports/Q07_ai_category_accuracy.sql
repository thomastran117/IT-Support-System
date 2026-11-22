-- Q07: AI category recommendation accuracy.
-- $1/$2 = ticket creation period, half-open [start, end).
-- Compares the FIRST VALID recommendation per independently labelled ticket (earliest saved one that
-- proposes a category) with its reference category. A ticket with no valid recommendation stays in
-- the denominator and counts as incorrect.
-- accuracy_pct is NULL (not 0) when no labelled ticket falls in the window.
WITH first_rec AS (
  SELECT DISTINCT ON (ticket_id) ticket_id, proposed_category_id
  FROM ai_recommendations
  WHERE proposed_category_id IS NOT NULL
  ORDER BY ticket_id, created_at, recommendation_id
)
SELECT COUNT(*) AS labelled_tickets,
       COUNT(r.ticket_id) AS with_recommendation,
       COUNT(*) FILTER (WHERE r.proposed_category_id =
         l.reference_category_id) AS correct,
       ROUND(100.0 * COUNT(*) FILTER (
         WHERE r.proposed_category_id = l.reference_category_id)
         / NULLIF(COUNT(*), 0), 2) AS accuracy_pct
FROM classification_labels l
JOIN tickets t ON t.ticket_id = l.ticket_id
LEFT JOIN first_rec r ON r.ticket_id = l.ticket_id
WHERE t.created_at >= $1::timestamptz
  AND t.created_at < $2::timestamptz;
