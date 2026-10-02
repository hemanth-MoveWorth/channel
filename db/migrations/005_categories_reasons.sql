-- ADR-009: human-set category grants/policy are independent of ADR-004 rules.
ALTER TABLE entities ADD COLUMN category_grants TEXT NOT NULL DEFAULT '["research"]';
ALTER TABLE entities ADD COLUMN category_policy TEXT NOT NULL DEFAULT '{"kind":"ask_every_time"}';
-- Historical tasks have no declared category: do not guess from free-text goals.
ALTER TABLE tasks ADD COLUMN category TEXT CHECK (category IN ('research','read_context','tool_use','write','send_external','publish'));
ALTER TABLE tasks ADD COLUMN reason TEXT CHECK (reason IN ('rejected_by_assignee','approval_rejected','permission_denied','assignee_reported_failure','policy_requires_approval','hop_limit_reached','no_progress_limit_reached','budget_runtime_exceeded','stopped_by_user','parent_cancelled'));
