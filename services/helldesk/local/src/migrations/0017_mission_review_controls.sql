-- Per-task review policy: which independent review stages run for a mission.
-- JSON object: { agents?, reviewer?, reviewerA?, reviewerB?, excellenceGovernor?, review_mode? }
-- Omitted fields default to ENABLED (backward compatible with existing missions).
ALTER TABLE autonomy_missions ADD COLUMN controls_json TEXT NOT NULL DEFAULT '{}';
