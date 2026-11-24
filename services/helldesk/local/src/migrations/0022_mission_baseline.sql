-- Immutable mission admission baseline (M1.1).
--
-- Captures protected-file identities ONCE, before any mutation. Candidate
-- revisions are compared against this baseline, not against moving HEAD.
-- Stored as a bounded JSON manifest: git commit/tree, resolved protected globs,
-- explicit allow-list, and protected file/symlink identities.

ALTER TABLE autonomy_missions ADD COLUMN baseline_json TEXT NOT NULL DEFAULT '{}';
