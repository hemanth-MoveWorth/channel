ALTER TABLE conversations ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat','task_request','task_result','system'));
ALTER TABLE messages ADD COLUMN parent_message_id TEXT REFERENCES messages(id);
CREATE INDEX tasks_dashboard ON tasks(workspace_id,created_at,id);
CREATE INDEX approvals_dashboard ON approvals(workspace_id,status,created_at);
