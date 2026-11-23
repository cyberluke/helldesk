-- REAL Kilo SDK session transcript for the operator chat, plus operator steering.
--
-- The operator console must be a real chat: rows here come from the mission's
-- actual headless Kilo session (user brief, assistant text/reasoning, tool
-- calls/results) and from the operator's steering messages. Markdown is
-- rendered client-side; this table stores the raw text/parts.
CREATE TABLE IF NOT EXISTS mission_chat_messages (
  message_id  TEXT PRIMARY KEY,
  mission_id  TEXT NOT NULL,
  ticket_id   TEXT,
  revision_id TEXT,
  session_id  TEXT,
  part_id     TEXT,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','system','operator')),
  kind        TEXT NOT NULL CHECK (kind IN ('text','reasoning','tool_call','tool_result')),
  text        TEXT,
  tool_name   TEXT,
  tool_input  TEXT,
  tool_result TEXT,
  seq         INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mission_chat_mission_seq
  ON mission_chat_messages(mission_id, seq);

-- One row per Kilo part (call/result are separate parts), so a live poller can
-- re-read the same session repeatedly without duplicating rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_chat_part
  ON mission_chat_messages(mission_id, part_id)
  WHERE part_id IS NOT NULL;
