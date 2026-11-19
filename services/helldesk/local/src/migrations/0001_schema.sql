-- CyberLuke Local HELLDESK schema (v1)
-- SQLite WAL schema for the local orchestration control plane.
-- Ported from helldesk's durable job/review semantics to a single-file
-- SQLite database. One logical operation = one authoritative row + CAS
-- transitions. No Durable Objects, no Cloudflare, no remote queue.

PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id      TEXT PRIMARY KEY,
  path              TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id        TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(workspace_id),
  role              TEXT NOT NULL DEFAULT 'developer',  -- developer|reviewer|adjudicator
  agent             TEXT,
  provider_id       TEXT,
  model_id          TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id       TEXT PRIMARY KEY,
  subject_kind      TEXT NOT NULL CHECK (subject_kind IN ('git-head','git-commit','git-range','git-dirty','git-mixed','fs-folder')),
  workspace_id      TEXT NOT NULL REFERENCES workspaces(workspace_id),
  base_ref          TEXT,
  head_ref          TEXT,
  base_hash         TEXT,
  head_hash         TEXT,
  dirty_hash        TEXT,
  untracked_hash    TEXT,
  manifest_hash     TEXT NOT NULL,
  diff_blob_path    TEXT NOT NULL,
  manifest_blob_path TEXT NOT NULL,
  content_hash      TEXT NOT NULL,           -- sha256 of the immutable captured subject
  created_at        TEXT NOT NULL,
  coverage          TEXT                      -- JSON: {changedFiles, inspectedFiles, uncoveredPaths[]}
);

CREATE TABLE IF NOT EXISTS review_jobs (
  job_id            TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(workspace_id),
  snapshot_id       TEXT NOT NULL REFERENCES snapshots(snapshot_id),
  target_fingerprint TEXT NOT NULL UNIQUE,   -- immutable target identity
  state             TEXT NOT NULL CHECK (state IN (
                      'DISCOVERED','SNAPSHOTTED','QUEUED',
                      'REVIEWING_A_B','ADJUDICATING',
                      'COMPLETED_PASS','COMPLETED_FINDINGS',
                      'INCONCLUSIVE','FAILED_TERMINAL','CANCELLED')),
  result            TEXT,
  policy_version    TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'auto',   -- session|git|fs|cli|api
  trigger_session_id TEXT,
  requested_at      TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  coverage          TEXT,
  meta              TEXT                       -- JSON blob of scheduler/requirement metadata
);

CREATE INDEX IF NOT EXISTS idx_jobs_state ON review_jobs(state);
CREATE INDEX IF NOT EXISTS idx_jobs_workspace ON review_jobs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_jobs_requested ON review_jobs(requested_at);

CREATE TABLE IF NOT EXISTS review_attempts (
  attempt_id        TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES review_jobs(job_id),
  attempt_no        INTEGER NOT NULL,
  state             TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  owner_token       TEXT,
  lease_expires_at  TEXT,
  meta              TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_job_no ON review_attempts(job_id, attempt_no);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id            TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES review_jobs(job_id),
  role              TEXT NOT NULL,           -- reviewer-a|reviewer-b|adjudicator
  session_id        TEXT,
  provider_id       TEXT,
  model_id          TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending|running|succeeded|failed|aborted
  started_at        TEXT,
  finished_at       TEXT,
  duration_ms       INTEGER,
  tokens_in         INTEGER,
  tokens_out        INTEGER,
  cost              REAL,
  raw_output_path   TEXT,
  error             TEXT
);

CREATE TABLE IF NOT EXISTS findings (
  finding_id        TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES review_jobs(job_id),
  severity          TEXT NOT NULL CHECK (severity IN ('BLOCKER','HIGH','MEDIUM','LOW')),
  confidence        TEXT NOT NULL CHECK (confidence IN ('VERIFIED','LIKELY','HYPOTHESIS')),
  title             TEXT NOT NULL,
  file              TEXT,
  line_start        INTEGER,
  line_end          INTEGER,
  revision          TEXT,
  evidence          TEXT,
  counterexample    TEXT,
  requirement       TEXT,
  verification      TEXT,
  reviewer_ids      TEXT NOT NULL,           -- JSON array e.g. ["A"]
  adjudicated       INTEGER NOT NULL DEFAULT 0,
  adjudication      TEXT
);
CREATE INDEX IF NOT EXISTS idx_findings_job ON findings(job_id);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity);

CREATE TABLE IF NOT EXISTS reports (
  report_id         TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES review_jobs(job_id),
  json_path         TEXT NOT NULL,
  md_path           TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  content_hash      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_job ON reports(job_id);

CREATE TABLE IF NOT EXISTS events_outbox (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type        TEXT NOT NULL,
  job_id            TEXT,
  payload           TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  delivered_at      TEXT,
  delivery_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON events_outbox(delivered_at) WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS watermarks (
  workspace_id      TEXT NOT NULL,
  kind              TEXT NOT NULL,           -- git-head|git-dirty|fs-manifest|session
  value             TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (workspace_id, kind)
);

CREATE TABLE IF NOT EXISTS leases (
  lease_id          TEXT PRIMARY KEY,
  owner             TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  heartbeat_at      TEXT NOT NULL,
  leasee            TEXT                        -- JSON: fenced token context
);

CREATE TABLE IF NOT EXISTS fs_manifest (
  workspace_id      TEXT NOT NULL,
  rel_path          TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  mtime_ms          INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, rel_path)
);