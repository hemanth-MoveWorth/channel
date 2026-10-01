-- ADR-003. Task attempts change only on explicit failed -> queued manual retry.
ALTER TABLE tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN recipient_entity_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN request_hash TEXT;
CREATE TABLE deliveries (
  idempotency_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  action TEXT NOT NULL,
  recipient_entity_id TEXT NOT NULL REFERENCES entities(id),
  status TEXT NOT NULL CHECK (status IN ('pending','delivered')),
  response TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX deliveries_task ON deliveries(task_id,recipient_entity_id);
