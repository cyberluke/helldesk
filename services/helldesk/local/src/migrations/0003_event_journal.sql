-- HELLDESK Local schema (v3) — bank-grade service-owned event journal.
-- ADDITIVE migration: preserves all v1/v2 data/jobs/reports/epochs.
-- Adds a durable plugin->daemon event journal (idempotent, ack/reply, resume),
-- plus per-host high-water marks and protocol lockstep. user_version 2 -> 3.

-- Plugin->daemon event journal. UNIQUE (host_id, event_id) makes frame delivery
-- idempotent: a replayed frame is a no-op acknowledgment (never double-effect).
-- Indexed by (runtime_id, session_id, local_seq) for ordered resume. A row is
-- committed in the SAME transaction that sends ack(localSeq), so ACK is never
-- sent before the event is durably accepted.
CREATE TABLE IF NOT EXISTS event_journal (
  journal_seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id         TEXT NOT NULL,
  runtime_id      TEXT,
  session_id      TEXT,
  turn_id         TEXT,
  event_id        TEXT NOT NULL,
  local_seq       INTEGER NOT NULL,
  event_type      TEXT NOT NULL,             -- chat.message|turn.started|file.edited|session.*|tool.*
  protocol_version INTEGER NOT NULL DEFAULT 1,
  payload         TEXT NOT NULL,             -- raw validated payload (JSON)
  received_at     TEXT NOT NULL,
  UNIQUE (host_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_ej_host_session_seq ON event_journal(host_id, session_id, local_seq);
CREATE INDEX IF NOT EXISTS idx_ej_runtime_session ON event_journal(runtime_id, session_id, local_seq);

-- Per-host durable high-water mark + protocol/lease state (survives daemon restart).
CREATE TABLE IF NOT EXISTS host_runtime_state (
  host_id           TEXT PRIMARY KEY,
  last_acked_seq    INTEGER NOT NULL DEFAULT 0,   -- plugin's lastSeqSent we Acked (resume from here)
  protocol_version  INTEGER NOT NULL DEFAULT 1,
  connection_generation INTEGER NOT NULL DEFAULT 0,
  lease_seconds     INTEGER NOT NULL DEFAULT 120,
  last_seen_at      TEXT NOT NULL
);

-- Task-epoch completion decision is daemon-owned and durable. Add columns to
-- record eligibility raw events so a daemon/IDE crash never erases completion.
ALTER TABLE task_epochs ADD COLUMN assistant_delivered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_epochs ADD COLUMN tools_running INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_epochs ADD COLUMN quiet_deadline_at TEXT;
ALTER TABLE task_epochs ADD COLUMN eligibility_state TEXT;  -- eligible|pending|attribution_uncertain|declined
ALTER TABLE task_epochs ADD COLUMN eligibility_at TEXT;
ALTER TABLE task_epochs ADD COLUMN workspace_root TEXT;

PRAGMA user_version = 3;