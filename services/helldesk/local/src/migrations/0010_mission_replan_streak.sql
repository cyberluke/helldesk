-- 0010_mission_replan_streak.sql
-- Consecutive no-delta replan counter for fail-fast mission parking.
--
-- A mutator that keeps producing no recognized content delta (probe-only /
-- scratch commits, repeated identical no-change) can otherwise replan toward
-- MAX_PLAN_REVISIONS (3000), burning hours with no deliverable. This additive
-- column counts CONSECUTIVE no-delta replans so the controller can park the
-- mission BLOCKED after a small, operator-visible bound instead of spinning.
--
-- Additive + idempotent: ALTER TABLE ... ADD COLUMN fails if it already exists
-- (SQLite), so guard with a name check. Runs safely after 0009 (autocommit is
-- fine for a single additive column).
SELECT CASE WHEN (
  SELECT COUNT(*) FROM pragma_table_info('autonomy_missions') WHERE name='replan_streak'
) = 0 THEN 'alter' ELSE 'skip' END;
ALTER TABLE autonomy_missions ADD COLUMN replan_streak INTEGER NOT NULL DEFAULT 0;