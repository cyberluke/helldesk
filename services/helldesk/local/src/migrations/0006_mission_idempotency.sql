ALTER TABLE autonomy_missions ADD COLUMN idempotency_key TEXT;
ALTER TABLE autonomy_missions ADD COLUMN request_hash TEXT;
CREATE UNIQUE INDEX autonomy_mission_idempotency ON autonomy_missions(idempotency_key) WHERE idempotency_key IS NOT NULL;
