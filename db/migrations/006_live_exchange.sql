-- ADR-012: narrow, durable two-agent greeting. Separate from general tasks.
CREATE TABLE live_pairs (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  sender_id TEXT NOT NULL, receiver_id TEXT NOT NULL,
  CHECK (sender_id <> receiver_id),
  FOREIGN KEY (workspace_id,sender_id) REFERENCES entities(workspace_id,id),
  FOREIGN KEY (workspace_id,receiver_id) REFERENCES entities(workspace_id,id)
);
CREATE TABLE live_exchanges (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES live_pairs(workspace_id),
  state TEXT NOT NULL CHECK (state IN ('armed','sent','claimed','replied','failed','uncertain','expired','stopped')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id),
  message_id TEXT UNIQUE REFERENCES messages(id), reply_id TEXT UNIQUE REFERENCES messages(id),
  session_id TEXT, claimed_at TEXT, finished_at TEXT, read_at TEXT, failure_code TEXT
);
CREATE UNIQUE INDEX live_one_open_exchange ON live_exchanges(workspace_id)
  WHERE state IN ('armed','sent','claimed');
CREATE TABLE live_message_keys (
  workspace_id TEXT NOT NULL, sender_id TEXT NOT NULL, key TEXT NOT NULL,
  request_hash TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id),
  exchange_id TEXT NOT NULL REFERENCES live_exchanges(id),
  PRIMARY KEY (workspace_id,sender_id,key),
  FOREIGN KEY (workspace_id,sender_id) REFERENCES entities(workspace_id,id)
);
