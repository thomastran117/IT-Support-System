-- Q03 (count): total rows Q03 would return for the same $1-$4 filters, ignoring paging and sort.
SELECT COUNT(*)::int AS total
FROM tickets t
WHERE t.assigned_team_id IS NULL AND t.status = 'OPEN'
  AND ($1::text[] IS NULL OR t.priority = ANY($1::text[]))
  AND ($2::uuid IS NULL OR t.category_id = $2::uuid)
  AND ($3::timestamptz IS NULL OR t.created_at >= $3::timestamptz)
  AND ($4::timestamptz IS NULL OR t.created_at < $4::timestamptz);
