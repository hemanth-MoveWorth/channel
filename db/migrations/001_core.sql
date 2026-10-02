-- ADR-002: SQLite prototype. JSON is text; IDs and timestamps come from the app.
-- No RLS or external Auth schema: see db/policies.md for application enforcement.
CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id)
);
CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  PRIMARY KEY (workspace_id,user_id)
);
CREATE TABLE entities (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owner_user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '[]', connection_type TEXT NOT NULL CHECK (connection_type IN ('A','B','C')),
  webhook_url TEXT, verified_permissions TEXT NOT NULL DEFAULT '{}',
  availability TEXT NOT NULL DEFAULT 'unknown', last_check TEXT,
  UNIQUE (workspace_id,id),
  FOREIGN KEY (workspace_id,owner_user_id) REFERENCES workspace_members(workspace_id,user_id)
);
CREATE TABLE entity_credentials (
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES entities(id),
  key_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE UNIQUE INDEX entity_one_active_credential ON entity_credentials(entity_id) WHERE revoked_at IS NULL;
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('dm','group')), name TEXT NOT NULL DEFAULT '',
  UNIQUE (workspace_id,id)
);
CREATE TABLE conversation_members (
  workspace_id TEXT NOT NULL, conversation_id TEXT NOT NULL, entity_id TEXT NOT NULL,
  is_orchestrator INTEGER NOT NULL DEFAULT 0 CHECK (is_orchestrator IN (0,1)),
  PRIMARY KEY (conversation_id,entity_id),
  FOREIGN KEY (workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
  FOREIGN KEY (workspace_id,entity_id) REFERENCES entities(workspace_id,id)
);
CREATE UNIQUE INDEX conversation_one_orchestrator ON conversation_members(conversation_id) WHERE is_orchestrator=1;
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  conversation_id TEXT NOT NULL, requester_entity_id TEXT, created_by_user_id TEXT,
  assigned_entity_id TEXT, goal TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted','queued','working','input_required','awaiting_approval','completed','failed','cancelled')),
  delivery_receipt TEXT NOT NULL DEFAULT 'stored' CHECK (delivery_receipt IN ('stored','delivered','accepted_for_execution')),
  idempotency_key TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL,
  UNIQUE (workspace_id,id), UNIQUE (workspace_id,idempotency_key),
  CHECK ((requester_entity_id IS NOT NULL AND created_by_user_id IS NULL) OR (requester_entity_id IS NULL AND created_by_user_id IS NOT NULL)),
  FOREIGN KEY (workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
  FOREIGN KEY (workspace_id,requester_entity_id) REFERENCES entities(workspace_id,id),
  FOREIGN KEY (workspace_id,assigned_entity_id) REFERENCES entities(workspace_id,id),
  FOREIGN KEY (workspace_id,created_by_user_id) REFERENCES workspace_members(workspace_id,user_id)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  task_id TEXT, sender_entity_id TEXT, author_user_id TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL,
  CHECK ((sender_entity_id IS NOT NULL AND author_user_id IS NULL) OR (sender_entity_id IS NULL AND author_user_id IS NOT NULL)),
  FOREIGN KEY (workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
  FOREIGN KEY (workspace_id,task_id) REFERENCES tasks(workspace_id,id),
  FOREIGN KEY (workspace_id,sender_entity_id) REFERENCES entities(workspace_id,id),
  FOREIGN KEY (workspace_id,author_user_id) REFERENCES workspace_members(workspace_id,user_id)
);
CREATE TABLE task_events (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL,
  event_type TEXT NOT NULL, from_state TEXT, to_state TEXT, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id,task_id) REFERENCES tasks(workspace_id,id)
);
CREATE TABLE permission_rules (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), entity_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('ask_every_time','standing_rules','full_access_workspace')),
  rules TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (workspace_id,entity_id) REFERENCES entities(workspace_id,id)
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL, action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by_user_id TEXT, decided_at TEXT,
  FOREIGN KEY (workspace_id,task_id) REFERENCES tasks(workspace_id,id),
  FOREIGN KEY (workspace_id,decided_by_user_id) REFERENCES workspace_members(workspace_id,user_id)
);
CREATE TABLE context_packages (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL, recipient_entity_id TEXT NOT NULL,
  goal TEXT NOT NULL, facts TEXT NOT NULL DEFAULT '[]', history_slice TEXT NOT NULL DEFAULT '[]',
  source_refs TEXT NOT NULL DEFAULT '[]', constraints TEXT NOT NULL DEFAULT '[]', expected_output TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (workspace_id,task_id) REFERENCES tasks(workspace_id,id),
  FOREIGN KEY (workspace_id,recipient_entity_id) REFERENCES entities(workspace_id,id)
);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor_user_id TEXT, actor_entity_id TEXT, task_id TEXT,
  action TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id,actor_user_id) REFERENCES workspace_members(workspace_id,user_id),
  FOREIGN KEY (workspace_id,actor_entity_id) REFERENCES entities(workspace_id,id),
  FOREIGN KEY (workspace_id,task_id) REFERENCES tasks(workspace_id,id)
);
CREATE TABLE job_queue (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL,
  recipient_entity_id TEXT NOT NULL, action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','done','cancelled')),
  available_at INTEGER NOT NULL, lease_until INTEGER, lease_token TEXT,
  tries INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  FOREIGN KEY (workspace_id,task_id) REFERENCES tasks(workspace_id,id),
  FOREIGN KEY (workspace_id,recipient_entity_id) REFERENCES entities(workspace_id,id)
);
CREATE INDEX workspace_members_user ON workspace_members(user_id,workspace_id);
CREATE INDEX messages_history ON messages(workspace_id,conversation_id,created_at);
CREATE INDEX task_events_history ON task_events(task_id,created_at);
CREATE INDEX queue_ready ON job_queue(status,available_at,lease_until);
CREATE INDEX tasks_workspace ON tasks(workspace_id,state);
CREATE INDEX audit_workspace ON audit_log(workspace_id,created_at);
