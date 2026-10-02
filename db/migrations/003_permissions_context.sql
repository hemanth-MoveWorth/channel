-- ADR-004: canonical rules and private-source ownership/grants.
-- Legacy rule rows without canonical JSON fail closed; no implicit grants.
ALTER TABLE permission_rules ADD COLUMN rule_json TEXT;
ALTER TABLE tasks ADD COLUMN resource_type TEXT NOT NULL DEFAULT 'task' CHECK (resource_type IN ('source','tool','conversation','task'));
ALTER TABLE tasks ADD COLUMN resource_id TEXT;
ALTER TABLE tasks ADD COLUMN action TEXT NOT NULL DEFAULT 'execute' CHECK (action IN ('read','write','execute','share'));
ALTER TABLE tasks ADD COLUMN context_input TEXT NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN blocked_reason TEXT;
ALTER TABLE approvals ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE approvals ADD COLUMN gate_fingerprint TEXT;
ALTER TABLE approvals ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX approvals_gate ON approvals(task_id,attempt,gate_fingerprint);
ALTER TABLE context_packages ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
-- Old packages have no verified lineage: don't mark them as authorized snapshots.
ALTER TABLE context_packages ADD COLUMN gate_fingerprint TEXT;
CREATE UNIQUE INDEX context_verified_snapshot ON context_packages(task_id,attempt,recipient_entity_id) WHERE gate_fingerprint IS NOT NULL;
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owner_type TEXT NOT NULL CHECK (owner_type IN ('user','entity')),
  owner_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared')),
  UNIQUE (workspace_id,id)
);
CREATE TABLE source_grants (
  source_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  grantee_entity_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope='read'),
  granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id,grantee_entity_id,scope),
  FOREIGN KEY (workspace_id,source_id) REFERENCES sources(workspace_id,id),
  FOREIGN KEY (workspace_id,grantee_entity_id) REFERENCES entities(workspace_id,id)
);
CREATE INDEX sources_workspace ON sources(workspace_id);
CREATE INDEX permissions_workspace_entity ON permission_rules(workspace_id,entity_id);
