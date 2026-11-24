# Database development

SmartDesk uses PostgreSQL 16 and Prisma. The canonical executable schema is
`backend/prisma/schema.prisma` plus the ordered SQL migrations in `backend/prisma/migrations`.
PostgreSQL-only constraints, indexes, composite foreign keys, and append-only triggers live in the
migration SQL when Prisma cannot express them.

## Container workflow

The database is internal to Compose and persists in the `pgdata` volume.

```bash
# Start PostgreSQL and the application
docker compose up --build --wait

# Apply committed migrations
docker compose run --rm --build local-bootstrap

# Load the live-demo dataset
docker compose run --rm --no-deps local-bootstrap npm run db:seed

# Inspect data directly
docker compose exec postgres psql -U smartdesk -d smartdesk
```

The bootstrap applies pending migrations and service grants before the standalone services start.
To create a migration during development, mount the Prisma directory so the generated SQL is
written to the checkout. Review the SQL and add any hand-written constraints before committing.

```bash
docker compose run --rm -v ./backend/prisma:/app/backend/prisma local-bootstrap \
  npm run migrate:dev -- --name <change>
```

`docker compose down` preserves data. `docker compose down -v` permanently removes the database
volume and should only be used for an intentional reset.

## Data model reference

- [Entity-relationship diagram](database/erd.md)
- [Data dictionary](database/data-dictionary.md)
- [Service ownership and PostgreSQL grants](database/service-access.md)
- `docs/database/schema-spec.json` is the machine-readable input for both generated documents.

After a schema change, update `schema-spec.json` to match the migrated database and regenerate:

```bash
docker compose --profile tools run --rm docs
```

The backend integration suite verifies that the generated Markdown exactly matches the specification
and, with its disposable database, that documented tables, columns, keys, constraints, and indexes
match PostgreSQL.

## Transactions and concurrency

Repositories accept a Prisma client or transaction client, so related ticket, comment, event, and
audit changes commit together. Database error mapping turns known constraint failures into stable API
responses without exposing SQL details.

Tickets use an integer `version` for optimistic concurrency. Mutations compare the caller's
`expectedVersion` and increment it atomically; stale requests return 409 and leave state unchanged.
Comments do not increment ticket versions. Status transitions lock and validate the current record,
then update state and append events within one transaction.

Comments, ticket events, and administrator audit records are append-only. Database triggers reject
updates and deletes even if application code attempts them.

### Search outbox

Ticket submission, approved routing changes, and status transitions enqueue an `UPSERT` in the
same transaction as the source write. The job uses the committed ticket `version`. Replayed
submissions, unchanged routing, and comments leave the queue untouched.

Each article starts at `search_revision = 1`. Publication and edits to published titles, bodies,
or categories enqueue an `UPSERT`. Unpublication enqueues a `DELETE` for the search document. An
article row lock serializes these changes and their revision increments. Draft edits and repeated
publication requests leave the revision and queue untouched.

`search_index_jobs` stores entity type, ID, revision, event kind, and queue metadata. The unique
entity and revision key deduplicates retries. PostgreSQL records intent with search disabled or
unavailable. Jobs remain queued until an indexer runs. Existing rows and bulk seed fixtures are
covered by [backfill and reindex](architecture.md#search-backfill-and-reindex). The `sequence` column
orders replay in sealed windows. The `search_rebuilds` table stores per-generation scan and replay
checkpoints. See [Search indexing worker](architecture.md#search-indexing-worker) for job processing
and requeueing.

## Seed and query assets

The default profile loads 300 tickets, 40 users, seven teams, nine categories, and 31 knowledge
articles into an empty database. It also seeds ticket conversations and timelines, AI recommendations
and evaluation labels, and read and unread inbox items. The first run adds 192 tickets to the
default 30-day reporting window and spreads the rest across the preceding month. Rerunning adds
missing fixtures and keeps the original dates and existing edits. For an older demo database, pick
a report range ending on the creation date of the Toronto VPN example below. Use a fresh database
when you want a new reporting window. The `--profile test` option loads the small fixture set used
by integration tests.

Use the documented demo accounts and shared password for the walkthrough.
[Authentication and authorization](authentication.md)

- Sign in as Erin to page through ticket history, open notifications, and browse published knowledge.
- Sign in as Tara to page through the unassigned, team, and personal queues. Search for
  “VPN disconnects after waking the laptop (Toronto hybrid desk)” to review a pending recommendation
  with a linked knowledge article.
- Sign in as Alex to search across support teams, inspect knowledge drafts, and explore Reports and
  AI Evaluation. With OpenSearch enabled, rebuild the index after seeding to include the bulk-loaded
  tickets and published articles. [Search backfill and reindex](architecture.md#search-backfill-and-reindex)

Operational SQL lives in `backend/sql/queries`; reporting and AI-evaluation SQL lives in
`packages/analytics/sql`. Repository methods add authorization scope before returning operational data.

The [service access migration](database/service-access.md) documents the E14 ownership matrix,
optional PostgreSQL grants, and rollback steps.

The [cross-service outbox](architecture/service-outbox.md) documents the ticket and recommendation
events, consumer receipts, and replay procedure introduced by SD-092.

## Validation

```bash
docker compose --profile ci run --rm backend-ci
```

This builds the shared packages, generates Prisma, lints and type-checks database consumers, migrates
a disposable PostgreSQL instance, and runs the integration suite serially. Tests refuse destructive
reset behavior unless the target database name contains `test`.
