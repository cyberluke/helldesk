-- CyberLuke Local HELLDESK schema (v2) — multi-host control plane.
-- ADDITIVE migration: preserves all v1 data/jobs/reports. Adds host +
-- session registries, the detached-review-worker table, and task-epoch
-- columns for completion detection. user_version moves 1 -> 2.

CREATE TABLE IF NOT EXISTS hosts (
  host_id           TEXT PRIMARY KEY,     -- unique per plugin RUNTIME (not per PID)
  instance_id       TEXT NOT NULL,        -- controller-independent identity
  runtime_id        TEXT,                 -- Kilo runtime id (io.zoocode.node.v8 etc.)
  pid               INTEGER NOT NULL,     -- informational only, never the host key
  sdk_server_url    TEXT,
  workspace_roots   TEXT NOT NULL,        -- JSON array of workspace roots
  plugin_version    TEXT,
  sdk_version       TEXT,
  capabilities      TEXT NOT NULL,        -- JSON array
  status            TEXT NOT NULL DEFAULT 'connected',  -- connected|idle|disconnected
  auth_token_hash   TEXT,
  registered_at     TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  lease_expires_at  TEXT NOT NULL,
  disconnected_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_hosts_status ON hosts(status);

-- Host-attached session registry (distinct from v1 review-role `sessions`).
-- Keyed by (host_id, session_id) so one workspace session on many hosts stays
-- host-scoped, and the control plane can see every open Kilo session across
-- all hosts without colliding with the v1 review-role sessions table.
CREATE TABLE IF NOT EXISTS host_sessions (
  session_id        TEXT NOT NULL,        -- Kilo session id (scoped by host)
  host_id           TEXT NOT NULL REFERENCES hosts(host_id) ON DELETE CASCADE,
  workspace_root    TEXT,
  worktree_root     TEXT,
  agent_id          TEXT,
  selected_provider_id TEXT,
  selected_model_id   TEXT,
  status            TEXT NOT NULL DEFAULT 'active',  -- active|idle|disconnected
  last_event_sequence INTEGER NOT NULL DEFAULT 0,
  last_seen_at      TEXT NOT NULL,
  task_epoch        INTEGER NOT NULL DEFAULT 0,   -- increments each new task/turn
  PRIMARY KEY (host_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_host_sessions_host ON host_sessions(host_id);
CREATE INDEX IF NOT EXISTS idx_host_sessions_status ON host_sessions(status);

-- Detached review worker processes (independent Kilo SDK runtimes).
CREATE TABLE IF NOT EXISTS workers (
  worker_id         TEXT PRIMARY KEY,
  host_id           TEXT,                       -- hosting control plane (NULL = daemon-owned)
  job_id            TEXT,
  attempt_id        TEXT,
  role              TEXT NOT NULL,              -- reviewer-a|reviewer-b|adjudicator
  pid               INTEGER,
  executable        TEXT,
  status            TEXT NOT NULL DEFAULT 'launching', -- launching|running|succeeded|failed|aborted|terminated
  provider_id       TEXT,
  model_id          TEXT,
  started_at        TEXT,
  finished_at       TEXT,
  exit_code         INTEGER,
  error             TEXT,
  raw_output_path   TEXT,
  result_blob_path  TEXT,
  last_heartbeat_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workers_job ON workers(job_id);
CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);

-- Session event durable sequence (per host) for replay after daemon loss.
CREATE TABLE IF NOT EXISTS session_events (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id            TEXT NOT NULL REFERENCES hosts(host_id) ON DELETE CASCADE,
  session_id         TEXT NOT NULL,
  event_type         TEXT NOT NULL,
  event_payload      TEXT NOT NULL,          -- raw validated payload
  task_epoch         INTEGER NOT NULL DEFAULT 0,
  ingested_at        TEXT NOT NULL,
  acked_by_host      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_se_host_session ON session_events(host_id, session_id);
CREATE INDEX IF NOT EXISTS idx_se_host_seq ON session_events(host_id, seq);

-- Task epochs: a task/turn identity inside a session, so multiple distinct
-- tasks produce distinct review opportunities and session.idle alone is never
-- treated as completion.
CREATE TABLE IF NOT EXISTS task_epochs (
  epoch_id          TEXT PRIMARY KEY,
  host_id           TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  epoch_no          INTEGER NOT NULL,
  baseline_head     TEXT,                     -- HEAD revision at task start
  baseline_dirty_hash TEXT,
  baseline_taken_at TEXT,
  state             TEXT NOT NULL DEFAULT 'open',  -- open|running|quiet|complete|abandoned
  work_observed     INTEGER NOT NULL DEFAULT 0,
  last_activity_at  TEXT,
  complete_at       TEXT,
  source           TEXT                       -- chat.message|tool.execute.after|file.edited|...
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_epoch_host_session_no ON task_epochs(host_id, session_id, epoch_no);

PRAGMA user_version = 2;