-- Q02 (count): total rows Q02 would return for the same $1-$7 filters, ignoring paging and sort.
SELECT COUNT(*)::int AS total
FROM tickets t
WHERE t.assigned_team_id = $1::uuid
  AND t.status = ANY(COALESCE($2::text[], ARRAY['OPEN','TRIAGED','IN_PROGRESS']))
  AND ($3::text[] IS NULL OR t.priority = ANY($3::text[]))
  AND ($4::uuid IS NULL OR t.category_id = $4::uuid)
  AND ($5::timestamptz IS NULL OR t.created_at >= $5::timestamptz)
  AND ($6::timestamptz IS NULL OR t.created_at < $6::timestamptz)
  AND ($7::uuid IS NULL OR t.assignee_id = $7::uuid);
