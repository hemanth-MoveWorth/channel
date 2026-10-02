# E1 review follow-ups — 2026-10-02

Decision: **adopt ADR-009**, without replacing or mapping away ADR-004. Category
authorization and resource authorization answer different questions; both apply.
ADR-008's exact closed TaskReason enum is enforced in the same batch.

The accepted ADR text was found on `origin/e2/protocol-security` at `d75e77e`;
origin/main still stopped at ADR-005. ARCHITECTURE.md is copied verbatim from that
accepted source. No new architecture amendment is proposed or silently adopted.

## Static-asset fix

The server reads the asset before writeHead(200). Missing assets therefore reach
the existing generic 500 JSON handler before any headers are committed. Regression
test starts the real HTTP server with an empty asset directory, requires a complete
500 JSON response within 3 seconds, then successfully calls the entity endpoint.
No missing-file exception escapes the request handler or hangs the connection.

## Category model

Exact increasing order: research < read_context < tool_use < write < send_external
< publish. Category is required in POST /v1/tasks and returned in task reads.
The engine does not infer risk from goal text, capabilities, or resource/action.

| Boundary | Enforcement |
| --- | --- |
| Creation | Authenticated requester entity needs that exact category in its human-set grants. Missing grant returns 422 with durable denial audit and no task/job. A grant to a higher category does not imply lower-category grants. |
| Human creation | The existing trusted workspace human directly requests the category. No entity grant is inferred or modified. Assignee and resource checks still apply. |
| Acceptance | API queued → working and the worker use one shared execution gate. Each recipient's category policy must allow/ask; deny yields working → failed / permission_denied. |
| Ask | working → awaiting_approval / policy_requires_approval; no webhook or context package before approval. |
| Reclassification | Only the assigned entity, from working, may move strictly upward. Both category checks and resource/source checks run again; deny fails, ask pauses. |
| Approval and dispatch | Grant/policy/resource changes are checked again. The approval fingerprint includes category, attempt and current decisions. Earlier approval cannot authorize a new category. |
| Resource coexistence | ADR-004 deny or missing private-source access still blocks a category-allowed task. Category allow/full access never creates a source grant. |

Migration 005 adds entity category_grants/category_policy with database defaults
`["research"]` and `{"kind":"ask_every_time"}`. Human-set standing policy maps
categories to allow/ask/deny; omitted categories deny. Full-access category mode
allows categories on the execution side; it never expands requester grants.

Local authenticated admin helpers in src/categories.mjs:

```js
grantCategories(db, humanActor, workspaceId, entityId, ['research', 'publish']);
setApprovalMode(db, humanActor, workspaceId, entityId, {
  kind: 'standing_rules', rules: { research: 'allow', publish: 'ask' }
});
```

Both require workspace admin/owner authorization, so entity callers cannot grant
categories or alter policy. Existing setPermissionMode/addRule configure ADR-004
resources separately. Production seed does not add resource grants automatically.

Adapter handoff: `reclassifyTask(db, authenticatedActor, taskId, category)` in
src/tasks.mjs supplies ADR-007's internal updateTask/reclassify operation. Tests
call the real SQLite engine, not E2's reference implementation. This batch does
not invent a REST reclassify endpoint or extend the frozen transition body;
binding E2's remote adapter to this operation remains integration work through Mow.
This report does not claim a full CoreApi adapter, type B delivery, or G1 closure.

## Task reasons

Exact accepted reasons:

```text
rejected_by_assignee
approval_rejected
permission_denied
assignee_reported_failure
policy_requires_approval
hop_limit_reached
no_progress_limit_reached
budget_runtime_exceeded
stopped_by_user
parent_cancelled
```

No other string is accepted, including the superseded reference-core values
reclassified_needs_approval and external_auth_required. Missing/null reason is
allowed for normal transitions (queue, accept, complete, approved resume). Engine
transitions, HTTP input, current task reason and new transition event reasons use
the closed set; SQLite also CHECKs the current reason. Audit decision reason codes
such as no_matching_rule remain separate from TaskReason.

The UI Stop control uses stopped_by_user (or approval rejection while paused).
Assignee queued → cancelled with rejected_by_assignee is explicitly tested.
Detailed permission diagnostics remain in blocked_reason/audit; the TaskReason
is permission_denied, never a free-form permission_denied:<detail> string.

## Upgrade behavior

Migrations 001–004 are unchanged. Migration 005 is exercised against a database
built from those four approved migrations, then applied twice to check ledger
idempotence and foreign keys. Existing entities gain the conservative defaults.
Historical tasks keep category=null, because their original requests declared none.
They fail closed at acceptance/dispatch; create a fresh categorized task to retry.
Completed records remain readable. Historical audit/event records are not rewritten.
New request hashes include category, so changing it cannot replay another request.

## Evidence

`npm test`: **31 passed, 0 failed** on Node 22.22.3 / SQLite 3.51.3 / Windows.
The original 23 tests still run; fixtures explicitly configure category policy and
use canonical reasons, preserving their original acceptance assertions. Eight
new tests in tests/reconciliation.test.mjs prove:

1. Four-migration upgrade and fail-closed legacy tasks.
2. Missing asset response completeness and server survival.
3. Bootstrap defaults, required category, denied requester grants, and rejected
   entity self-configuration/spoofed grant fields.
4. Assignee deny/ask at acceptance and approved resume.
5. All 36 ordered category pairs, plus actor/state restrictions on reclassify.
6. Reclassification reruns both sides and needs fresh category approval.
7. Revoked requester grants, changed assignee policy and ADR-004 denies prevent
   dispatch, with zero calls to a real loopback HTTP recipient.
8. Exact TaskReason enum, invalid HTTP reasons rejected without state mutation,
   valid assignee decline persisted in task/event records, and database CHECK.

`node --check web/app.js` also passes. The earlier browser acceptance remains
historical evidence; this follow-up's category UI was not claimed browser-tested.
No external services were used. G3 webhook signing remains open as requested;
no broader security-gate sign-off is claimed. ADR-006/007/010/011 integration is
not silently bundled into this targeted ADR-008/009 reconciliation.
