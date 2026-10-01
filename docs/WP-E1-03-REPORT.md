# WP-E1-03 acceptance report

Contract: ADR-002/003/004 at `c06c582`. Feature branch: `feat/wp-e1-03`, stacked
on accepted WP-E1-02 (`b03fb60`). No architecture edits or external services.

## Delivered

- Migration 003 adds canonical rule JSON, source ownership and read grants,
  task permission targets, approval attempt scopes, and checked context records.
- Fail-closed permission evaluator follows ADR-004 precedence. Authenticated
  local helpers configure ask, standing-rule, and full-access modes.
- Task creation and worker dispatch check every recipient. Denied requests keep
  their reason and audit trail; asks pause before any webhook is sent.
- Frozen approve/reject routes enforce admin/owner identity. Approval resumes;
  rejection cancels durably. Manual retries need fresh approval; transport
  retries reuse the same decision and idempotency key.
- Context packages include goal, explicitly shared facts, same-conversation
  history, authorized source IDs, constraints, and expected output.
- Source owners derive from authenticated identities. Only owners/admins grant;
  chat cannot change ownership. Full access and approval never bypass source ACLs.

## Acceptance proof

`npm test`: **19 passed, 0 failed** on Windows, Node 22.22.3, SQLite 3.51.3.
Raw output: `evidence/sqlite/wp-e1-03-acceptance.txt`.

| Acceptance criterion | Executed proof |
| --- | --- |
| Unauthorized request blocked with reason | With no matching rule, create returns 403, stores `no_matching_rule`, retains cancelled state and denial audit, and creates zero jobs. Replaying the same request remains denied. |
| Approval pauses execution | Real loopback API/worker test reaches awaiting_approval with **zero webhook POSTs and zero persisted context packages**. Human approve resumes; the next worker poll delivers. |
| Rejection blocks action | Entity and member approvals return 403. Human rejection cancels, records approval_rejected, survives database reopen, and sends zero POSTs. Later approval returns 409. |
| X requests Y's private document | X and Y share a group; Y owns a private source. X's request is denied even under full-access mode. A malicious chat instruction changes neither ownership nor grants. |
| Per-recipient context | Granting only one of two recipients rejects the whole task before dispatch. Granting both allows two checked packages; forged history and another group's messages are absent. |
| Precedence and modes | Exercises explicit deny, specificity, ask dominance, priority, ties, missing/malformed rules, all three modes, and denied entity self-configuration. Each evaluation's audit decision/reason is checked. |
| Approval cannot outlive access | Revoked source grant blocks approval with a durable denial audit. A deny added after approval blocks dispatch. Changed rule selection returns stale approval; a new attempt asks again. |
| Existing packages regress cleanly | SQLite migration/seed/access checks, all task transition pairs, real process kill/restart with one committed recipient effect, API cancellation, delivery retries, and fast result callback all pass. |

Network traffic is loopback only. Tests use real HTTP servers and SQLite files;
they do not use a live AI provider or private document storage service. The
private-document test exercises registered source metadata and access controls.

## Boundaries and implementation notes

There are no rule/source-management HTTP endpoints in the frozen contract. Local
authenticated configuration helpers supply these operations; no new public route
was added. Ask/full modes expand into canonical rules and use the same evaluator.
Explicit task input maps the existing resource/action and context fields; default
task execution targets its own ID. Approval fingerprints bind current permission
decisions and context input to a task attempt; they are internal implementation.

Source content retrieval is not specified by ADR-004's metadata model and is not
claimed here. History is a bounded conversation slice, not semantic retrieval.
The seed intentionally grants no execution permissions. Test fixtures explicitly
configure modes. Capability verification, budgets, and security sign-off remain
Entity 2's work; this is not full prototype exit-criteria sign-off.

## Next package: contract boundary

WP-E1-04 is not started. Its human dashboard must watch tasks and approval requests
created by any connected entity, including after page reload. ADR-003 freezes
single-task reads and an entity-only inbox but no human task/approval enumeration.
Mow must freeze how the human UI discovers those task IDs: a listing route or a
specified field in an existing response. Conversation creation/member/orchestrator
and message/task-result payload shapes should be recorded alongside that decision
so Entity 1 and Entity 2 share the same interface. No UI-specific API is invented.

## Publication

The human will push `feat/wp-e1-03` using their terminal credentials, then open a
PR against `feat/wp-e1-02` while that branch is unmerged (otherwise main, after
integrating its reviewed changes). This report claims no push, created PR, or
GitHub CI run. WP-E1-01 remains closed; WP-E1-02 remains accepted pending review.
