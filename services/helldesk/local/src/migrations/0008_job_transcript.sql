-- 0008_job_transcript.sql
-- Durable per-mission/per-revision AGENT TRANSCRIPT journal.
-- This is the full-QA-observability surface: what each worker actually did,
-- step by step — assistant messages, tool calls, file diffs, review findings,
-- and mission events — so an operator can steer without guessing.
-- Additive; preserves every prior table. user_version 7 -> 8.
CREATE TABLE IF NOT EXISTS job_transcript (
  transcript_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id     TEXT NOT NULL,
  ticket_id      TEXT,
  revision_id    TEXT,
  job_id         TEXT,
  worker_id      TEXT,
  role           TEXT,                              -- mutation | reviewer-a | reviewer-b | adjudicator | engine
  kind           TEXT NOT NULL,                     -- message | tool_call | diff | finding | event | error
  title          TEXT,
  content        TEXT NOT NULL,                     -- the human-readable detail (message text / tool args / diff)
  meta           TEXT,                              -- JSON: file path, severity, status, etc.
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jt_mission ON job_transcript(mission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jt_revision ON job_transcript(revision_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jt_job ON job_transcript(job_id);
CREATE INDEX IF NOT EXISTS idx_jt_role_kind ON job_transcript(role, kind);
PRAGMA user_version = 8;