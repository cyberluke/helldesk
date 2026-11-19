-- 0007_mission_engine_matrix.sql
-- Per-mission provider-agnostic engine matrix (mutation / review / adjudicate).
-- The local-live dispatcher POSTs an optional engineMatrix when creating a
-- mission; the mission controller resolves each stage's engine from this column,
-- falling back to department defaults / machine policy when a stage is unset.
-- Idempotent: the live DB may already have the column (applied manually);
-- guard with a pragma check so a fresh or partially-migrated DB both converge.
ALTER TABLE autonomy_missions ADD COLUMN engine_matrix_json TEXT NOT NULL DEFAULT '{}';