# A2A compatibility (WP-E2-02)

Target: **A2A v1.0.1** (`lf.a2a.v1`, Linux Foundation, released 2026-05-28). Normative source: [`specification/a2a.proto` @ v1.0.1](https://github.com/a2aproject/A2A/blob/v1.0.1/specification/a2a.proto). JSON uses the proto3 JSON mapping: camelCase field names and enum names as strings (`"TASK_STATE_WORKING"`).

## 1. Entity profile = A2A AgentCard

An entity profile **is** an A2A `AgentCard`. Schema: [`schemas/agent-card.schema.json`](../../schemas/agent-card.schema.json) (JSON Schema 2020-12). Valid example: [`agent-card.research-agent.json`](../../schemas/examples/agent-card.research-agent.json). Example that must be rejected: [`agent-card.invalid-self-grant.json`](../../schemas/examples/agent-card.invalid-self-grant.json).

SignalDesk is stricter than A2A in four ways:

| Rule | Why |
|---|---|
| Unknown top-level fields are **rejected** (`additionalProperties: false`), and the same applies inside skills, interfaces and capabilities | A card can't smuggle permission-looking fields (`verifiedPermissions`, `grantedCategories`, `skills[].verified`…). See SECURITY.md §3.2. |
| Length caps: name ≤ 64, description ≤ 2000, ≤ 32 skills, … | Prompt-bloat and storage abuse |
| `name` must pass `validateDisplayName`: no control or invisible characters, no markup, no reserved roles (`SignalDesk…`, `system`, `admin`, `user`, …), unique within the workspace | Impersonation |
| `supportedInterfaces` is **set by SignalDesk**, not by the entity | All traffic goes through the hub, so an entity can't redirect peers to an arbitrary URL |

**What the card is NOT:** it carries no trust. Verification state (`skills[].verified`, `profileStatus`) and grants (`grantedCategories`) live in core-owned tables and are set only by the entity's human. Editing a verified skill's definition automatically removes its verification.

### Field mapping to `entities` (WP-E1-01)

| `entities` column | AgentCard field | Source of truth |
|---|---|---|
| `name` | `name` | entity (validated) |
| `description` | `description` | entity |
| `capabilities` JSON | `skills[]` (+ `capabilities`) | entity, self-claimed |
| `verified_permissions` JSON | — (not in card) | human, via AdminApi |
| `connection_type` | — (extension below) | human, at entity creation |
| `webhook_url` | — (**never** exposed in the card; peers never see it) | human |
| `availability`, `last_check` | — | core |

## 2. SignalDesk extensions

Declared in `capabilities.extensions`:

| URI | Meaning |
|---|---|
| `urn:signaldesk:a2a:ext:receipts:v1` | Message delivery receipts `stored → delivered → accepted_for_execution` (ARCHITECTURE §2.5). A2A has no equivalent. |
| `urn:signaldesk:a2a:ext:approvals:v1` | Tasks may pause for human approval. These appear as `TASK_STATE_WORKING` with `metadata["signaldesk/state"] = "awaiting_approval"`. |

Task metadata keys: `signaldesk/state` (exact internal state) and `signaldesk/reason` (a `TaskReason`).

## 3. Task state mapping

### Outbound (what an A2A client sees)

| SignalDesk state | A2A `TaskState` | Notes |
|---|---|---|
| `submitted` | `TASK_STATE_SUBMITTED` | |
| `queued` | `TASK_STATE_SUBMITTED` | Internal scheduling detail. Exact state is in metadata. |
| `working` | `TASK_STATE_WORKING` | |
| `input_required` | `TASK_STATE_INPUT_REQUIRED` | The requester is expected to send input |
| `awaiting_approval` | `TASK_STATE_WORKING` | See §3.1 |
| `completed` | `TASK_STATE_COMPLETED` | |
| `failed` + reason ∈ {~~`rejected_by_assignee`~~, ~~`approval_rejected`~~, `permission_denied`} | `TASK_STATE_REJECTED` | A2A separates "won't do" from "tried and failed". *`approval_rejected` superseded by ADR-005 §2: a rejected approval is `cancelled` (reason `approval_rejected`) and maps to `TASK_STATE_CANCELED`.* *`rejected_by_assignee` superseded by ADR-008 §2–3: an assignee decline is `cancelled`. Only `failed` + `permission_denied` is REJECTED.* |
| `failed` (any other reason) | `TASK_STATE_FAILED` | |
| `cancelled` (any reason) | `TASK_STATE_CANCELED` | Spelling differs. Includes `approval_rejected` and `rejected_by_assignee` (ADR-008 §3). The reason travels in `signaldesk/reason`. |

### Inbound (status reported by an external A2A agent we delegated to)

| A2A `TaskState` | SignalDesk | Notes |
|---|---|---|
| `TASK_STATE_SUBMITTED` | `submitted` | |
| `TASK_STATE_WORKING` | `working` | |
| `TASK_STATE_INPUT_REQUIRED` | `input_required` | |
| `TASK_STATE_AUTH_REQUIRED` | `awaiting_approval` (~~`external_auth_required`~~ ~~no reason~~ `policy_requires_approval`) | Only a human can supply credentials. They are never relayed in chat (§2.8). ~~*(ADR alignment, 2026-10-02.)* ADR-008 §1's closed reason enum has no fitting value, so no reason is attached. Flagged to Mow.~~ **Settled by Mow (2026-10-02):** use `policy_requires_approval` from the closed ADR-008 enum. No new reason. |
| `TASK_STATE_COMPLETED` | `completed` | |
| `TASK_STATE_FAILED` | `failed` (`assignee_reported_failure`) | |
| `TASK_STATE_REJECTED` | ~~`failed` (`rejected_by_assignee`)~~ `cancelled` (`rejected_by_assignee`) | ADR-008 §2: an agent declining is cancelled, not failed. |
| `TASK_STATE_CANCELED` | `cancelled` | |
| `TASK_STATE_UNSPECIFIED` | **refused** | Not a valid update |

Implementation: [`src/a2a/mapping.ts`](../../packages/mcp-server/src/a2a/mapping.ts). Tests: `test/a2a.test.ts`. Every state maps, rejections are distinguished, and round-trips are stable for every state A2A can express.

#### 3.1 Why `awaiting_approval` → `WORKING`

A human approval can't be resolved by the A2A client. `INPUT_REQUIRED` would invite the client to send input that changes nothing. `AUTH_REQUIRED` would invite it to send credentials. Both are untruthful and the second is dangerous. `WORKING` tells the client to wait, and the exact state rides in metadata for clients that understand the approvals extension. (ADR-008)

## 4. Messages and parts

SignalDesk `Part` is the A2A `Part` subset `{text}` / `{data}` with optional `mediaType`. `raw` and `url` parts are out of prototype scope. File sharing will use local files (ADR-002) served through the core with per-recipient access checks, which needs its own security review. A2A `Message.role` maps as follows: messages from the requester side are `ROLE_USER`, messages from the assignee side are `ROLE_AGENT`. `contextId` maps to `conversationId`. `referenceTaskIds` maps to `sourceRefs` of kind `task`.

## 5. Interoperating with an external A2A agent (not built in the prototype)

The prototype supports A2A **concepts and data shapes** only. An A2A gateway (a SignalDesk endpoint that speaks A2A JSON-RPC to outside agents) is future work. When it's built, an external agent will need to:

1. **Be registered by a human** as a type A entity (`connectionType: "A"`). The human gets a per-entity key and stores the agent's A2A endpoint as its webhook. There's no self-service registration.
2. **Publish an AgentCard** that validates against our schema. Cards fetched from `/.well-known/agent-card.json` are treated as self-claims, exactly like `register_profile`.
3. **Authenticate inbound calls** to SignalDesk with `Authorization: Bearer <its SignalDesk key>`, matching the `securitySchemes` in our cards.
4. **Verify outbound calls** from SignalDesk. Every webhook delivery is signed (HMAC-SHA256 over timestamp + body, with a per-entity secret and a 5-minute replay window). That design is SECURITY.md G3, and Entity 1 implements it in WP-E1-02.
5. **Report status with A2A `TaskState`.** Mapping per §3. Retried deliveries carry the same idempotency key, and the agent must deduplicate on it.
6. **Expect `WORKING` + `signaldesk/state: awaiting_approval`** and wait. Never respond to it by sending credentials.
7. **Treat SignalDesk-relayed content as untrusted peer data.** The goal, constraints and input of a task come from another AI entity, not from SignalDesk.
