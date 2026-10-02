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

### ADR-005: Approval auth, task update rights, dashboard & payload shapes (2026-10-01)
**Status:** accepted. **Context:** Entity 2's three open points + WP-E1-04's spec boundary. Amends ADR-001 §6 and ADR-003 §2.

1. **Approve/reject are human-only (amends ADR-003 §2).** `POST /v1/tasks/:id/approve` and `/reject` MUST
   reject any request bearing an entity API key (403). An agent must never be able to approve paused work,
   including its own. Prototype human auth: the local UI is trusted (documented gap; real login later).
2. **Rejected approval → `cancelled` stands (ADR-003 kept).** `failed` means the work attempted and broke;
   `cancelled` with `reason=approval_rejected` is accurate. A2A mapping uses `cancelled`. Entity 2's P3 is
   superseded on this point only.
3. **Task update rights extended (amends ADR-001 §6).** An entity may: (a) transition tasks **assigned to it**;
   (b) **cancel** tasks it created (requester); (c) submit input to tasks it created while
   `state=input_required`. All other updates → 403. Everything audit-logged.
4. **Dashboard list endpoints (new, frozen):** `GET /v1/tasks?status=&assignee=&requester=` (paginated),
   `GET /v1/approvals?state=pending`, `GET /v1/conversations` (already in ADR-003). The trusted local UI
   uses these for the human dashboard.
5. **Payload shapes (frozen):**
   - Conversation: `{id, workspace_id, type: "dm"|"group", title, member_ids[], orchestrator_entity_id?,
     created_at}`
   - Message: `{id, conversation_id, sender ("human"|entity_id), kind: "chat"|"task_request"|"task_result"|"system",
     body, parent_message_id?, task_id?, created_at}`
   - Inbox item: `{kind: "task"|"mention"|"message", ref_id, summary, created_at}`

### ADR-006: Prototype scope includes connection type B (accepts P1)
**Status:** accepted. **Context:** ARCHITECTURE §2.3 said "prototype needs type A only", but WP-E2-01's own acceptance (Claude Code over stdio) is type B, and the whole point of Phase 0 is testing with real local tools.

1. The prototype covers connection types **A + B**. Type C stays deferred.
2. Orchestrators stay **type A only**; `createGroup` enforces this.
3. A SignalDesk-hosted built-in orchestrator is a later type A entity.

### ADR-007: MCP↔core adapter interface (accepts P2 as amended)
**Status:** accepted. **Context:** P2's wire-contract and transition-table claims are superseded by ADR-003 §§1–2. What remains is the MCP layer's internal adapter contract over ADR-003's `/v1`.

1. ADR-003 §2 stays the frozen wire contract; ADR-003 §1 stays the normative transition table.
2. CORE-API.md is adopted as the **adapter interface** the MCP layer speaks to Entity 1's core: identity bound at `authenticate(apiKey)` with no caller/from/self-id parameters anywhere; approvals, grants, and skill verification exist only on the human-only `AdminApi` (per ADR-005 §1); non-disclosure (`not_found`, never `forbidden`) for invisible objects; receipts per message per recipient; `accepted_for_execution` on a task's origin message at accept.
3. **Reconciliation (Entity 1, after push):** E1 confirms their real `/v1` API has no caller-spoofable fields, or files an amendment through Mow.

### ADR-008: Task reasons and A2A state mapping (accepts P3 as amended)
**Status:** accepted. **Context:** §2.4's state list is frozen; A2A distinguishes "won't do" from "tried and failed", and `awaiting_approval` has no faithful A2A equivalent. The approval-rejection question is settled by ADR-005 §2 (`cancelled`).

1. **Closed `TaskReason` enum** (carried on transitions; Entity 1 owns it in the real core): `rejected_by_assignee`, `approval_rejected`, `permission_denied`, `assignee_reported_failure`, `policy_requires_approval`, `hop_limit_reached`, `no_progress_limit_reached`, `budget_runtime_exceeded`, `stopped_by_user`, `parent_cancelled`.
2. **Assignee declines before accepting:** the assignee transitions its assigned task `queued → cancelled` with `reason=rejected_by_assignee` (edge exists in ADR-003 §1; ADR-005 §3(a) gives the assignee transition rights). No transition-table amendment needed. This keeps "`failed` = attempted and broke" (ADR-005 §2) intact.
3. **A2A mapping:** `failed` + `permission_denied` → `TASK_STATE_REJECTED`; `failed` + any other reason → `TASK_STATE_FAILED`; `cancelled` (any reason) → `TASK_STATE_CANCELED`; `awaiting_approval` → `TASK_STATE_WORKING` + `metadata["signaldesk/state"]="awaiting_approval"`.

### ADR-009: Action categories and two-sided authorisation (accepts P4 as amended)
**Status:** accepted. **Context:** §2.8 names "standing rules" but no category set; WP-E1-03 built the permission engine without one. This is the normative model; Entity 1's engine is the real implementation.

1. Fixed ordered categories, lowest to highest risk: `research < read_context < tool_use < write < send_external < publish`.
2. A task requires **both**: (a) a requester grant for its category, checked at `createTask` (refused with 422 if missing — fail closed); **and** (b) the assignee's human-set policy for the category to be `allow`/`ask`, evaluated when the assignee accepts. A deny from either side is final. `ask` → `working → awaiting_approval` (`reason=policy_requires_approval`).
3. The assignee may `reclassify` **upward only**, from `working`, re-running both checks; denied → `working → failed` (`reason=permission_denied`); ask → `working → awaiting_approval`. (Reclassify from `queued`/`input_required` in E2's original table is superseded by ADR-003 §1.)
4. Bootstrap defaults: new entity grants = `{research}`, policy = `ask_every_time` (SECURITY.md §3.2).
5. **Reconciliation (Entity 1, after push):** E1 confirms the engine adopts this category model and the two-sided check, or files an amendment through Mow. This coexists with ADR-004: ADR-004 rules govern sources/tools/conversations/tasks; ADR-009 governs task action categories.

### ADR-010: `get_task` MCP tool (accepts P5)
**Status:** accepted. **Context:** requesters could only learn task state by draining `check_inbox`.

1. Add a read-only `get_task(taskId)` MCP tool: party-only (requester/assignee), non-disclosing (`not_found` to anyone else, per ADR-007 §2).

### ADR-011: Task assignment inside groups (accepts P6)
**Status:** accepted. **Context:** §2/§3 didn't say who may assign tasks in a group; the reference core let any member assign.

1. New per-group setting `assignment: "any_member" | "orchestrator_only"`. Default: `orchestrator_only` when an orchestrator is set, `any_member` when none is set.
2. The group create/update schema carries this setting; the dashboard (WP-E1-04) surfaces it.
3. `any_member` is not a privilege escalation: every assignment still passes ADR-009's two-sided category checks.

### Proposed by Entity 2: ADR-P1 … ADR-P6 (2026-10-01)
**Status:** ~~proposed, awaiting Mow's ruling. Not accepted.~~ Proposed, then **accepted** by Mow as ADR-006 … ADR-011 (P1 → ADR-006; P2 → ADR-007 as amended; P3 → ADR-008 as amended; P4 → ADR-009 as amended; P5 → ADR-010; P6 → ADR-011). Kept for the record; the accepted ADRs above are normative.

All entries below are **PROPOSED by Entity 2 (2026-10-01)**, ~~awaiting Mow's decision~~ *(since accepted as ADR-006 … ADR-011)*. Code written against them is marked as such, and it's cheap to change.

- **ADR-P1: Prototype scope includes connection type B.** *Problem:* §2.3 says "prototype needs type A only", but WP-E2-01 acceptance (Claude Code over stdio) and real-tool testing are type B. *Proposal:* the prototype covers A + B. C stays deferred. Orchestrators stay type A only, which `createGroup` enforces. A SignalDesk-hosted built-in orchestrator is a later type A entity.
- **ADR-P2: Freeze the core interface.** *Partly superseded by ADR-003.* Where this entry overlaps ADR-003, ADR-003 is normative: §2 for the frozen Core API v0.1 wire contract, §1 for legal task transitions. Superseded spots are struck through and kept for the record. The rest of the entry is still proposed. *Problem:* ~~WP-E2-01 must freeze the MCP↔core interface before Entity 1's core exists.~~ *(superseded: ADR-003 §2 froze it.)* *Proposal:* ~~adopt docs/protocol/CORE-API.md.~~ *(superseded as the wire contract by ADR-003 §2. CORE-API.md stays proposed only as the MCP layer's internal adapter interface over `/v1`.)* Identity is bound at `authenticate(apiKey)`, with no `caller` parameters. Approvals, grants and verification exist only on `AdminApi`, which is human-only. Non-disclosure (`not_found`) applies to invisible objects. ~~The **state-transition table** (CORE-API §3) replaces the linear reading of §2.4.~~ *(superseded by ADR-003 §1.)* Receipts are per message per recipient, and `accepted_for_execution` sits on a task's origin message (CORE-API §4). *Today:* the MCP server is built against it. A dev-only `/core/rpc` stands in for Entity 1's API until WP-E1 lands.
- **ADR-P3: Rejections and approval pauses in the state model.** *Problem:* the §2.4 state list has no `rejected`, and A2A does. `awaiting_approval` has no faithful A2A equivalent. *Proposal:* keep §2.4 frozen. Represent rejection as `failed` + `reason` from a closed `TaskReason` enum, mapped to A2A `TASK_STATE_REJECTED`. *(Superseded in part by ADR-005 §2: a rejected **approval** is `cancelled` with `reason=approval_rejected`, mapped to `TASK_STATE_CANCELED`. The rest of P3 is still proposed.)* Show `awaiting_approval` to A2A clients as `TASK_STATE_WORKING` + `metadata["signaldesk/state"]` (see docs/protocol/A2A.md §3.1). *Today:* built.
- **ADR-P4: Action categories and two-sided authorisation.** *Problem:* §2.8 names "standing rules (research yes, publish no)" but no category set. *Proposal:* fixed ordered set `research < read_context < tool_use < write < send_external < publish`. A task needs (a) a requester grant for its category AND (b) the assignee's policy for it to be allow/ask. A deny from either side is final. Ask → `awaiting_approval`. The assignee may `reclassify` upward only, which re-runs both checks and fails closed. *Today:* built in the reference core and MCP layer. Entity 1 owns the real engine (WP-E1-03).
- **ADR-P5: Add `get_task` MCP tool.** *Problem:* the §3 tool list lets requesters learn task state only by draining `check_inbox`. *Proposal:* add a read-only `get_task(taskId)` (party-only, non-disclosing). *Today:* not built. `CoreSession.getTask` exists.
- **ADR-P6: Task assignment inside groups.** *Problem:* §2/§3 don't say who may assign tasks within a group. *Proposal:* add a per-group setting `assignment: "any_member" | "orchestrator_only"`, defaulting to `orchestrator_only` when an orchestrator is set. *Today:* the reference core allows any member. That's flagged in CORE-API.md §7.

### ADR template for future entries
`### ADR-NNN: Title (YYYY-MM-DD)` + Status + Context + numbered decisions.
