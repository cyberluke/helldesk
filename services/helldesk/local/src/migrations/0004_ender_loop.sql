-- Ender long-horizon autonomous loop (v4)
-- Mission / Ticket / Revision controller ABOVE the existing review_jobs level.
--
-- A `review_job` is ONE immutable review of ONE immutable snapshot. The Ender
-- loop adds a durable level above it:
--
--   Mission
--     └── Ticket
--          ├── Revision 1 ── Review Job 1
--          ├── Revision 2 ── Review Job 2
--          └── Revision N ── Review Job N
--
-- Invariants enforced by the controller (NOT by SQL alone):
--   * CLOSED      != VERIFIED_10_10
--   * FAILED      != dependency resolved
--   * a downstream ticket starts ONLY when every mandatory upstream dependency
--     has verification_state = VERIFIED_10_10 for its CURRENT active revision.
--
-- THIS IS AN ADDITIVE MIGRATION. It never alters tables owned by PR #1
-- (task_epochs, review_jobs, events_outbox, ...). It only adds new tables.

PRAGMA user_version = 4;

-- ── Missions (the durable long-horizon contract) ─────────────────────────────
CREATE TABLE IF NOT EXISTS autonomy_missions (
  mission_id         TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL,
  objective          TEXT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN (
                       'ACTIVE','PLANNING','MUTATING','CAPTURING_EVIDENCE',
                       'VERIFYING','REPLANNING','BLOCKED_EXTERNAL',
                       'VERIFIED_10_10','CANCELLED')),
  current_ticket_id    TEXT,
  current_revision_id TEXT,
  policy_version     TEXT NOT NULL DEFAULT 'ender-1',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  verified_at        TEXT,
  blocked_reason     TEXT,
  blocked_details    TEXT,
  cancelled_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_missions_state ON autonomy_missions(state);
CREATE INDEX IF NOT EXISTS idx_missions_ws ON autonomy_missions(workspace_id);

-- ── Tickets (a mission's units of work) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mission_tickets (
  ticket_id            TEXT PRIMARY KEY,
  mission_id         TEXT NOT NULL REFERENCES autonomy_missions(mission_id),
  title              TEXT NOT NULL,
  objective          TEXT,
  execution_state    TEXT NOT NULL DEFAULT 'OPEN' CHECK (execution_state IN (
                       'OPEN','READY','RUNNING','FAILED','CLOSED','BLOCKED')),
  verification_state TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_state IN (
                       'UNVERIFIED','VERIFYING','REJECTED','SUPERSEDED','VERIFIED_10_10')),
  active_revision_id TEXT,
  priority           INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_mission ON mission_tickets(mission_id);
CREATE INDEX IF NOT EXISTS idx_tickets_verif ON mission_tickets(verification_state);

-- ── Dependencies (Ticket N depends on Ticket M) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS ticket_dependencies (
  ticket_id           TEXT NOT NULL REFERENCES mission_tickets(ticket_id),
  depends_on_ticket_id TEXT NOT NULL,
  dependency_type   TEXT NOT NULL DEFAULT 'mandatory' CHECK (dependency_type IN ('mandatory','optional','weak')),
  PRIMARY KEY (ticket_id, depends_on_ticket_id)
);
CREATE INDEX IF NOT EXISTS idx_dep_on ON ticket_dependencies(depends_on_ticket_id);

-- ── Revisions (immutable; one per corrective attempt) ────────────────────────
CREATE TABLE IF NOT EXISTS ticket_revisions (
  revision_id              TEXT PRIMARY KEY,
  ticket_id                  TEXT NOT NULL REFERENCES mission_tickets(ticket_id),
  revision_no              INTEGER NOT NULL,
  parent_revision_id       TEXT,
  plan_id                  TEXT,
  hypothesis_key           TEXT,
  failure_signature        TEXT,
  snapshot_id              TEXT,                 -- references snapshots(snapshot_id)
  review_job_id            TEXT,                 -- references review_jobs(job_id)
  workspace_fingerprint_before TEXT,
  workspace_fingerprint_after  TEXT,
  state                    TEXT NOT NULL DEFAULT 'PLANNED' CHECK (state IN (
                             'PLANNED','MUTATING','EVIDENCE_CAPTURED','VERIFYING',
                             'VERIFIED_10_10','REJECTED','SUPERSEDED','BLOCKED')),
  created_at               TEXT NOT NULL,
  completed_at             TEXT,
  UNIQUE (ticket_id, revision_no)
);
CREATE INDEX IF NOT EXISTS idx_rev_Ticket ON ticket_revisions(ticket_id);
CREATE INDEX IF NOT EXISTS idx_rev_state ON ticket_revisions(state);

-- ── Repair plans (structured, never hidden chain-of-thought) ────────────────
CREATE TABLE IF NOT EXISTS repair_plans (
  plan_id           TEXT PRIMARY KEY,
  revision_id       TEXT NOT NULL REFERENCES ticket_revisions(revision_id),
  planner_model     TEXT,
  objective         TEXT,
  plan_json         TEXT,        -- structured: hypothesis, steps, acceptance
  hypothesis_key    TEXT,
  failure_signature TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_rev ON repair_plans(revision_id);

-- ── Quality gate results (revision-scoped, deterministic) ───────────────────
CREATE TABLE IF NOT EXISTS quality_gate_results (
  revision_id      TEXT NOT NULL REFERENCES ticket_revisions(revision_id),
  gate_key         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (status IN (
                    'UNVERIFIED','PASS','FAIL','BLOCKED')),
  evidence_refs_json TEXT,
  evaluator        TEXT,
  checked_at       TEXT NOT NULL,
  PRIMARY KEY (revision_id, gate_key)
);
CREATE INDEX IF NOT EXISTS idx_qg_rev ON quality_gate_results(revision_id);

-- ── Evidence artifacts (content-hashed, immutable) ──────────────────────────
CREATE TABLE IF NOT EXISTS evidence_artifacts (
  artifact_id      TEXT PRIMARY KEY,
  revision_id      TEXT NOT NULL REFERENCES ticket_revisions(revision_id),
  kind             TEXT NOT NULL,      -- git-diff|source|compiler|test|runtime|binary|hash|diagnostic
  path             TEXT,
  sha256           TEXT NOT NULL,
  bytes            INTEGER NOT NULL DEFAULT 0,
  producer         TEXT,               -- codex|evidence-capture|human
  command          TEXT,
  exit_code        INTEGER,
  created_at       TEXT NOT NULL,
  metadata_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_ev_rev ON evidence_artifacts(revision_id);

-- ── Scientific claims (typed evidence graph, canonicalized) ─────────────────
CREATE TABLE IF NOT EXISTS scientific_claims (
  claim_id          TEXT PRIMARY KEY,
  mission_id        TEXT NOT NULL REFERENCES autonomy_missions(mission_id),
  canonical_key     TEXT NOT NULL,
  revision_id       TEXT,
  status            TEXT NOT NULL DEFAULT 'HYPOTHESIS' CHECK (status IN (
                     'HYPOTHESIS','VERIFIED','FALSIFIED','SUPERSEDED')),
  claim             TEXT NOT NULL,
  evidence_refs_json TEXT,
  contradicts_json  TEXT,
  supersedes_claim_id TEXT,
  confidence        REAL NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  occurrence_count  INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_claims_mission ON scientific_claims(mission_id);
CREATE INDEX IF NOT EXISTS idx_claims_key ON scientific_claims(mission_id, canonical_key);