# Database development

SmartDesk uses PostgreSQL 16 and Prisma. The canonical executable schema is
`backend/prisma/schema.prisma` plus the ordered SQL migrations in `backend/prisma/migrations`.
PostgreSQL-only constraints, indexes, composite foreign keys, and append-only triggers live in the
migration SQL when Prisma cannot express them.

## Container workflow

The database is internal to Compose and persists in the `pgdata` volume.

```bash
# Start PostgreSQL and the application
docker compose up --build --watch

# Apply committed migrations
docker compose exec backend npm run migrate

# Seed deterministic demo data
docker compose exec backend npm run db:seed

# Inspect data directly
docker compose exec postgres psql -U smartdesk -d smartdesk
```

The backend applies pending migrations before starting. To create a migration during development,
open a shell in the backend container and run `npm run migrate:dev -- --name <change>`, then commit
the generated SQL. Review generated SQL before applying it and add hand-written constraints in the
same migration when required.

`docker compose down` preserves data. `docker compose down -v` permanently removes the database
volume and should only be used for an intentional reset.

## Data model reference

- [Entity-relationship diagram](database/erd.md)
- [Data dictionary](database/data-dictionary.md)
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

## Seed and query assets

The default seed is deterministic and safe to rerun. It supplies demo identities, teams, tickets,
comments, events, recommendations, articles, and labels used by the UI and reporting queries. The
shared credential is documented in [Authentication and authorization](authentication.md).

Operational SQL lives in `backend/sql/queries`; reporting and AI-evaluation SQL lives in
`backend/sql/reports`. Repository methods add authorization scope before returning operational data.

## Validation

```bash
docker compose --profile ci run --rm backend-ci
```

This builds the shared packages, generates Prisma, lints and type-checks database consumers, migrates
a disposable PostgreSQL instance, and runs the integration suite serially. Tests refuse destructive
reset behavior unless the target database name contains `test`.
