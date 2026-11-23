-- Observability read-path indexes (additive).
--
-- `/v1/observability` aggregates a real 24h window over the durable journal and
-- scans review/worker completion windows. Without these indexes every poll is a
-- full table scan of events_outbox, which grows by ~10k rows/day.
CREATE INDEX IF NOT EXISTS idx_outbox_created ON events_outbox(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_completed ON review_jobs(completed_at);
CREATE INDEX IF NOT EXISTS idx_workers_finished ON workers(finished_at);
