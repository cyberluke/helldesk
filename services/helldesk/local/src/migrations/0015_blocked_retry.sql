-- Bounded auto-retry for TRANSIENT blocked missions (never for pathological or
-- budget blocks, which require an explicit operator decision).
ALTER TABLE autonomy_missions ADD COLUMN auto_retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE autonomy_missions ADD COLUMN next_retry_at TEXT;
