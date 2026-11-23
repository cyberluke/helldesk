-- @@automit
-- 0009_verify_mode.sql
-- WAR-mode deferred verification: widen the state CHECK constraints on
-- mission_tickets.verification_state and ticket_revisions.state to include the
-- new `PENDING_VERIFY` value (a completed revision parked until the operator's
-- batch verify sweep). SQLite cannot ALTER a CHECK constraint, so we rebuild
-- both tables inside a transaction with the widened constraint, copy rows, and
-- rename. Foreign keys are disabled for the rebuild window so the child tables
-- (ticket_dependencies, ticket_revisions) are not blocked by reference checks.
--
-- NOTE: the migration runner (db.ts) wraps this whole file in a single
-- db.transaction(); do NOT emit BEGIN/COMMIT here (nested transactions would
-- collide). The PRAGMAs below are session-scoped and take effect immediately.

PRAGMA foreign_keys = OFF;

-- ── mission_tickets: widen verification_state CHECK to include PENDING_VERIFY ──
-- Aborted/failed prior runs may leave the staging table behind; drop it first so
-- a re-run performs a clean rebuild instead of colliding on an existing name.
DROP TABLE IF EXISTS mission_tickets__verify_mode;
CREATE TABLE mission_tickets__verify_mode (
  ticket_id            TEXT PRIMARY KEY,
  mission_id           TEXT NOT NULL REFERENCES autonomy_missions(mission_id),
  title                TEXT NOT NULL,
  objective            TEXT,
  execution_state      TEXT NOT NULL DEFAULT 'OPEN' CHECK (execution_state IN (
                         'OPEN','READY','RUNNING','FAILED','CLOSED','BLOCKED')),
  verification_state   TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_state IN (
                         'UNVERIFIED','VERIFYING','PENDING_VERIFY','REJECTED','SUPERSEDED','VERIFIED_10_10')),
  active_revision_id   TEXT,
  priority             INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

INSERT INTO mission_tickets__verify_mode (ticket_id, mission_id, title, objective, execution_state, verification_state, active_revision_id, priority, created_at, updated_at)
  SELECT ticket_id, mission_id, title, objective, execution_state, verification_state, active_revision_id, priority, created_at, updated_at FROM mission_tickets;

DROP TABLE mission_tickets;
ALTER TABLE mission_tickets__verify_mode RENAME TO mission_tickets;
CREATE INDEX IF NOT EXISTS idx_tickets_mission ON mission_tickets(mission_id);
CREATE INDEX IF NOT EXISTS idx_tickets_verif ON mission_tickets(verification_state);

-- ── ticket_revisions: widen state CHECK to include PENDING_VERIFY ─────────────
DROP TABLE IF EXISTS ticket_revisions__verify_mode;
CREATE TABLE ticket_revisions__verify_mode (
  revision_id              TEXT PRIMARY KEY,
  ticket_id                TEXT NOT NULL REFERENCES mission_tickets(ticket_id),
  revision_no              INTEGER NOT NULL,
  parent_revision_id       TEXT,
  plan_id                  TEXT,
  hypothesis_key           TEXT,
  failure_signature        TEXT,
  snapshot_id              TEXT,
  review_job_id            TEXT,
  workspace_fingerprint_before TEXT,
  workspace_fingerprint_after  TEXT,
  state                    TEXT NOT NULL DEFAULT 'PLANNED' CHECK (state IN (
                             'PLANNED','MUTATING','EVIDENCE_CAPTURED','VERIFYING','PENDING_VERIFY',
                             'VERIFIED_10_10','REJECTED','SUPERSEDED','BLOCKED')),
  created_at               TEXT NOT NULL,
  completed_at             TEXT,
  UNIQUE (ticket_id, revision_no)
);

INSERT INTO ticket_revisions__verify_mode (revision_id, ticket_id, revision_no, parent_revision_id, plan_id, hypothesis_key, failure_signature, snapshot_id, review_job_id, workspace_fingerprint_before, workspace_fingerprint_after, state, created_at, completed_at)
  SELECT revision_id, ticket_id, revision_no, parent_revision_id, plan_id, hypothesis_key, failure_signature, snapshot_id, review_job_id, workspace_fingerprint_before, workspace_fingerprint_after, state, created_at, completed_at FROM ticket_revisions;

DROP TABLE ticket_revisions;
ALTER TABLE ticket_revisions__verify_mode RENAME TO ticket_revisions;
CREATE INDEX IF NOT EXISTS idx_rev_Ticket ON ticket_revisions(ticket_id);
CREATE INDEX IF NOT EXISTS idx_rev_state ON ticket_revisions(state);

PRAGMA foreign_keys = ON;