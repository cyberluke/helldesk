-- Execution gates (M1): mission-defined, host-executed acceptance commands.
--
-- The commands live on the mission (gate_commands_json), OUTSIDE the writable
-- workspace, so a mutator cannot change the authoritative command or the
-- acceptance criteria. Each execution is bound to one immutable candidate
-- revision and records real process provenance. The Quality Oracle requires a
-- PASS execution for every executable gate; a reviewer can never turn an
-- executed FAIL into PASS.

ALTER TABLE autonomy_missions ADD COLUMN gate_commands_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS gate_executions (
  gate_execution_id     TEXT PRIMARY KEY,
  revision_id           TEXT NOT NULL REFERENCES ticket_revisions(revision_id),
  gate_key              TEXT NOT NULL,
  candidate_hash        TEXT NOT NULL,
  command               TEXT NOT NULL,
  cwd                   TEXT,
  status                TEXT NOT NULL CHECK (status IN ('PASS','FAIL','TIMEOUT','ERROR','BLOCKED')),
  exit_code             INTEGER,
  duration_ms           INTEGER NOT NULL DEFAULT 0,
  stdout_sha256         TEXT NOT NULL,
  stderr_sha256         TEXT NOT NULL,
  stdout_bytes          INTEGER NOT NULL DEFAULT 0,
  stderr_bytes          INTEGER NOT NULL DEFAULT 0,
  evidence_artifact_id  TEXT NOT NULL,
  env_json              TEXT NOT NULL,
  test_file_hashes_json TEXT NOT NULL,
  protected_paths_json  TEXT NOT NULL,
  started_at            TEXT NOT NULL,
  finished_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gate_exec_rev ON gate_executions(revision_id);
CREATE INDEX IF NOT EXISTS idx_gate_exec_rev_gate ON gate_executions(revision_id, gate_key);
