<!-- Generated from schema-spec.json by `npm run docs:db -w backend`. Do not edit by hand. -->

# Entity-relationship diagram

The eleven core SmartDesk entities as deployed by the Prisma migrations. Field details are in
[data-dictionary.md](./data-dictionary.md); rules and enumerations are in [README.md](./README.md).

```mermaid
erDiagram
  users {
    uuid user_id PK
    varchar email
    varchar display_name
    varchar role
    bool is_active
    timestamptz created_at
    varchar password_hash
    int token_version
  }
  support_teams {
    uuid team_id PK
    varchar name
    text description
    bool is_active
  }
  team_members {
    uuid team_id PK,FK
    uuid user_id PK,FK
    timestamptz joined_at
  }
  ticket_categories {
    uuid category_id PK
    varchar name
    text description
    bool is_active
    timestamptz created_at
  }
  tickets {
    uuid ticket_id PK
    uuid requester_id FK
    uuid assigned_team_id FK
    uuid assignee_id FK
    uuid category_id FK
    varchar title
    text description
    varchar status
    varchar priority
    timestamptz created_at
    timestamptz updated_at
    timestamptz resolved_at
    text resolution_summary
    int version
    varchar idempotency_key
    timestamptz first_response_at
  }
  ticket_comments {
    uuid comment_id PK
    uuid ticket_id FK
    uuid author_id FK
    text body
    bool is_internal
    timestamptz created_at
  }
  ticket_events {
    uuid event_id PK
    uuid ticket_id FK
    uuid actor_id FK
    varchar event_type
    jsonb details
    timestamptz occurred_at
  }
  ai_recommendations {
    uuid recommendation_id PK
    uuid ticket_id FK
    uuid proposed_category_id FK
    uuid proposed_team_id FK
    varchar proposed_priority
    text suggestion
    numeric confidence
    varchar model_version
    varchar review_status
    uuid reviewer_id FK
    timestamptz reviewed_at
    text review_notes
    timestamptz created_at
  }
  knowledge_articles {
    uuid article_id PK
    uuid category_id FK
    varchar title
    text body
    bool is_published
    timestamptz created_at
    timestamptz updated_at
  }
  recommendation_articles {
    uuid recommendation_id PK,FK
    uuid article_id PK,FK
    int relevance_rank
  }
  classification_labels {
    uuid ticket_id PK,FK
    uuid reference_category_id FK
    uuid labelled_by FK
    timestamptz labelled_at
  }
  admin_audit_log {
    uuid audit_id PK
    uuid actor_id FK
    uuid target_user_id FK
    varchar action
    jsonb details
    timestamptz created_at
  }
  support_teams ||--o{ team_members : "team_id"
  users ||--o{ team_members : "user_id"
  team_members |o--o{ tickets : "assigned_team_id, assignee_id"
  support_teams |o--o{ tickets : "assigned_team_id"
  users |o--o{ tickets : "assignee_id"
  ticket_categories |o--o{ tickets : "category_id"
  users ||--o{ tickets : "requester_id"
  users ||--o{ ticket_comments : "author_id"
  tickets ||--o{ ticket_comments : "ticket_id"
  users |o--o{ ticket_events : "actor_id"
  tickets ||--o{ ticket_events : "ticket_id"
  ticket_categories |o--o{ ai_recommendations : "proposed_category_id"
  support_teams |o--o{ ai_recommendations : "proposed_team_id"
  users |o--o{ ai_recommendations : "reviewer_id"
  tickets ||--o{ ai_recommendations : "ticket_id"
  ticket_categories |o--o{ knowledge_articles : "category_id"
  knowledge_articles ||--o{ recommendation_articles : "article_id"
  ai_recommendations ||--o{ recommendation_articles : "recommendation_id"
  users ||--o{ classification_labels : "labelled_by"
  ticket_categories ||--o{ classification_labels : "reference_category_id"
  tickets ||--o| classification_labels : "ticket_id"
  users ||--o{ admin_audit_log : "actor_id"
  users ||--o{ admin_audit_log : "target_user_id"
```

## Relationships

Cardinality is `parent : child`. Every foreign key is `ON DELETE RESTRICT`: history is deactivated,
never cascaded away. `tickets` references `users` twice (requester and assignee) and `team_members`
through the composite key `(assigned_team_id, assignee_id)`, which guarantees the assignee belongs to
the assigned team.

| Child table | Foreign key | Parent | Cardinality | Presence | On delete |
| --- | --- | --- | --- | --- | --- |
| `team_members` | `team_id` | `support_teams` (`team_id`) | 1 : N | required | RESTRICT |
| `team_members` | `user_id` | `users` (`user_id`) | 1 : N | required | RESTRICT |
| `tickets` | `assigned_team_id, assignee_id` | `team_members` (`team_id, user_id`) | 0..1 : N | optional | RESTRICT |
| `tickets` | `assigned_team_id` | `support_teams` (`team_id`) | 0..1 : N | optional | RESTRICT |
| `tickets` | `assignee_id` | `users` (`user_id`) | 0..1 : N | optional | RESTRICT |
| `tickets` | `category_id` | `ticket_categories` (`category_id`) | 0..1 : N | optional | RESTRICT |
| `tickets` | `requester_id` | `users` (`user_id`) | 1 : N | required | RESTRICT |
| `ticket_comments` | `author_id` | `users` (`user_id`) | 1 : N | required | RESTRICT |
| `ticket_comments` | `ticket_id` | `tickets` (`ticket_id`) | 1 : N | required | RESTRICT |
| `ticket_events` | `actor_id` | `users` (`user_id`) | 0..1 : N | optional | RESTRICT |
| `ticket_events` | `ticket_id` | `tickets` (`ticket_id`) | 1 : N | required | RESTRICT |
| `ai_recommendations` | `proposed_category_id` | `ticket_categories` (`category_id`) | 0..1 : N | optional | RESTRICT |
| `ai_recommendations` | `proposed_team_id` | `support_teams` (`team_id`) | 0..1 : N | optional | RESTRICT |
| `ai_recommendations` | `reviewer_id` | `users` (`user_id`) | 0..1 : N | optional | RESTRICT |
| `ai_recommendations` | `ticket_id` | `tickets` (`ticket_id`) | 1 : N | required | RESTRICT |
| `knowledge_articles` | `category_id` | `ticket_categories` (`category_id`) | 0..1 : N | optional | RESTRICT |
| `recommendation_articles` | `article_id` | `knowledge_articles` (`article_id`) | 1 : N | required | RESTRICT |
| `recommendation_articles` | `recommendation_id` | `ai_recommendations` (`recommendation_id`) | 1 : N | required | RESTRICT |
| `classification_labels` | `labelled_by` | `users` (`user_id`) | 1 : N | required | RESTRICT |
| `classification_labels` | `reference_category_id` | `ticket_categories` (`category_id`) | 1 : N | required | RESTRICT |
| `classification_labels` | `ticket_id` | `tickets` (`ticket_id`) | 1 : 0..1 | required | RESTRICT |
| `admin_audit_log` | `actor_id` | `users` (`user_id`) | 1 : N | required | RESTRICT |
| `admin_audit_log` | `target_user_id` | `users` (`user_id`) | 1 : N | required | RESTRICT |
