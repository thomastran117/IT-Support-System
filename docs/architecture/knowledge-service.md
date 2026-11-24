# Independent Knowledge service

SD-096 moves the reader and authoring APIs under `/api/knowledge` and `/api/admin/knowledge`
to an opt-in Fastify service. It shares the article handlers with local mode and uses
PostgreSQL full-text search for published results. Local mode can still use the optional
OpenSearch adapter. Article publication and published edits write revisioned search intent
in the same transaction as the source row. The existing index worker can replay these
intents when OpenSearch is enabled.

Knowledge delegates browser token verification to Identity. Identity checks current account
state and returns the ID and role. Knowledge checks the role for every request and requires
`ADMIN` for authoring. Drafts and unpublished articles return `404` on the reader route
and stay out of search. Unpublishing preserves the article and its historical recommendation
links. The current Ticket API filters links to unpublished articles from its response.
[Service authentication](../authentication.md#internal-service-authentication)

The independent AI runner takes redacted ticket inputs from Ticket under its active lease.
It sends at most 12 terms to Knowledge's private retrieval endpoint using its scoped system
credential. The local AI worker uses a separate scoped credential. Knowledge verifies
publication and revision before returning up to five redacted, bounded excerpts. Requests
have a 1.5-second client timeout. If retrieval fails, analysis can proceed with an empty
article list. Ticket checks that citations remain published at completion and keeps its
existing recommendation transaction. Manual ticket routes use the Ticket service
throughout an outage.

## Cutover

1. Apply the Prisma migrations and staged PostgreSQL grants. Reapply `enable.sql` on
   databases with older staged grants so Knowledge can read category descriptions. Provision
   a login that inherits only `smartdesk_knowledge` and supply its connection string in
   `KNOWLEDGE_DATABASE_URL`. [Role setup](../database/service-access.md)
2. Set `KNOWLEDGE_KEY_ID` and supply its P-256 PKCS#8 key in `KNOWLEDGE_PRIVATE_KEY`.
   Add the matching SPKI public key to `INTERNAL_SERVICE_KEYS` under service `knowledge`
   with the `identity:knowledge-principal` user grant.
3. Put the active AI runtime's public key in `KNOWLEDGE_RETRIEVAL_KEYS` with the
   `knowledge:published-retrieval` system grant. For the independent AI runner, use the
   existing `ai` key. For the local worker, supply `KNOWLEDGE_WORKER_KEY_ID` and
   `KNOWLEDGE_WORKER_PRIVATE_KEY` and register its public key under service `ai-local`.
   Use HTTPS for `KNOWLEDGE_IDENTITY_ORIGIN` and `KNOWLEDGE_RETRIEVAL_ORIGIN` in production.
4. Start Knowledge while `KNOWLEDGE_EXECUTION_MODE=local`.

```bash
docker compose --profile knowledge up -d --build --wait knowledge-service
```

Set `KNOWLEDGE_EXECUTION_MODE=service` and recreate the backend, gateway, and worker.
Recreate the AI service if it is active. Verify a published search, a draft request, an
admin write, and an AI job against the gateway and private retrieval path.

```bash
docker compose up -d --build backend gateway worker
# Run with independent AI enabled
docker compose --profile services up -d --build --wait ai-service
```

## Rollback

Stop Knowledge to drain its current requests. Restore `KNOWLEDGE_EXECUTION_MODE=local`
and recreate the same backend, gateway, worker, and active AI containers. Verify both
reader and admin routes. The previous handler reads the same article rows and revisions.
The index worker can continue delivering pending search intents.

```bash
docker compose --profile knowledge stop knowledge-service
docker compose up -d --build backend gateway worker
# Run with independent AI enabled
docker compose --profile services up -d --build --wait ai-service
```

Compose verification covers publication, current content and draft denial, AI retrieval and
outage recovery in both execution modes, search intent, historical citation links, and rollback.
[Compose verification](../../docker/verify-knowledge-service.sh)
