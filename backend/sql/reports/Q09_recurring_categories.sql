-- Q09: Recurring ticket categories.
-- $1/$2 = ticket creation period, half-open [start, end).
-- Counts the current approved category; tickets without one are reported as 'Uncategorized'.
SELECT COALESCE(c.name, 'Uncategorized') AS category,
       COUNT(*) AS ticket_count
FROM tickets t
LEFT JOIN ticket_categories c ON c.category_id = t.category_id
WHERE t.created_at >= $1::timestamptz
  AND t.created_at < $2::timestamptz
GROUP BY c.category_id, c.name
ORDER BY ticket_count DESC, category;
