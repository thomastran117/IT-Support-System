# Service-owned PostgreSQL access

SD-091 adds an opt-in grants migration for the E14 extraction. The schema, foreign keys, and
business rows stay in the existing PostgreSQL database. The Prisma migration account owns the
SQL objects. Each extracted service gets a separate login that inherits the grants for its
domain. See the [Prisma schema](../../backend/prisma/schema.prisma) and [ERD](erd.md).

## Ownership and privileges

| Service         | Role                      | Tables and allowed writes                                                                                                                                                                                                                                                                                                        | Transitional reads and interfaces                                                                                                                                                                                      |
| --------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ticket          | `smartdesk_ticket`        | Creates and updates `tickets`, `support_teams`, `ticket_categories`, and `classification_labels`. Adds or removes `team_members`. Appends `ticket_comments`, `ticket_events`, `ai_recommendations`, and `recommendation_articles`. Updates only review metadata on recommendations. Owns `ai_analysis_jobs` and its lease state. | Reads account and revocation fields and article citation metadata. Enqueues Ticket search intents in the source transaction. Q01–Q04 stay with Ticket.                                                                 |
| Notifications   | `smartdesk_notifications` | Creates `notifications` and `notification_deliveries`. Updates notification read state and delivery state or leases.                                                                                                                                                                                                             | Reads ticket IDs and titles and the account and membership fields used by current inbox and delivery checks. Ticket events will supply notification intent.                                                            |
| Knowledge       | `smartdesk_knowledge`     | Creates, edits, publishes, and unpublishes `knowledge_articles`. Enqueues article search intents in the source transaction.                                                                                                                                                                                                      | Reads category and current account or membership fields. Revalidates published sources when serving AI requests.                                                                                                       |
| Identity        | `smartdesk_identity`      | Manages account state, roles, password hashes, and token versions in `users`. Appends `admin_audit_log`.                                                                                                                                                                                                                         | Exposes scoped account and revocation checks when independently deployed. Ticket keeps team membership authority.                                                                                                      |
| Analytics       | `smartdesk_analytics`     | Owns report queries. The current schema requires read privileges only.                                                                                                                                                                                                                                                           | Reads the exact source columns used by Q05–Q14 and the account ID, role, and active flag needed for the admin check. Ticket text, comments, recommendation suggestions, and password hashes stay outside these grants. |
| Search indexing | `smartdesk_search`        | Reads `search_index_jobs` and updates lease or progress fields.                                                                                                                                                                                                                                                                  | Reads rebuild state, Ticket projection fields, and `smartdesk_search_article_sources`. That view includes metadata for tombstones and returns text only for published articles.                                        |
| Gateway and AI  | None                      | Gateway routes requests. AI will run analysis and submit proposals through Ticket's authenticated commands.                                                                                                                                                                                                                      | Receive only the data permitted by HTTP and event contracts. Ticket owns the queue, saved recommendations, and human review.                                                                                           |

Ticket and Knowledge share the search intent table. PostgreSQL row policies scope each producer to
its entity type. Column grants let producers enqueue intent and deduplicate, while Search can
settle jobs without changing the entity, revision, or sequence. Existing row IDs, revisions,
leases, and deduplication keys remain in place. Search rebuild operations that lock source
tables stay with the maintenance account during this phase.
[PostgreSQL row security](https://www.postgresql.org/docs/16/ddl-rowsecurity.html)

`packages/db` exports the generated Prisma client and a PostgreSQL adapter. Its types cover the
whole schema, and the login selected by `DATABASE_URL` supplies the effective permissions.
Treat nullable fields and foreign key behavior exactly as specified by the existing schema.
The narrow grants use the same Q01–Q14 SQL, including the first routing event, half-open UTC
windows, and null aggregates. Application authorization still applies to every request.
[Database development](../database.md)

## Apply on an existing database

1. Apply the regular Prisma migrations with the migration account.
2. Have the DBA run `roles.sql` once per cluster. It creates non-login groups. Use these group
   names exclusively for the supplied access rules, and keep SQL object ownership with the
   migration account. Use one service group per runtime login with inheritance enabled and
   role switching and administration disabled.
3. If the current API or worker uses a non-owner account with existing search outbox grants,
   grant its login `smartdesk_legacy_search` before enabling the row policies. This membership
   only supplies the row policy, so the account retains exactly the object privileges it
   already has. The table owner can continue operating under its existing privileges.
4. Apply `enable.sql` as the application object owner during a short maintenance window.
   It applies grants, the search projection view, and row policies in one SQL statement.
   Resolve conflicting search policies and broad `PUBLIC` grants before applying it.

For the default disposable Compose database, the DBA and migration owner are both the
`smartdesk` development account.

```bash
docker compose exec backend npm run migrate
docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U smartdesk -d smartdesk < backend/sql/service-access/roles.sql
docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U smartdesk -d smartdesk < backend/sql/service-access/enable.sql
```

For example, use a separate Analytics login after applying the grants. Set its password through
your credential provisioning process. Keep its connection string with the Analytics runtime.

```sql
CREATE ROLE smartdesk_analytics_app LOGIN;
GRANT smartdesk_analytics TO smartdesk_analytics_app WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
```

The legacy Compose API and worker still perform operations for several domains. Keep their
current connection during the rollout. For example, the current Ticket event helper inserts
notifications in the same transaction for eligible events, so cut that path over only after
the transactional outbox and Notifications consumer are in place. The scoped Ticket account
already supports operations such as submission and recommendation review when the transaction
stays within Ticket-owned data. Use the isolated runtime logins for extracted handlers as those
handlers switch to the new command and event contracts.
[Role membership rules](https://www.postgresql.org/docs/16/sql-grant.html)

## Cutover, backfill, and rollback

The first cutover can happen in place. Verify the grants on a populated test database, exercise
the owner operation and denied cross-owner writes using the actual service login, and compare
report results against the legacy session. Drain the previous writer before switching the new
service to its scoped connection. Give migrations and privileged maintenance jobs separate
connections. Keep the legacy entrypoints available over the same current data until rollback
and regression checks pass.

For a later schema or storage move, take a consistent snapshot at a recorded checkpoint and
backfill with original IDs, timestamps, versions, and job and event identities. Replay committed
changes through the outbox between the checkpoint and cutover. Compare row counts, key sets,
constraints, and the Q01–Q14 results and confirm pending work can resume under the next owner.
Switch one writer at a time. Keep the previous reader and writer compatible until the rollback
window closes. [Migration ADR](../architecture/microservices-adr.md#migration-and-rollback)

To revert the access migration, stop the scoped consumers, restore legacy routing and
connections, and verify legacy health. Then revoke the staged grants and remove the added row
policies and projection view. The script preserves all business rows, sequences, pending jobs,
and cluster roles.

```bash
docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U smartdesk -d smartdesk < backend/sql/service-access/disable.sql
```

The backend integration suite applies and reverts the scripts against a seeded PostgreSQL
database. It uses separate service logins to check denied writes, operational and reporting
parity, Ticket transactions, and outbox isolation and recovery.
