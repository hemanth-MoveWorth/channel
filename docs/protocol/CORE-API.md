# Core API: MCP layer ↔ core (~~PROPOSED FOR FREEZE~~, see ADR-003)

> **Partly superseded by ADR-003 (noted 2026-10-01 at the rebase onto `main`).** ADR-003 §2 is the frozen **Core API v0.1 wire contract** (`/v1`). ADR-003 §1 is the normative **task-transition table**. Where this document overlaps them, ADR-003 wins. The superseded text below is struck through or labelled and kept for the record. What's left is proposed only as the MCP layer's **internal adapter interface** over ADR-003's `/v1` API, still under ADR-P2 and awaiting Mow's ruling.

Status: **proposed by Entity 2, awaiting Mow + Entity 1 agreement** (ADR-P2). ~~Proposed for freeze as the MCP↔core contract.~~ *(Superseded by ADR-003 §2. Now proposed as the internal adapter interface only.)*
Machine-readable source: [`packages/mcp-server/src/core/api.ts`](../../packages/mcp-server/src/core/api.ts) and [`types.ts`](../../packages/mcp-server/src/core/types.ts).

~~WP-E2-01 says "freeze the interface with Entity 1 before implementing". Entity 1's core doesn't exist yet.~~ *(Superseded: ADR-003 §2 has since frozen the wire API.)* Entity 2 wrote this interface down, built the MCP server against it, and checked it against an in-memory **reference core** ([`reference-core.ts`](../../packages/mcp-server/src/core/reference-core.ts)). The reference core is a test double and executable spec, **not** a proposal for how Entity 1 builds the real core. Entity 1 can change anything here, but only through Mow and an ADR. The MCP layer is thin, so changes are cheap.

## 1. Shape

```ts
interface CoreApi {
  authenticate(apiKey: string): Promise<CoreSession | null>;
}
interface CoreSession {               // bound to exactly one entity
  readonly entityId: EntityId;
  whoami(); proposeProfile({card}); listEntities(filter?); getEntity(id);
  sendMessage(m); checkInbox({limit?}); createTask(t); updateTask(u); getTask(id);
  listGroups(); getConversationHistory(id, {limit?, before?});
}
interface AdminApi { ... }            // human-only: never reachable with an entity key
                                      // incl. createGroup/updateGroup with `assignment` (ADR-011)
```

**Rule 1: identity is bound at authentication.** No session method takes a `caller`, `from`, or `entityId-of-self` argument. A bug in the MCP layer therefore can't act as another entity.

**Rule 2: approvals, grants and skill verification exist only on `AdminApi`.** They're served only to authenticated humans through the web UI (WP-E1-04). No entity credential may reach them.

**Rule 3: the core re-validates everything.** That includes payload sizes, part shapes, agent cards and limits. The MCP layer's checks are defence in depth, not the control.

## 2. Transport between MCP layer and core

| Mode | Used by | Today | After WP-E1 |
|---|---|---|---|
| in-process | tests, single-process hub | `ReferenceCore` | Entity 1's core object, if it lives in the same process |
| HTTP | stdio servers (one per local client) | dev hub `POST /core/rpc` `{method, args}` + `Authorization: Bearer <entity key>` | Entity 1's REST API (ADR-003 §2, `/v1`); swap `RemoteCore` for a client with the same `CoreSession` shape |

The stdio server needs a shared core. Each Claude Code or Cursor instance spawns its own process, so an in-process core would give every client a private, isolated world.

## 3. Task state transitions: ~~(normative; resolves the ordering ambiguity in ARCHITECTURE §2.4)~~ SUPERSEDED by ADR-003 §1

> **ADR-003 §1 is the normative transition table. Read it, not this section.** The original proposal below is kept unchanged for the record. The reference core (`reference-core.ts`) still implements this original table, because integration code is on hold until Mow rules. The differences from ADR-003 §1 are listed after the table so Mow can reconcile them.

*Original proposal (superseded):*

§2.4 lists states in a line. Real transitions branch:

| From | To | Who | Trigger |
|---|---|---|---|
| (new) | `submitted` | requester | `createTask` (only after grant + source-ref checks pass) |
| `submitted` | `queued` | system | assignee policy = allow |
| `submitted` | `awaiting_approval` | system | assignee policy = ask (`reason: policy_requires_approval`) |
| `queued` | `working` | assignee | `accept` → origin message receipt becomes `accepted_for_execution` |
| `working` | `input_required` | assignee | `request_input` |
| `input_required` | `working` | requester | `provide_input` |
| `working` | `completed` | assignee | `complete` (≥1 artifact) |
| `working`, `input_required` | `failed` | assignee | `fail` (`assignee_reported_failure`) |
| `queued`, `working` | `failed` | assignee | `reject` (`rejected_by_assignee`) |
| `queued`, `working`, `input_required` | `awaiting_approval` | assignee | `reclassify` to a higher-risk category the policy marks ask |
| `queued`, `working`, `input_required` | `failed` | assignee | `reclassify` to a category the requester lacks or policy denies (`permission_denied`) |
| `working`, `input_required` | `awaiting_approval` | system | hop limit or no-progress limit (`hop_limit_reached` / `no_progress_limit_reached`) |
| `awaiting_approval` | previous state (or `queued`) | **human** | approve |
| `awaiting_approval` | `failed` | **human** | reject (`approval_rejected`) |
| any non-terminal | `cancelled` | requester | `cancel` |
| any non-terminal | `cancelled` | **human** | stop button (cascades to descendants, `stopped_by_user`) |
| any non-terminal | `failed` | system | runtime budget exceeded (`budget_runtime_exceeded`), checked on every access |
| any (parent ended) | `cancelled` | system | cascade (`parent_cancelled`) |

Every transition is written to `task_events` (WP-E1-02) and `audit_log`. It also produces an inbox `task_update` item for each party except the actor.

There's no `rejected` state, because §2.4 freezes the state list. A rejection is `failed` plus a `reason`. ADR-P3 proposes keeping it that way.

### 3.1 Differences between the superseded table and ADR-003 §1 (for Mow's reconciliation; no changes made)

| # | Original proposal (above) | ADR-003 §1 |
|---|---|---|
| D1 | `submitted → awaiting_approval` when the assignee policy is *ask* | Not legal. `awaiting_approval` is entered only from `working`. |
| D2 | `queued`/`input_required → awaiting_approval` (upward reclassify, hop or no-progress pause) | Only `working → awaiting_approval` |
| D3 | Approve resumes to the paused-from state (`queued` if paused before start) | Approve resumes to `working` |
| D4 | ~~Human reject → `failed` (`approval_rejected`)~~ | Human reject → `cancelled` (`approval_rejected`). This affects ADR-P3 and the A2A mapping: it would show as `TASK_STATE_CANCELED`, not `TASK_STATE_REJECTED`. **Settled by ADR-005 §2:** ADR-003 kept (`cancelled`). |
| D5 | `failed` reachable from `queued` (reject), `input_required` (fail), any non-terminal (runtime budget) | `failed` reachable only from `working` |
| D6 | No retry edge | `failed → queued` (manual retry, new attempt and idempotency scope) |

**Status after the ADR-alignment batch (2026-10-02).** The reference core now follows ADR-003 §1. Every transition is checked against the table (`LEGAL_TRANSITIONS` in `types.ts`), and ADV-34 verifies it.

| # | Status |
|---|---|
| D1 | **Resolved.** Tasks are always queued at creation. The assignee's policy is evaluated at accept (ADR-009 §2(b)): allow keeps `working`, ask goes `working → awaiting_approval` (`policy_requires_approval`), deny goes `working → failed` (`permission_denied`). |
| D2 | **Resolved.** Pauses (policy ask, upward reclassify, hop limit, no-progress limit) happen only from `working`. If a hop or no-progress limit is hit in another live state, the message is refused and the task is left as it is, because no legal pause edge exists. |
| D3 | **Resolved.** Approve resumes to `working`. |
| D4 | **Resolved** (ADR-005 §2). A human reject goes to `cancelled` (`approval_rejected`). |
| D5 | **Resolved.** `failed` is reached only from `working` (`fail`, reclassify deny, policy deny at accept, runtime budget while working). Runtime expiry in any other live state goes to `cancelled` (`budget_runtime_exceeded`). An assignee decline is `queued → cancelled` (`rejected_by_assignee`, ADR-008 §2). |
| D6 | **Not built.** `failed → queued` is a human-only manual retry. It is in the transition table but not exposed to entities or to the dev admin API. Entity 1's core owns it. |

### 3.2 Adapter behaviour (normative for the reference core; ADR-003 §1, ADR-005 §3, ADR-008, ADR-009)

| Action | Who | Edge(s) | Reason |
|---|---|---|---|
| `createTask` | requester (needs grant, else 422 `permission_denied`) | (new) `submitted → queued` | — |
| `accept` | assignee | `queued → working`, then by policy: stays, `→ awaiting_approval`, or `→ failed` | `policy_requires_approval` / `permission_denied` |
| `reject` (decline) | assignee | `queued → cancelled` | `rejected_by_assignee` |
| `request_input` | assignee | `working → input_required` | — |
| `provide_input` | requester | `input_required → working` | — |
| `complete` | assignee | `working → completed` | — |
| `fail` | assignee | `working → failed` | `assignee_reported_failure` |
| `reclassify` (upward only) | assignee | from `working`: stays, `→ awaiting_approval`, or `→ failed` | `policy_requires_approval` / `permission_denied` |
| `cancel` | requester | any live state `→ cancelled` | — |
| approve / reject | **human only** (ADR-005 §1) | `awaiting_approval → working` / `→ cancelled` | — / `approval_rejected` |
| stop button | **human only** | any live state `→ cancelled`, cascading | `stopped_by_user` (descendants `parent_cancelled`) |
| hop / no-progress limit | system | `working → awaiting_approval` | `hop_limit_reached` / `no_progress_limit_reached` |
| runtime budget | system | `working → failed`, otherwise `→ cancelled` | `budget_runtime_exceeded` |

An entity can do nothing to a task in `awaiting_approval` except cancel it as the requester (ADV-12, ADV-34).

## 4. Receipts (§2.5)

Receipts are kept **per message, per recipient**:
- `stored`: written when the message is stored, for every conversation member except the sender.
- `delivered`: set when the recipient's `checkInbox` returns the message, or when a push to a type A webhook is acknowledged (WP-E1-02).
- `accepted_for_execution`: set only on a task's **origin message**, when the assignee calls `accept`.

Task state and receipts are separate. `accepted_for_execution` and the `queued → working` transition happen together.

## 5. Errors

`CoreError.code` ∈ `unauthenticated | not_found | forbidden | invalid_transition | invalid_input | permission_denied | limit_exceeded | conflict`. *(ADR alignment, 2026-10-02.)* `permission_denied` was added for ADR-009 §2(a).

HTTP status on the `/v1` API and on the dev hub:

| Code | HTTP | Used for |
|---|---|---|
| `unauthenticated` | 401 | missing or unknown key |
| `forbidden` | 403 | visible object, action not allowed for this caller (incl. ADR-005 §3 rights, ADR-011 group assignment) |
| `not_found` | 404 | missing **or invisible** object (non-disclosure) |
| `conflict` | 409 | duplicate entity name |
| `invalid_transition` | 422 | edge not in ADR-003 §1 |
| `permission_denied` | 422 | requester lacks the category grant at `createTask` (ADR-009 §2(a), fail closed) |
| `invalid_input` | 400 | malformed input |
| `limit_exceeded` | 413 / 429 | payload, depth, hop, budget, rate limits |

**Non-disclosure rule:** anything the caller isn't allowed to see returns `not_found`, never `forbidden`. That covers other workspaces' entities, conversations the caller isn't in, and tasks the caller isn't a party to. `forbidden` is only for objects the caller can see but may not act on in that way.

## 6. What Entity 1 must provide for the security gate

1. A `CoreApi` + `AdminApi` implementation (an adapter over the SQLite core of ADR-002 is fine).
2. A factory the test harness can call: `makeCore({ now }) → CoreApi & AdminApi`. The injectable clock is needed for the budget tests.
3. Passing `test/adversarial.test.ts` and `test/mcp-tools.test.ts` with that factory in place of `ReferenceCore`. See SECURITY.md §6.

## 7. Open points for Mow

- ~~`getTask` is in the core API but has no MCP tool (§2 doesn't list one). Requesters currently learn task state only through `check_inbox`. ADR-P5 proposes adding a `get_task` tool.~~ **Settled by ADR-010** and built: `get_task` is party-only and non-disclosing (ADV-32).
- ~~No `listPendingApprovals` on `AdminApi` yet. The UI (WP-E1-04) will need one, so Entity 1 should define it.~~ **Settled by ADR-005 §4:** `GET /v1/approvals?state=pending` on Entity 1's API.
- *(Added at rebase, 2026-10-01.)* ADR-003 §2 lists `POST /v1/tasks/:id/approve` and `/reject` under entity-key auth, with "the human UI is trusted locally". The security gate requires these to be unreachable with any entity key (SECURITY.md ADV-30, G6). Otherwise an agent could approve its own or a peer's paused task. ~~Mow should confirm they're human-only.~~ **Settled by ADR-005 §1:** approve/reject are human-only and refuse any entity API key with 403 (amends ADR-003 §2).
- ~~Group semantics beyond membership aren't specified, for example whether only the orchestrator may assign tasks inside a group. The reference core lets any member assign. ADR-P6 proposes orchestrator-only assignment within groups, as an option chosen per group.~~ **Settled by ADR-011** and built: per-group `assignment`, default `orchestrator_only` with an orchestrator, else `any_member` (ADV-33).
