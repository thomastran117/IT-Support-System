<!-- Generated from schema-spec.json by `docker compose --profile tools run --rm docs`. Do not edit by hand. -->

# Data dictionary

Every column of the eleven core tables, as deployed by the migrations in `backend/prisma/migrations`.
Types are PostgreSQL types (`timestamp(6) with time zone` is `TIMESTAMPTZ`; all times are UTC).

## `users`

_Identity._ Every person who signs in: employees raising tickets, technicians and administrators. Also holds the Argon2id credential and the JWT revocation counter (SD-013).

| Column | Type | Null | Default | Key | Unique | Indexes | Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `user_id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |  |  | Primary key. |
| `email` | `character varying(255)` | NOT NULL |  |  | yes | `users_email_key` | Login identity, stored lowercase (CHECK) and unique. |
| `display_name` | `character varying(120)` | NOT NULL |  |  |  |  | Name shown in audit history and ticket screens; nonblank. |
| `role` | `character varying(16)` | NOT NULL |  |  |  |  | EMPLOYEE, TECHNICIAN or ADMIN; drives authorization. |
| `is_active` | `boolean` | NOT NULL | `true` |  |  |  | FALSE deactivates the account without deleting history. |
| `created_at` | `timestamp(6) with time zone` | NOT NULL | `CURRENT_TIMESTAMP` |  |  |  | When the account was created (UTC). |
| `password_hash` | `character varying(255)` | NULL |  |  |  |  | Argon2id PHC string (salt and parameters embedded); NULL until a credential is provisioned, which blocks login. Never plaintext, never returned by the API. |
| `token_version` | `integer` | NOT NULL | `0` |  |  |  | Carried in every JWT. Incrementing it invalidates all of the user’s outstanding tokens (stateless revocation). |

**CHECK constraints**

- `ck_users_display_name_nonblank`: `(btrim((display_name)::text) <> ''::text)`
- `ck_users_email_normalized`: `(((email)::text = lower((email)::text)) AND (btrim((email)::text) <> ''::text))`
- `ck_users_password_hash_argon2id`: `((password_hash IS NULL) OR ((password_hash)::text ~~ '$argon2id$%'::text))`
- `ck_users_role`: `((role)::text = ANY ((ARRAY['EMPLOYEE'::character varying, 'TECHNICIAN'::character varying, 'ADMIN'::character varying])::text[]))`
- `ck_users_token_version_nonnegative`: `(token_version >= 0)`

## `support_teams`

_Identity._ Technician groups that tickets are routed to.

| Column | Type | Null | Default | Key | Unique | Indexes | Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `team_id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |  |  | Primary key. |
| `name` | `character varying(100)` | NOT NULL |  |  | yes | `support_teams_name_key` | Unique nonblank team name. |
| `description` | `text` | NULL |  |  |  |  | Optional description of the team's responsibilities. |
| `is_active` | `boolean` | NOT NULL | `true` |  |  |  | FALSE retires a team; old tickets keep their link. |

**CHECK constraints**

- `ck_support_teams_name_nonblank`: `(btrim((name)::text) <> ''::text)`

## `team_members`

_Identity._ Membership of users in support teams (many-to-many). Its key is the target of the tickets assignee composite FK.

| Column | Type | Null | Default | Key | Unique | Indexes | Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `team_id` | `uuid` | NOT NULL |  | PK (composite); FK → support_teams.team_id |  |  | Part of the primary key; the team. |
| `user_id` | `uuid` | NOT NULL |  | PK (composite); FK → users.user_id |  | `idx_team_members_user` | Part of the primary key; the member. |
| `joined_at` | `timestamp(6) with time zone` | NOT NULL | `CURRENT_TIMESTAMP` |  |  |  | When the user joined the team. |

## `ticket_categories`

_Identity._ Approved categories used for triage, knowledge articles and evaluation labels.

| Column | Type | Null | Default | Key | Unique | Indexes | Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `category_id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |  |  | Primary key. |
| `name` | `character varying(100)` | NOT NULL |  |  | yes | `ticket_categories_name_key` | Unique nonblank category name. |
| `description` | `text` | NULL |  |  |  |  | Optional description. |
| `is_active` | `boolean` | NOT NULL | `true` |  |  |  | FALSE retires a category without changing history. |
| `created_at` | `timestamp(6) with time zone` | NOT NULL | `CURRENT_TIMESTAMP` |  |  |  | Creation time (UTC). |

**CHECK constraints**

- `ck_ticket_categories_name_nonblank`: `(btrim((name)::text) <> ''::text)`

## `tickets`

_Tickets._ The support request and its technician-approved routing. AI proposals are stored separately in ai_recommendations.

| Column | Type | Null | Default | Key | Unique | Indexes | Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ticket_id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |  |  | Primary key and tracking identifier. |
| `requester_id` | `uuid` | NOT NULL |  | FK → users.user_id | with idempotency_key | `idx_tickets_requester_created`, `uq_tickets_requester_idempotency` | Employee who raised the ticket. |
| `assigned_team_id` | `uuid` | NULL |  | FK → team_members(team_id, user_id) composite; FK → support_teams.team_id |  | `idx_tickets_team_status_created` | Approved team; NULL until a technician routes the ticket. |
| `assignee_id` | `uuid` | NULL |  | FK → team_members(team_id, user_id) composite; FK → users.user_id |  |  | Approved technician; must belong to assigned_team_id (composite FK); NULL when unassigned. |
| `category_id` | `uuid` | NULL |  | FK → ticket_categories.category_id |  | `idx_tickets_category_created` | Approved category; NULL until triaged. |
| `title` | `character varying(150)` | NOT NULL |  |  |  |  | Short summary (max 150), nonblank. |
| `description` | `text` | NOT NULL |  |  |  |  | Problem details, nonblank. |
| `status` | `character varying(16)` | NOT NULL | `'OPEN'::character varying` |  |  | `idx_tickets_team_status_created` | OPEN, TRIAGED, IN_PROGRESS, RESOLVED or CLOSED. |
| `priority` | `character varying(10)` | NOT NULL | `'UNSET'::character varying` |  |  |  | UNSET, LOW, MEDIUM, HIGH or CRITICAL; approved by a technician. |
| `created_at` | `timestamp(6) with time zone` | NOT NULL | `CURRENT_TIMESTAMP` |  |  | `idx_tickets_category_created`, `idx_tickets_requester_created`, `idx_tickets_team_status_created` | Submission time (UTC). |
| `updated_at` | `timestamp(6) with time zone` | NOT NULL | `CURRENT_TIMESTAMP` |  |  |  | Last mutation time, set by the service. |
| `resolved_at` | `timestamp(6) with time zone` | NULL |  |  |  |  | Latest resolution time; NULL unless RESOLVED/CLOSED; cleared on reopen. |
| `resolution_summary` | `text` | NULL |  |  |  |  | Latest resolution text; required when RESOLVED/CLOSED; cleared on reopen. |
| `version` | `integer` | NOT NULL | `1` |  |  |  | Optimistic concurrency token; incremented by every mutation, checked by writers. |
| `idempotency_key` | `character varying(100)` | NULL |  |  | with requester_id | `uq_tickets_requester_idempotency` | Optional client key (Idempotency-Key header); unique per requester so a retried submission returns the original ticket. |
| `first_response_at` | `timestamp(6) with time zone` | NULL |  |  |  |  | Posting time of the first public comment by a technician or administrator other than the requester; NULL until then. Stable: set with the comment, never cleared. |

**CHECK constraints**

- `ck_tickets_assignee_requires_team`: `((assignee_id IS NULL) OR (assigned_team_id IS NOT NULL))`
- `ck_tickets_description_nonblank`: `(btrim(description) <> ''::text)`
- `ck_tickets_first_response_after_created`: `((first_response_at IS NULL) OR (first_response_at >= created_at))`
- `ck_tickets_idempotency_key_nonblank`: `((idempotency_key IS NULL) OR (length(btrim((idempotency_key)::text)) > 0))`
- `ck_tickets_no_stale_resolution`: `(((status)::text = ANY ((ARRAY['RESOLVED'::character varying, 'CLOSED'::character varying])::text[])) OR ((resolved_at IS NULL) AND (resolution_summary IS NULL)))`
- `ck_tickets_priority`: `((priority)::text = ANY ((ARRAY['UNSET'::character varying, 'LOW'::character varying, 'MEDIUM'::character varying, 'HIGH'::character varying, 'CRITICAL'::character varying])::text[]))`
- `ck_tickets_resolution_required`: `(((status)::text <> ALL ((ARRAY['RESOLVED'::character varying, 'CLOSED'::character varying])::text[])) OR ((resolved_at IS NOT NULL) AND (resolution_summary IS NOT NULL) AND (btrim(resolution_summary) <> ''::text)))`
- `ck_tickets_resolved_after_created`: `((resolved_at IS NULL) OR (resolved_at >= created_at))`
- `ck_tickets_status`: `((status)::text = ANY ((ARRAY['OPEN'::character varying, 'TRIAGED'::character varying, 'IN_PROGRESS'::character varying, 'RESOLVED'::character varying, 'CLOSED'::character varying])::text[]))`
- `ck_tickets_title_nonblank`: `(btrim((title)::text) <> ''::text)`
- `ck_tickets_triaged_requirements`: `(((status)::text <> ALL ((ARRAY['TRIAGED'::character varying, 'IN_PROGRESS'::character varying])::text[])) OR ((category_id IS NOT NULL) AND ((priority)::text <> 'UNSET'::text) AND (assigned_team_id IS NOT NULL)))`
- `ck_tickets_version_positive`: `(version >= 1)`

## `ticket_comments`

_Tickets._ Public replies and technician-only internal notes on a ticket. Append-only: UPDATE and DELETE are rejected by a trigger (SD-021).

| Column | Type | Null | Default | Key | Unique | Indexes | Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `comment_id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |  |  | Primary key. |
| `ticket_id` | `uuid` | NOT NULL |  | FK → tickets.ticket_id |  | `idx_ticket_comments_ticket_created` | Ticket commented on. |
| `author_id` | `uuid` | NOT NULL |  | FK → users.user_id |  |  | User who wrote the comment. |
| `body` | `text` | NOT NULL |  |  |  |  | Comment text, nonblank. |
| `is_internal` | `boolean` | NOT NULL | `false` |  |  |  | TRUE for technician-only notes, never shown to the requester. |
| `created_at` | `timestamp(6) with time zone` | NOT NULL | `CURRENT_TIMESTAMP` |  |  | `idx_ticket_comments_ticket_created` | Posting time (UTC). |

**CHECK constraints**

- `ck_ticket_comments_body_nonblank`: `(btrim(body) <> ''::text)`

## `ticket_events`

_Tickets._ Append-only audit trail: every mutation writes an event in the same transaction. UPDATE and DELETE are rejected by a trigger.

| Column | Type | Null | Default | Key | Unique | Indexes | Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `event_id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |  | `idx_ticket_events_ticket_occurred` | Primary key; tie-breaker for equal timestamps. |
| `ticket_id` | `uuid` | NOT NULL |  | FK → tickets.ticket_id |  | `idx_ticket_events_ticket_occurred` | Ticket the event belongs to. |
| `actor_id` | `uuid` | NULL |  | FK → users.user_id |  |  | Acting user; NULL means a system actor. |
| `event_type` | `character varying(32)` | NOT NULL |  |  |  |  | One of the approved event codes (see event catalogue). |
| `details` | `jsonb` | NOT NULL | `'{}'::jsonb` |  |  |  | JSON object with sanitized context (ids and values, never comment text or secrets). |
| `occurred_at` | `timestamp(6) with time zone` | NOT NULL | `CURRENT_TIMESTAMP` |  |  | `idx_ticket_events_ticket_occurred` | Event time (UTC), database clock. |

**CHECK constraints**

- `ck_ticket_events_details_object`: `(jsonb_typeof(details) = 'object'::text)`
- `ck_ticket_events_type`: `((event_type)::text = ANY ((ARRAY['CREATED'::character varying, 'STATUS_CHANGED'::character varying, 'TEAM_ASSIGNED'::character varying, 'TEAM_REASSIGNED'::character varying, 'COMMENT_ADDED'::character varying, 'AI_REVIEWED'::character varying, 'RESOLVED'::character varying, 'REOPENED'::character varying, 'CATEGORY_UPDATED'::character varying, 'PRIORITY_UPDATED'::character varying, 'ASSIGNEE_UPDATED'::character varying])::text[]))`

## `ai_recommendations`

_AI and evaluation._ Immutable AI proposals plus the human review outcome. Proposals never overwrite approved ticket values.

| Column | Type | Null | Default | Key | Unique | Indexes | Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `recommendation_id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |  | `idx_ai_recommendations_ticket_created` | Primary key. |
| `ticket_id` | `uuid` | NOT NULL |  | FK → tickets.ticket_id |  | `idx_ai_recommendations_ticket_created` | Ticket analysed. |
| `proposed_category_id` | `uuid` | NULL |  | FK → ticket_categories.category_id |  |  | AI-proposed category (original, never edited). |
| `proposed_team_id` | `uuid` | NULL |  | FK → support_teams.team_id |  |  | AI-proposed team (original). |
| `proposed_priority` | `character varying(10)` | NULL |  |  |  |  | AI-proposed priority LOW..CRITICAL (original). |
| `suggestion` | `text` | NULL |  |  |  |  | AI troubleshooting suggestion text. |
| `confidence` | `numeric(4,3)` | NULL |  |  |  |  | Model confidence 0..1, NUMERIC(4,3); not a calibrated probability. |
| `model_version` | `character varying(100)` | NOT NULL |  |  |  |  | Model/prompt version that produced it; nonblank. |
| `review_status` | `character varying(12)` | NOT NULL | `'PENDING'::character varying` |  |  |  | PENDING, ACCEPTED, OVERRIDDEN or REJECTED. |
| `reviewer_id` | `uuid` | NULL |  | FK → users.user_id |  |  | Technician who reviewed; required once reviewed, NULL while PENDING. |
| `reviewed_at` | `timestamp(6) with time zone` | NULL |  |  |  |  | Review time; required once reviewed, never before created_at. |
| `review_notes` | `text` | NULL |  |  |  |  | Optional reviewer comment. |
| `created_at` | `timestamp(6) with time zone` | NOT NULL | `CURRENT_TIMESTAMP` |  |  | `idx_ai_recommendations_ticket_created` | When the proposal was saved (UTC). |

**CHECK constraints**

- `ck_ai_recommendations_confidence`: `((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))`
- `ck_ai_recommendations_model_version_nonblank`: `(btrim((model_version)::text) <> ''::text)`
- `ck_ai_recommendations_priority`: `((proposed_priority IS NULL) OR ((proposed_priority)::text = ANY ((ARRAY['LOW'::character varying, 'MEDIUM'::character varying, 'HIGH'::character varying, 'CRITICAL'::character varying])::text[])))`
- `ck_ai_recommendations_review_complete`: `((((review_status)::text = 'PENDING'::text) AND (reviewer_id IS NULL) AND (reviewed_at IS NULL)) OR (((review_status)::text <> 'PENDING'::text) AND (reviewer_id IS NOT NULL) AND (reviewed_at IS NOT NULL)))`
- `ck_ai_recommendations_review_status`: `((review_status)::text = ANY ((ARRAY['PENDING'::character varying, 'ACCEPTED'::character varying, 'OVERRIDDEN'::character varying, 'REJECTED'::character varying])::text[]))`
- `ck_ai_recommendations_reviewed_after_created`: `((reviewed_at IS NULL) OR (reviewed_at >= created_at))`

## `knowledge_articles`

_AI and evaluation._ Troubleshooting articles searched by employees and linked from recommendations.

| Column | Type | Null | Default | Key | Unique | Indexes | Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `article_id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |  |  | Primary key. |
| `category_id` | `uuid` | NULL |  | FK → ticket_categories.category_id |  |  | Optional category. |
| `title` | `character varying(200)` | NOT NULL |  |  |  |  | Article title (max 200), nonblank. |
| `body` | `text` | NOT NULL |  |  |  |  | Article text, nonblank. |
| `is_published` | `boolean` | NOT NULL | `false` |  |  |  | Only published articles are visible to employees. |
| `created_at` | `timestamp(6) with time zone` | NOT NULL | `CURRENT_TIMESTAMP` |  |  |  | Creation time (UTC). |
| `updated_at` | `timestamp(6) with time zone` | NOT NULL | `CURRENT_TIMESTAMP` |  |  |  | Last edit time, set by the service. |

**CHECK constraints**

- `ck_knowledge_articles_body_nonblank`: `(btrim(body) <> ''::text)`
- `ck_knowledge_articles_title_nonblank`: `(btrim((title)::text) <> ''::text)`

## `recommendation_articles`

_AI and evaluation._ Ranked knowledge articles attached to a recommendation (many-to-many).

| Column | Type | Null | Default | Key | Unique | Indexes | Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `recommendation_id` | `uuid` | NOT NULL |  | PK (composite); FK → ai_recommendations.recommendation_id | with relevance_rank | `uq_recommendation_articles_rank` | Part of the primary key. |
| `article_id` | `uuid` | NOT NULL |  | PK (composite); FK → knowledge_articles.article_id |  | `idx_recommendation_articles_article` | Part of the primary key. |
| `relevance_rank` | `integer` | NOT NULL |  |  | with recommendation_id | `uq_recommendation_articles_rank` | Display order, 1 is most relevant; > 0 and unique per recommendation. |

**CHECK constraints**

- `ck_recommendation_articles_rank_positive`: `(relevance_rank > 0)`

## `classification_labels`

_AI and evaluation._ Independent reference category per ticket, used only to measure AI accuracy; never copied from AI output.

| Column | Type | Null | Default | Key | Unique | Indexes | Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ticket_id` | `uuid` | NOT NULL |  | PK; FK → tickets.ticket_id |  |  | Primary key and foreign key: at most one label per ticket. |
| `reference_category_id` | `uuid` | NOT NULL |  | FK → ticket_categories.category_id |  | `idx_classification_labels_category` | Correct category as judged by the evaluator. |
| `labelled_by` | `uuid` | NOT NULL |  | FK → users.user_id |  |  | Evaluator (user) who assigned the label. |
| `labelled_at` | `timestamp(6) with time zone` | NOT NULL | `CURRENT_TIMESTAMP` |  |  |  | Labelling time (UTC). |

## `admin_audit_log`

_Identity._ Append-only audit trail of administrator account actions (SD-017): create, activate, deactivate, role change, password reset. UPDATE and DELETE are rejected by a trigger. Never holds credentials.

| Column | Type | Null | Default | Key | Unique | Indexes | Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `audit_id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |  | `idx_admin_audit_created` | Primary key. |
| `actor_id` | `uuid` | NOT NULL |  | FK → users.user_id |  |  | Administrator who performed the action. |
| `target_user_id` | `uuid` | NOT NULL |  | FK → users.user_id |  | `idx_admin_audit_target` | Account the action was applied to. |
| `action` | `character varying(32)` | NOT NULL |  |  |  |  | USER_CREATED, USER_ACTIVATED, USER_DEACTIVATED, ROLE_CHANGED or PASSWORD_RESET. |
| `details` | `jsonb` | NOT NULL | `'{}'::jsonb` |  |  |  | JSON object with non-sensitive context, for example the previous and new role. Never a password, hash or token. |
| `created_at` | `timestamp(6) with time zone` | NOT NULL | `CURRENT_TIMESTAMP` |  |  | `idx_admin_audit_created`, `idx_admin_audit_target` | When the action happened (UTC), database clock. |

**CHECK constraints**

- `ck_admin_audit_action`: `((action)::text = ANY ((ARRAY['USER_CREATED'::character varying, 'USER_ACTIVATED'::character varying, 'USER_DEACTIVATED'::character varying, 'ROLE_CHANGED'::character varying, 'PASSWORD_RESET'::character varying])::text[]))`
- `ck_admin_audit_details_object`: `(jsonb_typeof(details) = 'object'::text)`

## `ai_analysis_jobs`

_AI and evaluation._ Durable queue for AI ticket analysis (SD-035), a transactional outbox. A job is inserted in the same transaction as its ticket; workers claim rows with FOR UPDATE SKIP LOCKED and a time-limited lease, so work survives worker restarts and is never lost between ticket commit and dispatch. (ticket_id, request_id) is the idempotency key. Holds reason codes only, never ticket text, provider messages or secrets.

| Column | Type | Null | Default | Key | Unique | Indexes | Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `job_id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |  |  | Primary key. |
| `ticket_id` | `uuid` | NOT NULL |  | FK → tickets.ticket_id | with request_id | `idx_ai_jobs_ticket`, `uq_ai_analysis_jobs_ticket_request` | Ticket being analysed. |
| `request_id` | `uuid` | NOT NULL | `gen_random_uuid()` |  | with ticket_id | `uq_ai_analysis_jobs_ticket_request` | Analysis request identifier; with ticket_id it makes enqueueing idempotent. A re-analysis uses a new one. |
| `state` | `character varying(10)` | NOT NULL | `'QUEUED'::character varying` |  |  | `idx_ai_jobs_claim` | QUEUED, RUNNING, COMPLETED or FAILED. |
| `attempts` | `integer` | NOT NULL | `0` |  |  |  | Number of times the job has been claimed. |
| `max_attempts` | `integer` | NOT NULL | `3` |  |  |  | Claims allowed before the job fails terminally. |
| `run_after` | `timestamp(6) with time zone` | NOT NULL | `CURRENT_TIMESTAMP` |  |  | `idx_ai_jobs_claim` | Earliest time the job may be claimed (retry backoff). |
| `lease_token` | `uuid` | NULL |  |  |  |  | Rotated on every claim; only the holder may complete or fail the job. NULL unless RUNNING. |
| `locked_until` | `timestamp(6) with time zone` | NULL |  |  |  |  | Lease expiry. A RUNNING job past this time is re-claimed. NULL unless RUNNING. |
| `error_kind` | `character varying(24)` | NULL |  |  |  |  | Reason code of the latest failed attempt (for example timeout, rate_limited, malformed, internal, worker_lost). Never message text. |
| `created_at` | `timestamp(6) with time zone` | NOT NULL | `CURRENT_TIMESTAMP` |  |  | `idx_ai_jobs_ticket` | When the job was queued. |
| `updated_at` | `timestamp(6) with time zone` | NOT NULL | `CURRENT_TIMESTAMP` |  |  |  | Last state change. |
| `completed_at` | `timestamp(6) with time zone` | NULL |  |  |  |  | When the job reached COMPLETED or FAILED; NULL otherwise. |

**CHECK constraints**

- `ck_ai_jobs_attempts`: `((attempts >= 0) AND (max_attempts > 0))`
- `ck_ai_jobs_lease`: `(((state)::text = 'RUNNING'::text) = ((lease_token IS NOT NULL) AND (locked_until IS NOT NULL)))`
- `ck_ai_jobs_state`: `((state)::text = ANY ((ARRAY['QUEUED'::character varying, 'RUNNING'::character varying, 'COMPLETED'::character varying, 'FAILED'::character varying])::text[]))`
- `ck_ai_jobs_terminal`: `(((state)::text = ANY ((ARRAY['COMPLETED'::character varying, 'FAILED'::character varying])::text[])) = (completed_at IS NOT NULL))`
