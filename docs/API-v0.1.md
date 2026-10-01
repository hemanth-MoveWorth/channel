# ADR-003 task API implementation

The API uses `/v1`, JSON, and `{data}` / `{error:{code,message}}`. This package
implements task creation/read/transition/approval and read-only entity discovery. Other
frozen routes remain assigned to later packages; no replacement routes are added.

All HTTP traffic in Phase 0 is loopback. The server binds to `127.0.0.1:3000` and
validates Host, Origin, JSON content type and body size. No bearer header means
the trusted local demo human (ADR-003); a supplied bearer key must resolve to an
existing, unrevoked entity. A bad key never falls back to human access. Processes
on the local machine are therefore inside the prototype's human trust boundary;
this is not public/SaaS authentication.

## Task creation

`POST /v1/tasks`, optional `Idempotency-Key` header:

```json
{
  "workspace_id": "10000000-0000-4000-8000-000000000001",
  "conversation_id": "30000000-0000-4000-8000-000000000001",
  "assigned_entity_id": "20000000-0000-4000-8000-000000000001",
  "recipient_entity_ids": ["20000000-0000-4000-8000-000000000001"],
  "goal": "Perform a local task"
}
```

The workspace/conversation/goal and recipient IDs map to the task schema. If the
recipient list is omitted, the assigned entity is the sole recipient. If the
assigned entity is omitted, the first sorted distinct recipient is assigned. All
recipients must belong to this conversation. The assigned entity owns task-state
callbacks; other recipients may contribute through the later message service.

Creation checks all recipients, records submitted, transitions allowed/ask work
to queued, and persists one job per distinct recipient. Denied requests return
403 with a reason and retain a cancelled task and audit trail without jobs.
New permitted requests return 201; a matching replay returns
200 with the same task. Reusing the workspace-scoped key for a different actor or
payload returns 409. Without a header, the server generates a key, so callers
requiring retry deduplication must supply one. No client-supplied state, identity,
verified permission, caller-supplied history, or execution result is accepted at creation.

## State and stop

`GET /v1/tasks/:id` returns the task, including state, attempt and delivery receipt.
`POST /v1/tasks/:id/transition` accepts exactly the documented state and reason:

```json
{"to_state":"cancelled","reason":"user_stop"}
```

The human acts within their workspace; an entity can mutate only its assigned
task. Illegal transitions return 422 without mutating state or appending a false
transition event. Every successful state transition and creation is recorded.
`failed -> queued` is interpreted as ADR-003's explicit human-only manual-retry
exception to its terminal-state wording. It increments the attempt and creates
a new delivery-key scope. Automatic transport retries keep the existing attempt.

Generic transition requests cannot approve work, even if they include an extra
`approvalDecision` field. Use `POST /v1/tasks/:id/approve` or `/reject` with `{}`.
Only a workspace admin/owner human may decide. Approval rechecks current rules
and source access, resumes working, and scopes the decision to this task attempt.
Rejection cancels with `approval_rejected`; repeated identical decisions are
idempotent. Stale approvals return 409; newly denied access returns 403. Human
task reads include approval records; entity reads do not expose approval details.

## Delivery and failure recovery

The worker polls a durable SQLite `job_queue` and atomically leases jobs under
`BEGIN IMMEDIATE`. SQLite uses foreign keys, WAL and FULL synchronization. Leases
expire after process death; a replacement worker can reclaim the job. It checks
`deliveries` before sending. A logged delivered key completes the job without
sending another POST.

The key is `{task_id}:{attempt}:webhook:{recipient_entity_id}`. The JSON webhook
uses ADR-003's exact fields: `task_id`, `kind` (`task`), `context_package`,
`idempotency_key`, `reply_to`. The same key is also carried in the HTTP
`Idempotency-Key` header. An ACK must be HTTP 200 with `{accepted:true}`. Redirects,
invalid ACKs, network failures and timeouts retain the key and retry with backoff.
Only the normalized ACK is saved; provider responses and credential values are
never written to worker logs.

Once every recipient ACKs the current attempt, receipt changes are recorded in
order as `stored -> delivered -> accepted_for_execution`. Receipt means accepted
work, not task completion. A recipient may callback completion before its ACK;
the worker records delivery without reviving the completed task.

Default timings: 100 ms poll, 30 s lease, 5 s HTTP timeout, exponential backoff
from 250 ms capped at 30 s. Transport failures remain retryable until the task is
stopped or a later budget policy ends it. Runtime/cost/delegation budget policy is
not supplied by this package and remains required for prototype sign-off.

Task creation may supply `resource_type`, `resource_id`, and `action`; defaults
are this task's ID and `task/execute`. `context_package` accepts explicit `facts`,
`source_refs` (registered source IDs), `constraints`, and `expected_output`.
The server assembles the history slice from this conversation, with membership
and conversation-read permission checks. Every source needs recipient access and
read permission. No document-content fetching is implemented by these metadata
tables. See `PERMISSIONS.md` for the boundary and mode configuration.

## Effect guarantee and cancellation scope

After recipient success but before SignalDesk records ACK, retries may send the
same POST again. The recipient must atomically deduplicate the key with its side
effect (or recover the effect's existing result). The test recipient does this in
its own SQLite transaction. This demonstrates one committed effect despite two
deliveries, not universal exactly-once execution against arbitrary tools.

Cancellation atomically marks the task and queued/leased jobs cancelled. A
waiting HTTP request is aborted, and restart cannot deliver cancelled jobs.
An effect committed before cancellation cannot be recalled. The tests prove
zero sends for a pending cancelled task and no retry of an in-flight cancelled
task. External services, recipient APIs and live AI providers are not involved.
