# WP-E1-02 acceptance report

Contract: ADR-002 and ADR-003 at `255139e`. Feature branch: `feat/wp-e1-02`, stacked
on SQLite WP-E1-01 (`feat/wp-e1-01`, `4381e84`). No architecture edits.

## Delivered

- Complete ADR-003 transition graph, event recording and human-only manual retry.
- Transactional task creation, recipient deduplication, scoped request replay
  protection and durable queue insertion.
- SQLite queue worker, atomic leases, exponential retry, persisted deliveries,
  stable keys per attempt, and ordered delivery receipt events.
- JSON task create/get/transition API, assigned-entity bearer authorization, local
  human controls and cancellation. Read-only entity discovery is also wired.
- Internal guarded approval transition hook for WP-E1-03; clients cannot fabricate
  approval decisions through the generic transition API.
- Task API contract notes and operational/dedup limitations in `docs/API-v0.1.md`.

## Acceptance proof

`npm test`: **9 tests passed, 0 failed**, including WP-E1-01 SQLite acceptance.
Node 22.22.3, SQLite 3.51.3, Windows. No npm runtime/test dependencies.

| Requirement | Executed evidence |
| --- | --- |
| SQLite acceptance | Fresh file, ordered migrations, idempotent seed, reopened persistence, rejected/audited application access; CLI default/configured paths also tested. |
| State machine + events | All 64 state pairs exercised. Legal edges record events; forbidden edges return 422 and change nothing. Approval bypass denied; failed retry requires a human and increments attempt. |
| Durable delivery | Separate worker OS process killed after a real loopback HTTP recipient committed its effect, before ACK. SQLite showed a pending delivery and leased job. A new process reclaimed it. |
| Exactly one effect on recovery | Recipient database contained **1 committed effect** after **2 HTTP deliveries with the identical key**. Recipient's effect and key are committed in one transaction. |
| Delivery log skip | Replaying a job after its ACK was durable made **no third HTTP request**. |
| Receipts | Event records show delivered followed by accepted_for_execution; invalid ACK leaves stored. |
| Cancellation/stop API | Pending task cancelled through HTTP had **0 sends**. In-flight cancellation had **1 send and 0 retries**, including a subsequent worker poll. |
| Multi-recipient dedup | Repeated recipient IDs generated one job per distinct entity; identical task request replay created no second task. |
| Concurrency/backoff | A second DB connection could not claim a live lease. Non-ACK retry used backoff and retained the same scope. |
| Fast callback | Assigned entity completed through the actual bearer-authenticated API before ACK; task stayed completed and receipt became accepted_for_execution. |

WP-E1-02's network traffic is exclusively loopback. WP-E1-01's schema/access test
uses no network calls. No Supabase, Render, Docker, or external account was used.

## Contract interpretation and remaining scope

ADR-003 labels failed terminal but explicitly allows manual retry; the specific
human retry edge is implemented as its exception. No other terminal edge exists.
No approval/context or private-source authorization is implied by the worker.
Read-only discovery and task routes are the implemented portion of API v0.1;
registration/chat/inbox and approval endpoints are not claimed complete here.

Effectively-once behavior requires the recipient to honor the stable key. A
sender-side log cannot deduplicate an arbitrary remote side effect across an ACK
loss by itself. Cancellation stops future work and cannot undo an already
committed recipient effect. Those boundaries are reflected in the tests.

Before WP-E1-03, Mow must specify the `permission_rules.rules` JSON structure,
precedence between workspace/entity rules, and the data model for private-source
ownership/grants. These are not present in ADR-001–003; defining them in code would
violate the spec-first instruction. WP-E1-03 and WP-E1-04 remain unstarted.

## Publication

The human will push both local branches using their own terminal credentials.
Open WP-E1-01 against main; while it is unmerged, open WP-E1-02 against
feat/wp-e1-01. No remote push, PR creation or GitHub CI run is claimed by this
report. The active CI workflow runs SQLite tests only.
