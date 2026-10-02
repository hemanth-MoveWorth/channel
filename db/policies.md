# ADR-001 policies under ADR-002

SQLite has no RLS. Only the local application opens the file; possession of the
file grants database access. `src/access.mjs` enforces the identity boundary in
application code. Supabase Auth and PostgreSQL policies are supplementary evidence
under `evidence/postgres/`, not active prototype dependencies.

| Action | Human application policy | Entity application policy |
| --- | --- | --- |
| Read profiles | Workspace member | Entity's own workspace |
| Create/update entity | Workspace admin/owner | No self-granted verified permissions |
| Delete entity | Workspace owner | Denied |
| Conversations/messages | Workspace members read/write | Conversation membership required |
| Create tasks | Workspace member | Own workspace and conversation membership |
| Change task state | Through task service only | Assigned entity; requester may cancel or resume input_required under ADR-005 |
| Permission rules | Admin/owner manage | No self-grants |
| Approval | Members read; admin/owner decide | Cannot approve own work |
| Audit | Members read; service appends | No direct write/edit/delete |
| Credential hashes | Internal authentication code only | Never in API profiles/chat/logs |
| Context | No raw context grant through directory access | Each source checked per recipient before delivery |

JWT login is superseded for Phase 0: ADR-003 trusts the local human UI. Bearer
keys map through a hash to an existing entity. Revoked keys fail authentication.
The loopback HTTP adapter must derive the local human identity itself, never from
a caller's `user_id`. The default demo is the sole local human workspace; other
identities are used in tests to prove policy boundaries.

WP-E1-01 implements identity checks and a checked directory read. WP-E1-03 adds
ADR-004 permission evaluation, human approval decisions, and source checks in
the execution path. Source registration derives the owner from the actor; only
that owner or a workspace admin may grant read access. Group membership never
creates a source grant. Full access and human approval cannot override a deny or
missing private-source access. Decisions append audit records, including denied
requests. No unfiltered context or credential read is exposed. Adding an endpoint
must call authorization before reading data or mutating it. Unknown actions deny.

ADR-005 dashboard task/approval lists are for authorized humans. Entity conversation
and message reads are membership-scoped; results are attributed from bearer identity,
never the supplied sender field. Task-linked messages must match the conversation.
Requester input is a task-linked chat message followed by input_required → working;
this never permits approval or completion of another entity's assigned task.

ADR-009 adds an independent category layer: a requester entity needs an exact
human-set category grant at creation (422 otherwise); each execution recipient's
category policy is checked at acceptance and before dispatch. A trusted human
request authorizes its requested category but does not change entity grants.
Only human admins/owners configure grants and category policy. Reclassification
requires the assigned entity, working state, and strictly increasing category risk;
it reruns requester grants, recipient policy and the existing resource/source checks.
