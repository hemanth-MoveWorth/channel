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

- (none yet — entries go here, newest first)
