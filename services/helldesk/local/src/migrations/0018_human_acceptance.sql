-- Human acceptance gate. Machine VERIFIED_10_10 is not the operator's
-- acceptance: a verified mission waits in AWAITING_ACCEPTANCE until the human
-- explicitly accepts (or requests changes, which opens a follow-up ticket).
ALTER TABLE autonomy_missions ADD COLUMN human_acceptance TEXT;
ALTER TABLE autonomy_missions ADD COLUMN human_acceptance_note TEXT;
ALTER TABLE autonomy_missions ADD COLUMN human_accepted_at TEXT;
ALTER TABLE autonomy_missions ADD COLUMN human_accepted_by TEXT;

CREATE TABLE IF NOT EXISTS mission_acceptance_events (
  event_id    TEXT PRIMARY KEY,
  mission_id  TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('accepted','changes_requested')),
  note        TEXT,
  actor       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acceptance_mission ON mission_acceptance_events(mission_id, created_at);
