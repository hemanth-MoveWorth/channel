# SignalDesk Channel — Work Packages

Orchestrator: Mow. Contract: `ARCHITECTURE.md` (v0.1). No code against anything not in the contract.
**WP-00 first:** everyone reads `ARCHITECTURE.md`. Disagreements become ADR entries, not silent code.

---

## ENTITY 1 — Core engine

### WP-E1-01 — Database schema (SQLite, zero external services)
**Objective:** Portable SQL schema for the whole prototype on a local SQLite file. No Supabase, no Docker, no hosted anything (ADR-002).
**Deliverables:**
- Plain `.sql` migrations under `db/migrations/`, applied in order (write a tiny migrate script; no external tools)
- Tables: `users`, `workspaces`, `workspace_members`, `entities` (name, owner, description, capabilities JSON,
  connection_type A/B/C, webhook_url, verified_permissions JSON, availability, last_check),
  `entity_credentials` (key hashes — never logged), `conversations`,
  `conversation_members` (with `is_orchestrator` flag), `messages`, `tasks` (state machine),
  `task_events`, `permission_rules`, `approvals`, `context_packages`, `audit_log`, `job_queue`
- `db/policies.md`: the ADR-001 access rules as policy specifications (enforced in app code for now; real RLS later)
- Seed script with 2 demo entities and 1 group; DB path via `SIGNALDESK_DB_PATH` (default `./data/channel.db`)
**Acceptance:** migrations apply cleanly to a fresh SQLite file; seed loads; a test proves an unauthorized access
attempt is rejected at the application layer per `db/policies.md`. No network calls, no containers.

### WP-E1-02 — Task service + workers
**Objective:** Task lifecycle + durable background delivery.
**Deliverables:**
- State machine: `submitted → queued → working → input_required → awaiting_approval → completed | failed | cancelled`, all transitions in `task_events`
- Delivery receipts per task/request: `stored → delivered → accepted_for_execution`
- Worker process polling the `job_queue` table; retries with **idempotency keys** — a retried task must never repeat a side effect
**Acceptance:** kill the worker mid-task, restart it: task resumes, side effect happened exactly once (prove with a test); cancel/stop works from the API.

### WP-E1-03 — Permission engine + approvals + context packages
**Objective:** Authorization enforced in the execution path, never by the LLM.
**Deliverables:**
- `permission_rules` evaluation: `ask_every_time` | `standing_rules` (e.g. research yes, publish no) | `full_access_workspace`
- Approval queue API: create → `awaiting_approval` → approve/reject; rejection blocks the action, approval resumes it
- Context package assembler: per task builds {goal, facts, history slice, source refs, constraints, expected output}; **per-recipient access check** — a recipient never receives data it isn't cleared for
- Every decision written to `audit_log`
**Acceptance:** unauthorized request blocked with reason; approval pauses execution; crafted test where Entity X requests Entity Y's private doc → denied.

### WP-E1-04 — Minimal web UI
**Objective:** One page where the human watches and controls everything.
**Deliverables:** entity directory, DM + group chat view, live task status, Approve/Reject buttons,
group creation + orchestrator selection, stop button.
**Acceptance:** a full request → approval → result loop is watchable and clickable in the browser.

---

## ENTITY 2 — Protocol + security

### WP-E2-01 — MCP server
**Objective:** MCP as a connection method into the core Entity 1 builds.
**Deliverables:**
- Tools: `register_profile`, `list_entities`, `get_profile`, `send_message`, `check_inbox`, `reply`,
  `create_task`, `update_task`, `list_groups`, `get_conversation_history`
- Transports: **stdio** (Claude Code / Cursor local) and **streamable HTTP** (remote clients)
- Backed by Entity 1's core APIs — **freeze the interface with Entity 1 before implementing** (via Mow)
**Acceptance:** Claude Code connects over stdio, registers a profile, sends a message, checks its inbox against a running core.

### WP-E2-02 — A2A compatibility
**Objective:** Don't invent a protocol — map to the Agent2Agent standard.
**Deliverables:**
- Agent Card JSON schema used for entity profiles
- State mapping table: our task states ↔ A2A task states
- Doc: what an external A2A agent needs to interoperate with us
**Acceptance:** sample Agent Card validates against the schema; mapping table reviewed by Mow.

### WP-E2-03 — Security review + sign-off
**Objective:** You are the security gate. The prototype is not "working" without your sign-off.
**Deliverables:**
- Prompt-injection defenses: agent messages treated as **data, never instructions**; document where the trust boundary sits
- Per-entity API keys / auth; capability **verification** flow (self-claim ≠ grant)
- Hop limits, delegation depth cap, per-task cost/runtime budgets
- `SECURITY.md` checklist + adversarial tests (e.g. malicious agent message attempting privilege escalation or context exfiltration → must be blocked)
**Acceptance:** checklist in repo, adversarial tests pass, written sign-off posted.

---

## Rules for both entities

1. Spec-first: if it's not in `ARCHITECTURE.md`, don't build it — raise it to Mow.
2. Big, self-contained drops: finish a whole work package before asking questions.
3. All cross-package interfaces go through Mow — Entity 1 and Entity 2 don't guess each other's APIs.
4. Report back per package: what was built, how acceptance was proven, what deviated.
5. Branches & PRs: never push directly to `main`. Work on `feat/wp-xxx` branches, open a PR, Mow reviews and merges.
6. Zero external services (ADR-002): SQLite only. No Supabase/Render/Docker/hosted anything until the prototype proves itself locally.
