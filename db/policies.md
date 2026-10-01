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
| Change task state | Through task service only | Assigned entity only, through task service |
| Permission rules | Admin/owner manage | No self-grants |
| Approval | Members read; admin/owner decide | Cannot approve own work |
| Audit | Members read; service appends | No direct write/edit/delete |
| Credential hashes | Internal authentication code only | Never in API profiles/chat/logs |
| Context | No raw context grant through directory access | WP-E1-03 must filter each source per recipient |

JWT login is superseded for Phase 0: ADR-003 trusts the local human UI. Bearer
keys map through a hash to an existing entity. Revoked keys fail authentication.
The loopback HTTP adapter must derive the local human identity itself, never from
a caller's `user_id`. The default demo is the sole local human workspace; other
identities are used in tests to prove policy boundaries.

WP-E1-01 implements the identity checks and a checked directory read, including
an audit row for rejected requests. This is not WP-E1-03's permission-rule
evaluation, approval execution or context source authorization. No unfiltered
context or credential read is exposed. Adding an endpoint must call authorization
before reading data or mutating it. Unknown actions are denied.
