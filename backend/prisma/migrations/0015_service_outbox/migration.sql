ALTER TABLE ai_analysis_jobs ADD COLUMN correlation_id varchar(64);
ALTER TABLE ai_analysis_jobs ADD CONSTRAINT ck_ai_jobs_correlation
  CHECK (correlation_id ~ '^[a-f0-9]{64}$');

CREATE TABLE service_outbox_events (
  event_id uuid PRIMARY KEY,
  schema_version smallint NOT NULL,
  type varchar(48) NOT NULL,
  occurred_at timestamptz(6) NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL,
  correlation_id varchar(64) NOT NULL,
  payload jsonb NOT NULL,
  CONSTRAINT service_outbox_events_aggregate_id_fkey
    FOREIGN KEY (aggregate_id) REFERENCES tickets(ticket_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT ck_service_events_envelope CHECK (
    schema_version > 0 AND aggregate_version >= 0
    AND correlation_id ~ '^([a-f0-9]{64}|[a-f0-9-]{36})$'
    AND jsonb_typeof(payload) = 'object'
  )
);

CREATE INDEX idx_service_events_type_order ON service_outbox_events(type, occurred_at, event_id);
CREATE INDEX idx_service_events_aggregate ON service_outbox_events(aggregate_id, occurred_at, event_id);

CREATE FUNCTION service_outbox_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'service_outbox_events is append-only (% not allowed)', TG_OP;
END;
$$;

CREATE TRIGGER trg_service_outbox_events_append_only
  BEFORE UPDATE OR DELETE ON service_outbox_events
  FOR EACH ROW EXECUTE FUNCTION service_outbox_events_append_only();

CREATE TABLE service_outbox_deliveries (
  consumer varchar(48) NOT NULL,
  event_id uuid NOT NULL,
  state varchar(10) NOT NULL DEFAULT 'QUEUED',
  attempts integer NOT NULL DEFAULT 0,
  run_after timestamptz(6) NOT NULL DEFAULT now(),
  lease_token uuid,
  locked_until timestamptz(6),
  finished_at timestamptz(6),
  error_kind varchar(24),
  PRIMARY KEY (consumer, event_id),
  CONSTRAINT service_outbox_deliveries_event_id_fkey
    FOREIGN KEY (event_id) REFERENCES service_outbox_events(event_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT ck_service_deliveries_state CHECK (
    attempts >= 0
    AND consumer ~ '^[a-z][a-z0-9-]{0,47}$'
    AND (error_kind IS NULL OR error_kind IN ('handler_failed', 'invalid_event', 'worker_lost'))
    AND (
      (state = 'QUEUED' AND lease_token IS NULL AND locked_until IS NULL AND finished_at IS NULL)
      OR (state = 'RUNNING' AND lease_token IS NOT NULL AND locked_until IS NOT NULL AND finished_at IS NULL)
      OR (state = 'COMPLETED' AND lease_token IS NULL AND locked_until IS NULL AND finished_at IS NOT NULL AND error_kind IS NULL)
      OR (state = 'FAILED' AND lease_token IS NULL AND locked_until IS NULL AND finished_at IS NOT NULL AND error_kind IS NOT NULL)
    )
  )
);

CREATE INDEX idx_service_deliveries_claim ON service_outbox_deliveries(consumer, state, run_after);
CREATE INDEX idx_service_deliveries_lease ON service_outbox_deliveries(consumer, state, locked_until);
CREATE INDEX idx_service_deliveries_event ON service_outbox_deliveries(event_id);
