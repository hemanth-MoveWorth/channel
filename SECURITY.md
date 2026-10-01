# SignalDesk Channel: Security (WP-E2-03)

Owner: Entity 2 (protocol + security gate). Contract: ARCHITECTURE.md v0.1 §2.7–§2.10.
**The prototype is not "working" until §9 reads SIGNED OFF for the whole prototype.**

## 1. Scope and status

| Area | Built by | State |
|---|---|---|
| MCP server: tools, stdio + streamable HTTP | Entity 2 | built, tested |
| Agent Card schema, A2A mapping | Entity 2 | built, tested |
| Edge controls: identity binding, schemas, envelope, rate limit, transport guards | Entity 2 | built, tested |
| Reference core (in-memory spec of core-side controls) | Entity 2 | built, tested. It's a test double, not production. |
| Real core: schema, tasks, workers, permission engine, context packages, UI | Entity 1 | **not delivered yet**. Gates G1, G3–G6. |

## 2. Trust boundary and prompt-injection defence

```
            TRUSTED                                   │            UNTRUSTED (DATA)
──────────────────────────────────────────────────────┼─────────────────────────────────────────
 Human via authenticated UI  → AdminApi                │  Anything another AI entity authored:
   (grants, skill verification, approvals, stop)       │   message text/data, task goal/constraints/
 Core execution path: permission engine, state         │   input, artifacts, agent cards, display
   machine, limits, audit (decides every action)       │   names, group/member names
 SignalDesk-generated metadata (ids, states, receipts) │  The *intent* behind any tool call an
 The caller's identity (from its API key)              │   entity makes. Checked, never assumed.
```

**Where the line sits:** at the core's execution path. An authenticated tool call is a *request*. The core decides it using only trusted inputs: the caller identity bound to the key, human-set grants and policies, and the task state. Nothing an entity *writes* is ever an input to that decision.

Defence layers, from strongest to weakest:

1. **L0: authorisation in the execution path, never by the LLM (§2.8).** No content can change permissions, approvals, identity or task state. If the receiving model is fully hijacked, it can still only make tool calls its own key allows. It can't approve (there is no tool for that), can't act as someone else, can't read conversations it isn't in, and can't escalate category grants. *Tests: ADV-08, -09, -10, -12, -13, -14.*
2. **L1: identity is bound at authentication.** Core sessions have no `caller` argument. MCP tool schemas are closed, so there's no `from` field to spoof. HTTP sessions are pinned to the entity that opened them. *ADV-02, ADV-27.*
3. **L2: the data envelope.** Every peer-authored string sent back to a model is wrapped in `<peer_content nonce=…>` with a fresh 64-bit random nonce per response. It's labelled with sender id, name and verification status, and preceded by a fixed trust notice. Peer text that imitates the envelope markers is defanged (`<peer_content` → `‹peer_content`). The same notice is in the MCP server `instructions`. *ADV-11.*
4. **L3: sanitisation.** Tag characters (U+E0000–E007F, "ASCII smuggling"), bidi overrides and isolates, BOM and C0/C1 controls are stripped from peer text, and the count is reported. Display names with control or markup characters, reserved roles, or duplicates are refused. *ADV-04, ADV-11.*

**L2 and L3 reduce how often a model obeys injected text. They don't guarantee it won't. L0 and L1 are the controls.** Every adversarial test assumes the recipient model *does* obey the injection (ADV-12), and the test checks that nothing unauthorised happens anyway.

## 3. Identity, keys and capability verification

### 3.1 Keys and transports
- **One key per entity** (§2.9). It's a 256-bit random secret (`sdk_` + 43 base64url characters) shown once when the human creates the entity. Only its SHA-256 digest is stored (*ADV-03*). Rotation through `AdminApi.revokeKey` invalidates the old key immediately (*ADV-01*).
- Secrets are redacted (`sdk_[REDACTED]`) from every error and log line. Internal errors return a generic message.
- **stdio:** the key comes from the `SIGNALDESK_API_KEY` env var of the spawned process. The server refuses to start without a valid key. Nothing but MCP traffic is written to stdout.
- **Streamable HTTP:** `Authorization: Bearer` is required on **every** request, not just `initialize`. A session id presented with a different key gets 403, and without any key gets 401 (*ADV-26, -27*). Host and Origin headers are allow-listed against DNS rebinding (*ADV-28*). The server binds to 127.0.0.1. Bodies are capped at 1 MiB (*ADV-29*).
- **Human operations** (`AdminApi`) are never reachable with an entity key (*ADV-30*). The dev hub uses a separate admin token. Production uses an authenticated human session (G6).
- The dev `/core/rpc` exposes only `CoreSession` methods, allow-listed by name (*ADV-31*).

### 3.2 Capability verification flow (self-claim ≠ grant, §2.7)

```
human creates entity ─► key issued, grants = {research}, policy = ask_every_time, profile = unregistered
entity calls register_profile ─► card validated (schema: unknown fields rejected) ─► skills stored as CLAIMS
                                  profileStatus = pending_verification, every skill verified=false
human reviews in UI ─► AdminApi.verifySkill(skill)   (stores a digest of the skill definition)
                     ─► AdminApi.grantCategories(...) (what this entity may ask others to do)
                     ─► AdminApi.setApprovalMode(...) (what others may ask of this entity, and whether approval is needed)
entity edits a verified skill ─► digest no longer matches ─► verified=false again
```

- Two separate questions are answered by humans only:
  1. *May this entity request category X?* That's the requester's grants.
  2. *May others make this entity do X, and does it need approval?* That's the assignee's policy.

  Both must allow a request (*ADV-08, -09*).
- A card can't carry grants: `verifiedPermissions`, `grantedCategories` and `skills[].verified` are rejected by the schema, and the MCP tool refuses them too (*ADV-05, -06*). Claimed skills are shown to peers as `verified: false` (*ADV-07*).
- **Under-declared categories.** Requesters choose the category, and a liar might label "run a command" as `research`. The assignee can `reclassify` the task upward only. That re-runs both checks, and the task fails closed or pauses for approval (*ADV-10*). This is a judgement control and depends on the assignee. See R2.

## 4. Runaway-work limits (§2.9)

Defined in [`src/security/limits.ts`](packages/mcp-server/src/security/limits.ts). The core enforces them; the edge also validates them.

| Limit | Value | Behaviour | Test |
|---|---|---|---|
| Delegation depth | 3 below the root | `limit_exceeded`. Only the assignee of a `working` parent may delegate. Delegating to anyone already in the chain is refused. | ADV-21 |
| Hops per task | default 24, ceiling 100 | Task → `awaiting_approval` (`hop_limit_reached`). Further messages refused until a human approves, which resets the counter. | ADV-19 |
| Turns without progress | 10 | Same pause (`no_progress_limit_reached`). Catches polite ping-pong under a large hop budget. | ADV-20 |
| Runtime | default 15 min, ceiling 24 h | Checked on every access. Task → `failed` (`budget_runtime_exceeded`), descendants cancelled. A child's budget is capped at the parent's remaining time. | ADV-22 |
| Cost | ceiling $25 | Only enforceable for SignalDesk-hosted LLMs (built-in orchestrator, type C proxies). See R4. | (G4 / WP-E1-02) |
| Stop button | n/a | `AdminApi.stopTask` cancels the whole task tree | ADV-23 |
| Rate | 120 calls/min per entity | Keyed by entity, not session, so extra sessions don't buy throughput | ADV-24 |
| Payloads | text 16k chars, data 64 KiB, 10 parts, goal 4k | Checked at the edge and again in the core | ADV-25 |

## 5. Threats → controls → tests

All in `packages/mcp-server/test/`. Each one simulates the attack end to end.

| ID | Attack | Control | Result |
|---|---|---|---|
| ADV-01 | Forged, empty, huge, or revoked key | digest lookup, size cap, rotation | blocked |
| ADV-02 | Spoof sender via `from` argument | closed schemas; identity from key | blocked |
| ADV-03 | Read keys from storage | digest-only storage | blocked |
| ADV-04 | Impersonating display names | name validator + uniqueness | blocked |
| ADV-05/06 | Self-granted permissions in agent card | strict schema; grants outside the card | blocked |
| ADV-07 | Bait-and-switch a verified skill | digest-pinned verification | blocked |
| ADV-08 | Request an ungranted category | requester grant check + audit | blocked |
| ADV-09 | Bypass assignee's deny rule | assignee policy check | blocked |
| ADV-10 | Under-declare category to dodge approval | upward-only reclassify, fail closed | blocked |
| ADV-11 | Injection payload incl. forged envelope closer + invisible chars | envelope + nonce + defang + strip | contained |
| ADV-12 | Hijacked recipient tries to complete or approve paused work | state machine; no approve tool | blocked |
| ADV-13 | Requester self-completes or self-accepts | role checks | blocked |
| ADV-14 | Third party touches someone else's task | party check, non-disclosure | blocked |
| ADV-15 | Read a conversation you're not in | membership check; `not_found` same as nonexistent | blocked |
| ADV-16 | Confused deputy: attach others' data to a task | requester must access every source ref | blocked |
| ADV-17 | Harvest webhook URLs, grants, key digests from profiles | public profile projection | blocked |
| ADV-18 | Cross-workspace discovery and messaging | workspace isolation | blocked |
| ADV-19/20 | Infinite chatter | hop + no-progress limits | paused |
| ADV-21 | Unbounded or cyclic delegation | depth cap, cycle check, assignee-only delegation | blocked |
| ADV-22 | Runaway runtime, child outliving parent | deadline enforcement, budget inheritance | failed/cancelled |
| ADV-23 | Runaway task tree | stop button cascade | cancelled |
| ADV-24 | Request flooding | per-entity token bucket | throttled |
| ADV-25 | Oversized or malformed payloads | edge + core validation | blocked |
| ADV-26 | Anonymous HTTP | bearer on every request | 401 |
| ADV-27 | Session hijack with a stolen session id | session pinned to entity | 403/401 |
| ADV-28 | DNS rebinding from a browser | Host/Origin allow-list | 403 |
| ADV-29 | Huge request body | 1 MiB cap | 413 |
| ADV-30 | Entity key used on admin endpoints | separate human credential | 401 |
| ADV-31 | Call non-session methods over core RPC | method allow-list | 400 |

**Checking the tests themselves:** three controls were removed on purpose (session binding, envelope defang, source-ref check). Each removal made exactly its matching test fail (ADV-27, ADV-11, ADV-16), so the tests detect real regressions and don't pass vacuously.

## 6. Running the gate

```bash
cd packages/mcp-server && npm install && npm run typecheck && npm test
```

To gate **Entity 1's core**: implement a `makeCore({ now })` that returns `CoreApi & AdminApi` over the real database. Then point `world()` in `test/helpers.ts` at it in place of `ReferenceCore`, and run `npm test`. All of `mcp-tools.test.ts` and `adversarial.test.ts` must pass unchanged. A test may be changed only through an ADR that Entity 2 has reviewed.

## 7. Checklist

Legend: ☑ done and tested · ☐ open (owner)

**Prompt injection and trust boundary**
- ☑ Peer content enveloped as data with a per-response nonce. Markers defanged. Invisible and bidi characters stripped.
- ☑ Trust notice in server `instructions` and in every tool result containing peer content
- ☑ No tool can approve, grant, verify, or change identity
- ☑ All authorisation decisions made from trusted inputs only (reference core)
- ☐ Same property in Entity 1's permission engine and context-package assembler (Entity 1, G1/G5)

**Identity and authentication**
- ☑ One key per entity, 256-bit, digest-only storage, rotation
- ☑ Identity bound at authentication. No `caller` parameter anywhere in the core API.
- ☑ HTTP: bearer on every request, session pinned to entity, Host/Origin allow-list, localhost bind, body cap
- ☑ Secrets redacted from errors and logs
- ☐ OAuth 2.1 (MCP authorization spec) for any non-localhost exposure (Entity 2, G2)
- ☐ Human UI auth for every AdminApi operation: an app-layer human session in the prototype (ADR-002), Supabase Auth only once it enters (ADR-001 §1). Entity keys refused. (Entity 1, G6)

**Capability verification**
- ☑ Strict Agent Card schema. Self-granting fields rejected.
- ☑ Skills unverified until a human verifies them. Edits drop verification.
- ☑ Requester grant AND assignee policy must both allow. Deny is final. Ask pauses.
- ☑ Upward-only reclassify, fail closed

**Limits**
- ☑ Delegation depth cap, cycle check, assignee-only delegation
- ☑ Hop limit + no-progress limit → pause for human
- ☑ Runtime budget, child ≤ parent, ceilings
- ☑ Stop button cascades
- ☑ Per-entity rate limit, payload caps (edge + core)
- ☐ Cost budget metering for hosted LLM calls (Entity 1, WP-E1-02)

**Data access**
- ☑ Workspace isolation. Non-disclosure (`not_found`) for invisible objects.
- ☑ Conversation membership required for read and write
- ☑ Anti confused-deputy check on source refs
- ☑ Public profile excludes webhook URL, owner data, grants, key material
- ☐ These rules are written as policy specs in `db/policies.md` and enforced by the application layer over the SQLite core, with tests proving it (ADR-002 §3). Only the core process opens the SQLite file (`SIGNALDESK_DB_PATH`). The MCP layer and entities never get direct database access. Real RLS comes later, when Supabase enters. (Entity 1, G1)

**Delivery and side effects**
- ☑ Idempotency keys on `send_message` / `create_task` (reference core, in-memory)
- ☐ Durable idempotency + exactly-once side effects across worker restarts (Entity 1, G4)
- ☐ Webhook signing (HMAC-SHA256, timestamp, 5-min replay window) + SSRF guard on `webhook_url` (https only, no private/link-local ranges outside dev) (Entity 1 builds, Entity 2 reviews, G3)
- ☐ Append-only audit log (no UPDATE/DELETE for the app role) (Entity 1, G6)

## 8. Residual risks (accepted for the prototype, revisit before SaaS)

- **R1. A hijacked model can still misuse its *own* environment.** SignalDesk controls what happens *through SignalDesk*. A type B client (Claude Code, Cursor) that reads a malicious message could be persuaded to run a local command or edit a file. That's governed by that client's own permission prompts, not by SignalDesk. Users should keep client-side approval prompts on for SignalDesk-connected sessions.
- **R2. Category honesty.** The requester declares the category, and reclassification depends on the assignee noticing. Possible later mitigation: an independent classifier on the assignee side. It would be advisory only and still not a control.
- **R3. Voluntary disclosure.** An assignee can put anything its own context holds into a reply. SignalDesk can't classify free text. `read_context` requests default to *ask*, which is the mitigation.
- **R4. Cost budgets for external agents** can't be metered. Only runtime, hops and depth apply to them.
- **R5. Rate-limit and session state are per process** (in-memory). Horizontal scaling needs a shared store.
- **R6. Keys on client disks.** `.mcp.json` stores the key in plain text, so `.mcp.json` is git-ignored. Rotate on suspicion.
- **R7. Supply chain.** The dependency tree comes from the lockfile. `npm audit` reported 0 vulnerabilities on 2026-10-01. Re-run in CI.

## 9. Sign-off

> **Entity 2 security sign-off, 2026-10-01**
>
> **Reviewed:** WP-E2-01 MCP server (stdio + streamable HTTP), WP-E2-02 Agent Card schema and A2A mapping, edge controls, and the reference core's core-side controls. Evidence: `npm test`, with 50 of 50 tests passing, including 31 adversarial tests (ADV-01 to ADV-31), and mutation spot-checks per §5.
>
> **Verdict:**
> 1. **Protocol + MCP layer: PASS.** Approved for local prototype testing on **localhost only**, with one key per client.
> 2. **SignalDesk Channel prototype as a whole: NOT SIGNED OFF.** Per ARCHITECTURE §4 the prototype isn't "working" yet. The core it must run against doesn't exist. Blocking gates:
>    - **G1:** Entity 1's core passes `mcp-tools.test.ts` + `adversarial.test.ts` through the `CoreApi` factory, and the application layer enforces the `db/policies.md` specs (ADR-002 §3) covering §7 "Data access".
>    - **G3:** Webhook signing + SSRF guard for type A delivery, reviewed by Entity 2
>    - **G4:** Exactly-once side effects across worker restart (WP-E1-02 acceptance), reviewed by Entity 2
>    - **G5:** The context-package assembler enforces per-recipient clearance, and a crafted Entity X → Entity Y private-doc test is denied (WP-E1-03 acceptance)
>    - **G6:** AdminApi is reachable only through an authenticated human session, and the audit log is append-only
>    - **G2** (blocks exposure beyond localhost, e.g. tunnels or ChatGPT connectors): OAuth 2.1 for remote MCP
>
> Re-review starts as soon as Entity 1 delivers. Each gate closes with a dated entry below.
>
> — Entity 2 (protocol + security)

### Gate log
- 2026-10-01: E2 layer PASS (localhost). G1–G6 open.
