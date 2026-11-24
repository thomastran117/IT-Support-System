-- SD-084: rank ticket text in PostgreSQL while OpenSearch is disabled, unavailable, or behind.
-- Keep this immutable expression in sync with the fallback query. Ticket comments and events
-- have separate visibility rules and are excluded from this index.
CREATE INDEX "idx_tickets_fts"
  ON "tickets"
  USING GIN ((setweight(to_tsvector('english'::regconfig, "title"), 'A') ||
              setweight(to_tsvector('english'::regconfig, "description"), 'B')));
