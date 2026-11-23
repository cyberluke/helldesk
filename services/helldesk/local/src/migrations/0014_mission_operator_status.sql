-- Operator status overlay: the board must not "snap back" a drag on a mission
-- card. Mission STATE stays engine-owned (never faked); the operator's chosen
-- column is recorded here and shown until the mission is terminal. A terminal
-- mission ignores the overlay, so no card can look active after verification.
ALTER TABLE autonomy_missions ADD COLUMN operator_status TEXT;
ALTER TABLE autonomy_missions ADD COLUMN operator_status_at TEXT;
