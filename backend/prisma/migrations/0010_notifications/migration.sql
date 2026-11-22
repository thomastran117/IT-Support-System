-- SD-040: in-app notifications for employees.
--
-- A row is written in the SAME transaction as the ticket event that caused it (see appendEvent), so
-- a rolled-back change leaves neither an event nor a notification, and a committed one always has
-- its notification. `(recipient_id, event_id, type)` is the deduplication key: recording the same
-- event for the same recipient twice yields one user-visible item. No message text is stored; the
-- visible wording is derived from `type` and the ticket when read, so internal-note text, comment
-- bodies and other private details can never be copied into a notification.
CREATE TABLE "notifications" (
    "notification_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recipient_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "type" VARCHAR(24) NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("notification_id")
);

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "notifications_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "notifications_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "ticket_events"("event_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "uq_notifications_recipient_event_type" UNIQUE ("recipient_id", "event_id", "type"),
  ADD CONSTRAINT "ck_notifications_type" CHECK (
    "type" IN ('TICKET_ASSIGNED', 'TICKET_STATUS_CHANGED', 'TICKET_RESOLVED', 'TICKET_REOPENED', 'TECHNICIAN_REPLY')
  );

-- Newest-first inbox listing per recipient.
CREATE INDEX "idx_notifications_recipient_created" ON "notifications"("recipient_id", "created_at" DESC, "notification_id" DESC);
CREATE INDEX "idx_notifications_ticket" ON "notifications"("ticket_id");
