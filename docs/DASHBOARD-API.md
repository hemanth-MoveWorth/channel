# ADR-005 dashboard implementation

All routes use the existing `/v1` and `{data}` / `{error:{code,message}}` envelope.
No bearer key is the trusted local demo human. Invalid keys never fall back to
human identity. The dashboard is served on the same loopback origin.

## Lists

- `GET /v1/tasks?status=&assignee=&requester=&limit=50&offset=0`: human workspace
  list. `data` is `{items,total,limit,offset}`. Limit is 1–100; offset is nonnegative.
  Ordering is descending created_at then ID. Filters combine with AND. Requester
  is requester_entity_id; assignee is assigned_entity_id. Items use the existing
  public task shape and omit raw context input and request hashes.
- `GET /v1/approvals?state=pending`: human workspace list. `data` is an array of
  approval records with `id,task_id,action,status,attempt,created_at,decided_at,goal`.
  Pending records must belong to the current awaiting_approval task attempt.
- `GET /v1/conversations`: workspace conversations for humans; member conversations
  for entities. Each returned item has ADR-005's conversation shape.
- `GET /v1/conversations/:id/messages`: messages ordered by created_at then ID,
  using ADR-005's message shape. Human workspace/entity membership checks apply.

Pagination parameter names/defaults and response metadata above are implementation
details of ADR-005's paginated endpoint, documented here for integration review.
The UI requests ten tasks per page and polls every two seconds.

## Conversation and message creation

`POST /v1/conversations` accepts `type,title,member_ids,orchestrator_entity_id?` and
optional `workspace_id` matching the authenticated workspace. The server generates
ID and created_at. Members are deduplicated and workspace-checked. An orchestrator
must be a listed type A member. The response is the frozen conversation shape.
Human workspace members may create conversations per ADR-001; entities cannot
self-enrol in a new conversation. No membership-edit route is added.

`POST /v1/conversations/:id/messages` accepts `body,kind?,parent_message_id?,task_id?`.
Kind defaults to chat. Server-generated ID/time and authenticated sender override
caller claims. Parent and task references must belong to the same conversation.
task_request/task_result messages require a task ID; an entity posting a result
must be its assigned entity. A task_request message does not create a task: use
POST /v1/tasks separately, preserving Message ≠ Task.

Results use task_result messages, then the existing completion transition. They
do not silently change task state. Chat and result content are rendered with text
nodes, never interpreted as HTML, instructions, or permission grants.

## ADR-005 task rights

Assigned entities retain their existing task controls. A requester entity may
cancel its task (including while awaiting approval), or resume input_required
after submitting clarification as a task-linked chat message. It cannot complete
another assignee's task. Requester cancellation records a task stop, not a human
approval decision. Both approve and reject endpoints reject every entity key.

The human Stop button uses reject for awaiting_approval, otherwise the cancelled
transition with user_stop. This preserves ADR-003's approval_rejected reason.
Result messages and current task state survive browser reload and process restart.

## Inbox and remaining integration

`GET /v1/inbox` requires an entity key. It returns pending assigned tasks and
messages from the entity's conversations as `{kind,ref_id,summary,created_at}`.
ADR-005 supplies no mention addressing syntax or read cursor; the implementation
does not invent these or claim read/unread tracking. It returns messages as
message items, without interpreting text as a mention command.

Entity registration/key provisioning, live MCP/A2A clients, capability verification,
autonomous orchestration, and security/budget sign-off are not supplied by this UI
package. Group creation persists the chosen orchestrator; it does not execute a
new orchestration algorithm. No source/rule-management HTTP routes were added.
