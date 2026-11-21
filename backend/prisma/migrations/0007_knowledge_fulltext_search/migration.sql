-- SD-030: full-text retrieval over published knowledge articles.
--
-- Language configuration: 'english' (stemming and stop words), pinned explicitly so the index
-- expression is immutable and does not depend on default_text_search_config. Changing the
-- language means recreating this index and the expression in src/db/repositories/knowledge.ts.
--
-- It is a partial expression index (published rows only), so drafts are never indexed and the
-- planner can only use it for queries that also filter `is_published`. The search query repeats
-- this exact expression; keep the two in sync. Title-over-body ranking is computed per matching
-- row at query time (setweight), which keeps the index single-vector and cheap to maintain.
CREATE INDEX "idx_knowledge_articles_fts"
  ON "knowledge_articles"
  USING GIN (to_tsvector('english'::regconfig, "title" || ' ' || "body"))
  WHERE "is_published";
