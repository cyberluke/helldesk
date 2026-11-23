-- Chat speaker identity: soul | reviewer-a | reviewer-b | adjudicator | system.
-- The operator conversation shows WHO said each row; the independent review is
-- mirrored here verbatim from the persisted reviewer/adjudicator verdicts.
ALTER TABLE mission_chat_messages ADD COLUMN speaker TEXT;
