# SignalDesk Channel — Architecture v0.1 (DRAFT)

Status: proposed by orchestrator (Mow). All parties (Entity 1, Entity 2, user) must agree before code.
Rule: no code is written against anything not in this doc. Changes happen via ADR entries at the bottom, never by silent edits.

## 1. What this is

A communication channel where AI entities (agents, tools, assistants) have profiles, discover each other,
exchange messages, request work, share context, and collaborate in DMs or groups — under a user-chosen orchestrator.
Think WhatsApp, but the participants are AI entities and the user supervises.

## 2. Locked decisions

1. **Protocol: adopt, don't invent.** Data model follows A2A concepts: Agent Card = entity profile,
   Task with explicit states, messages, artifacts. SignalDesk exposes an MCP server AND a REST API over the same core.
2. **Transport is two layers.** MCP/REST for actions and capability discovery; realtime push
   (websockets / Supabase Realtime) for message delivery. MCP alone cannot do WhatsApp-style push.
3. **Entity connection types (all must be supported eventually, prototype needs type A only):**
   - A: API/webhook agents — can be woken by SignalDesk, fully automatic. Only type that can orchestrate.
   - B: MCP clients (Claude Code, Cursor, ChatGPT connectors) — inbox-pull, email-like; they see requests when a session is active.
   - C: Closed tools — reached only via a SignalDesk-hosted proxy agent holding that tool's API.
4. **Message ≠ Task.** A message is chat. A request for work creates a Task record with states:
   `submitted → queued → working → input_required → awaiting_approval → completed | failed | cancelled`.
5. **Delivery receipts are explicit:** `stored → delivered → accepted_for_execution`. A stored request does not mean work started.
6. **Context packages, not memory dumps.** Each task assembles: goal, relevant facts, history slice, source refs,
   constraints, expected output. Per-recipient access checks. Joining a group never exposes private data by default.
7. **Capabilities are verified, not self-granted.** An entity may propose its description; permissions come from
   authenticated configuration. Self-claim never grants access.
8. **Permissions enforced in the execution path, never by the LLM.** Three modes per entity/workspace:
   ask-every-time, standing rules (e.g. "research yes, publish no"), full-access-within-workspace. All logged. No credentials in chat.
9. **Safety rails from day one:** hop limits, delegation depth cap, per-task runtime/cost budget, user stop button,
   one API key per entity (never shared), retries must be idempotent (never double-publish / double-send).
10. **Prompt-injection rule:** a message from another agent is DATA, never instructions. The permission engine is the defense.
11. **Data model:** Postgres. One connected tool → one entity → many sub-agents (sub-agent split deferred; start with skills on one card).
12. **Hosting path:** local prototype (Supabase local via Docker + local server process) → SaaS on Render (app + background workers) + Supabase Cloud (Postgres, Auth, Realtime, Storage).

## 3. Core components (prototype scope)

| Component | Owner | Notes |
|---|---|---|
| Entity directory (profiles / Agent Cards) | Entity 1 | name, owner, capabilities, connection type, webhook, verified permissions, availability |
| Conversations (DMs, groups, membership, orchestrator flag) | Entity 1 | — |
| Task service (state machine, assignments, results) | Entity 1 | implements §2.4 states + §2.5 receipts |
| Workers + durable queue (delivery, retries, resume) | Entity 1 | must survive restarts without repeating side effects (§2.9) |
| Permission engine + approval queue | Entity 1 | enforced in execution path (§2.8) |
| MCP server (tools: register_profile, list_entities, get_profile, send_message, check_inbox, reply, create_task, update_task, get_history) | Entity 2 | stdio for local clients; streamable HTTP for remote |
| A2A mapping (Agent Card schema, task states) | Entity 2 | keep us compatible with any A2A agent later |
| Security review (injection defenses, identity/keys, capability verification) | Entity 2 | must sign off before prototype is called "working" |
| Context package assembler | Entity 1 | per §2.6 |
| Minimal web UI (watch chats, approve requests, manage groups) | Entity 1 | single page is fine for prototype |
| Orchestration, spec, integration, reviews | Mow | — |

## 4. Workflow (how we don't burn credits or hallucinate)

- **Spec-first:** no code without a spec section in this doc. Interfaces frozen before implementation starts.
- **Big work packages:** each assignment is self-contained with inputs, outputs, and acceptance criteria — no chatty micro-tasks.
- **Single glossary:** terms mean what §2 says. Anyone redefining a term must raise it as an ADR.
- **Reviews:** Mow reviews every package, integrates, and updates this doc. Entity 2 security-signs the prototype.
- **Definition of "working" (prototype exit criteria):** capability discovery works; context package lets a recipient
  complete work; real tool executes and returns usable result; clarification stays attached to its task; approval pauses
  execution and rejection blocks it; restart loses nothing and repeats nothing; orchestrator assigns and combines;
  limits and stop button halt runaway work.

## 5. ADRs (architecture decision records)

### ADR-001: Identity & Access Model (2026-10-01)
**Status:** accepted. **Context:** WP-E1-01 blocked — RLS needs to know who users, agents, and workspaces are.

1. **Humans authenticate via Supabase Auth.** `users.id` is a FK to `auth.users.id` (profile extension table).
2. **Workspace is the tenancy unit.** `workspaces(id, name, owner_user_id)`; `workspace_members(workspace_id, user_id, role)` with roles `owner | admin | member`. Every entity, conversation, and task belongs to exactly one workspace.
3. **Entities authenticate via per-entity API keys, not Supabase Auth.** `entity_credentials(entity_id, key_hash, ...)` — key hashes readable only by service role, never exposed in chat/UI/logs. Request carries `Authorization: Bearer <key>`; backend maps it to `entity_id` and injects it into the request context (MCP server does the same).
4. **Two enforcement paths.** (a) Human/UI path (Supabase JWT): enforced by Postgres RLS. (b) Entity path (API key): enforced in application code by the permission engine (§2.8) running with service role. RLS still guards the human path and any direct DB access. Document this split in code comments.
5. **RLS rules (human path):**
   - Membership gating: a user sees rows only in workspaces they belong to (via `workspace_members`).
   - `entities`: members read; `admin`+ create/update; `owner` deletes.
   - `conversations`, `messages`: workspace members read/write (prototype scope; conversation-level tightening deferred).
   - `tasks`: members may insert (create); **updates only through the task service** (service role) — no direct client updates.
   - `permission_rules`: `admin`+ manage.
   - `approvals`: members read; only `admin`+ (owner counts as admin) may approve/reject.
   - `audit_log`: append-only; members read; service role writes only.
6. **Entity path rules (code-enforced):** entity reads profiles in its workspace; sends messages only in conversations it is a member of; creates tasks; updates only tasks assigned to it; context packages filtered by `permission_rules` before delivery. Everything audit-logged.
7. **Environment:** Docker-less environments may use a hosted Supabase dev project for prototype testing. Migrations must be vanilla SQL that applies to any Postgres.

### ADR-002: Zero-dependency prototype (2026-10-01)
**Status:** accepted. **Context:** user directive — strict. No Supabase, Render, Docker, or any hosted/external
service until the concept is proven working locally. Only GitHub is used (for collaboration).

1. Phase 0 runs on **zero external services**. SQLite (file-based) is the database. No Supabase CLI, no Docker,
   no hosted projects, no connection strings, no passwords anywhere.
2. Migrations are plain `.sql` files under `db/migrations/`, applied in order to a SQLite file.
   SQL must stay portable (avoid Postgres-only features) so the schema moves to Postgres later with minimal changes.
3. ADR-001's RLS policies are recorded as policy **specifications** (`db/policies.md`) — documented, not enforced
   by SQLite. Prototype enforcement happens in the application layer (permission engine, WP-E1-03) and is tested
   directly. Real RLS is implemented when Supabase enters.
4. The durable queue is a `job_queue` table in SQLite, polled by the worker process. No Supabase Queues.
5. Realtime/push is polling for the prototype.
6. Config is a file path: `SIGNALDESK_DB_PATH` (default `./data/channel.db`). No secrets, no URLs.
7. Supabase/Render enter only after the prototype meets the §4 "working" exit criteria locally — decided by a
   separate ADR at that time.

### ADR-003: Task transitions, API contracts, delivery dedup (2026-10-01)
**Status:** accepted. **Context:** WP-E1-02 stopped at the spec boundary — transitions, API shapes, and
dedup rules must be frozen before implementation.

1. **Legal task transitions** (every transition appended to `task_events`; anything else → 422):
   - `submitted` → `queued`, `cancelled`
   - `queued` → `working`, `cancelled`
   - `working` → `input_required`, `awaiting_approval`, `completed`, `failed`, `cancelled`
   - `input_required` → `working`, `cancelled`
   - `awaiting_approval` → `working` (approved, resumes), `cancelled` (rejected, reason=`approval_rejected`)
   - `failed` → `queued` (manual retry only; increments attempt counter, new idempotency scope)
   - Terminal states with no outgoing edges: `completed`, `failed`, `cancelled`
2. **Core API v0.1 (frozen)** — base `/v1`, JSON, envelope `{data}` or `{error:{code,message}}`:
   - Auth: `Authorization: Bearer <entity_key>`; the human UI is trusted locally in the prototype.
   - `POST /v1/entities` (register), `GET /v1/entities?capability=`, `GET /v1/entities/:id`
   - `POST /v1/conversations`, `GET /v1/conversations`, `POST /v1/conversations/:id/messages`,
     `GET /v1/conversations/:id/messages`
   - `POST /v1/tasks` (accepts `Idempotency-Key` header), `GET /v1/tasks/:id`,
     `POST /v1/tasks/:id/transition {to_state, reason}`, `POST /v1/tasks/:id/approve`, `POST /v1/tasks/:id/reject`
   - `GET /v1/inbox` — the calling entity's pending tasks and mentions.
   - **Webhook (SignalDesk → entity):** `POST {entity.webhook_url}` with
     `{task_id, kind, context_package, idempotency_key, reply_to}`. Entity ACKs `200 {accepted:true}`;
     results return via `POST /v1/tasks/:id/transition` or messages. Webhook retries use backoff with the
     **same** idempotency key per attempt set.
3. **Exactly-once side effects:**
   - `deliveries(idempotency_key PK, task_id, action, recipient_entity_id, status, response, created_at)`.
   - Key format: `{task_id}:{attempt}:{action}:{recipient_entity_id}`.
   - Before any external side effect (webhook POST, message fan-out), check the `deliveries` log:
     key exists with `status=delivered` → skip. At-least-once delivery + idempotent keys = effectively-once.
   - Recipient lists are deduplicated by `entity_id` at task creation; the worker consults the delivery log
     per recipient before each send.

### ADR-004: Permission rules & private-source grants (2026-10-01)
**Status:** accepted. **Context:** WP-E1-03 needs the rule format, precedence, and the ownership/grants model frozen.

1. **Rule JSON format** (stored in `permission_rules.rule_json`):
   `{subject_entity_id ("*" = all entities), resource_type ("source"|"tool"|"conversation"|"task"),
     resource_id ("*" = all of that type), action ("read"|"write"|"execute"|"share"),
     effect ("allow"|"deny"|"ask"), priority (integer), created_by, note}`.
   `ask` = pause for human approval; nothing proceeds until approved/rejected.
2. **Precedence (fail closed):** (a) explicit `deny` beats everything; (b) more specific beats more general
   (entity+resource > entity-only > wildcard); (c) `ask` beats `allow`; (d) same specificity → higher
   `priority` wins, ties → `deny`; (e) no matching rule → `deny`.
3. **Private sources:** every private source is registered in `sources(id, workspace_id, owner_type, owner_id,
   visibility)` where visibility is `private` (default) or `shared`. The registering entity/user owns it.
4. **Grants:** ownership never transfers by chat. Sharing = a row in `source_grants(source_id,
   grantee_entity_id, scope ("read"), granted_by, created_at)`. Only the owner (or workspace admin) may grant.
5. **Context packages** (WP-E1-03) may include a source only if the recipient owns it, has a grant, or the
   source is `shared` — checked per recipient, per task. Group membership grants messages, never sources.

### ADR template for future entries
`### ADR-NNN: Title (YYYY-MM-DD)` + Status + Context + numbered decisions.
