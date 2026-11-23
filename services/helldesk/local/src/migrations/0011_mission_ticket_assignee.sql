-- 0011_mission_ticket_assignee.sql
-- Operator-dispatch override: let the operator assign a mission ticket to a
-- chosen agent (e.g. Toast). mission_tickets gains an assignee + assignment
-- metadata. This is a FIRST-CLASS operator ownership signal: the card shows the
-- assigned agent instead of 'Unassigned', and the assignment is recorded for the
-- controller/journal. The mission's engine_matrix (which, for Toast, is
-- the effective Kilo model route) is the runner; 'assigned to Toast' means
-- that agent is the responsible owner and the mutation runs on the same engine
-- Toast projects from. Additive + idempotent (guarded ADD COLUMN).
SELECT CASE WHEN (
  SELECT COUNT(*) FROM pragma_table_info('mission_tickets') WHERE name='assignee_agent_id'
) = 0 THEN 'alter' ELSE 'skip' END;
ALTER TABLE mission_tickets ADD COLUMN assignee_agent_id TEXT;
ALTER TABLE mission_tickets ADD COLUMN assigned_at TEXT;
ALTER TABLE mission_tickets ADD COLUMN assigned_by TEXT; -- 'operator' | system