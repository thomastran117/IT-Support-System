# Database deviations from Deliverable 2

Every intentional difference between the Deliverable 2 design and the deployed schema is recorded
here with its rationale. The full ERD and data dictionary are added by SD-012.

| #   | Area                | Deviation                                                                                                                                                                                  | Rationale                                                                                             |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 1   | Repository layout   | Prisma schema, migrations and config live in `backend/prisma/` (as the E01 issues specify); the generated client is emitted to `packages/db/src/generated` so backend and worker share it. | Keeps the issue paths while preserving the E00 `@smartdesk/db` client package used by both processes. |
| 2   | Timestamp precision | `TIMESTAMPTZ(6)` (microseconds, PostgreSQL's native precision) and `DEFAULT CURRENT_TIMESTAMP` (equivalent to `NOW()`).                                                                    | This is what Prisma emits for `Timestamptz(6)` / `@default(now())`; semantics match the dictionary.   |
| 3   | Enumerated columns  | `role`, `status`, `priority`, `review_status`, `event_type` are `VARCHAR` columns, not PostgreSQL enums or Prisma enums. Allowed values are enforced by CHECK constraints (SD-007).        | The dictionary specifies `VARCHAR(n)`; CHECKs are easier to evolve by migration than enum types.      |
| 4   | Foreign-key update  | Prisma generates `ON UPDATE CASCADE` on foreign keys; every `ON DELETE` is `RESTRICT`.                                                                                                     | Keys are immutable UUIDs, so update cascade is inert. Deletes never cascade, preserving history.      |
