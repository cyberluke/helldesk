-- T-shirt sizing / story points, estimated at task creation by a small
-- structured-JSON LLM pass. Columns are nullable because unsized is a valid
-- state (never fabricate a point value).
ALTER TABLE mission_tickets ADD COLUMN story_points INTEGER;
ALTER TABLE mission_tickets ADD COLUMN tshirt_size TEXT;
ALTER TABLE mission_tickets ADD COLUMN size_confidence TEXT;
ALTER TABLE mission_tickets ADD COLUMN size_rationale TEXT;
ALTER TABLE mission_tickets ADD COLUMN size_model TEXT;
ALTER TABLE mission_tickets ADD COLUMN sized_at TEXT;
ALTER TABLE mission_tickets ADD COLUMN sizing_state TEXT NOT NULL DEFAULT 'unsized';

CREATE TABLE IF NOT EXISTS task_size_cache (
  spec_hash    TEXT PRIMARY KEY,
  tshirt_size  TEXT NOT NULL,
  story_points INTEGER NOT NULL,
  confidence   TEXT NOT NULL,
  rationale    TEXT,
  model        TEXT,
  created_at   TEXT NOT NULL
);
