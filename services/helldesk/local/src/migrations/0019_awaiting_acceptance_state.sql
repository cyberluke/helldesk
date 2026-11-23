-- @@automit
-- Widen mission_tickets.execution_state to include AWAITING_ACCEPTANCE.
-- SQLite cannot alter a CHECK constraint, so this is a table swap.
-- The daemon is the only writer at startup; user_version is set after the file.
PRAGMA foreign_keys=OFF;
DROP TABLE IF EXISTS mission_tickets__acceptance;
CREATE TABLE mission_tickets__acceptance (
  ticket_id            TEXT PRIMARY KEY,
  mission_id           TEXT NOT NULL REFERENCES autonomy_missions(mission_id),
  title                TEXT NOT NULL,
  objective            TEXT,
  execution_state      TEXT NOT NULL DEFAULT 'OPEN' CHECK (execution_state IN (
                         'OPEN','READY','RUNNING','AWAITING_ACCEPTANCE','FAILED','CLOSED','BLOCKED')),
  verification_state   TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_state IN (
                         'UNVERIFIED','VERIFYING','PENDING_VERIFY','REJECTED','SUPERSEDED','VERIFIED_10_10')),
  active_revision_id   TEXT,
  priority             INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  assignee_agent_id    TEXT,
  assigned_at          TEXT,
  assigned_by          TEXT
);
INSERT INTO mission_tickets__acceptance
  (ticket_id, mission_id, title, objective, execution_state, verification_state,
   active_revision_id, priority, created_at, updated_at,
   assignee_agent_id, assigned_at, assigned_by)
  SELECT ticket_id, mission_id, title, objective, execution_state, verification_state,
         active_revision_id, priority, created_at, updated_at,
         assignee_agent_id, assigned_at, assigned_by
    FROM mission_tickets;
DROP TABLE mission_tickets;
ALTER TABLE mission_tickets__acceptance RENAME TO mission_tickets;
CREATE INDEX IF NOT EXISTS idx_tickets_mission ON mission_tickets(mission_id);
CREATE INDEX IF NOT EXISTS idx_tickets_verif ON mission_tickets(verification_state);
PRAGMA foreign_keys=ON;
