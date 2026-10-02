# WP-E1-01 database contract

Authority: `ARCHITECTURE.md` sections 2/3 and accepted ADR-001. This document describes
the delivered schema; it does not add architecture decisions or freeze the future REST API.

## Apply

Execute `supabase/migrations/20261001000100_core_schema.sql` once, as the migration
administrator, in a Supabase **development** project. Its Auth schema, `auth.uid()`
function, and `anon`, `authenticated`, and `service_role` roles must already exist.
The migration wraps itself in a transaction. No extension, queue, or provider is
installed by this package. The SQL also runs on plain PostgreSQL when those Auth
prerequisites exist. They are not supplied by the production migration.

## Seed

Create a real development user through Supabase Auth first. In the same SQL session,
set `signaldesk.seed_user_id` to that existing Auth user's UUID, then execute
`supabase/seed.sql` as the migration administrator:

```sql
select set_config('signaldesk.seed_user_id', '<existing-auth-user-uuid>', false);
```

The seed creates one development workspace, its owner membership, two type A demo
profiles, and one group with both entities. Research is the group's orchestrator.
Profiles are disconnected: no webhook, API key, or verified permission is seeded.
Re-running preserves existing rows; using a different owner for the fixed workspace
raises an error. Do not run the test Auth harness in a Supabase project.

## Tables readable by Entity 2 as source files

| Table | Purpose / important relationships |
| --- | --- |
| `users` | Human profile; primary key references `auth.users.id`. |
| `workspaces` | Tenant; owner references a human profile. |
| `workspace_members` | Human membership; composite key `(workspace_id, user_id)`; `owner/admin/member`. |
| `entities` | Workspace + owner membership; proposed capabilities array; service-owned verified permissions object; A/B/C connection type, webhook, availability, last check. |
| `entity_credentials` | Entity key hashes and revocation timestamp; at most one active hash per entity; active hashes unique across entities. |
| `conversations` | Workspace-owned `dm/group` conversation. |
| `conversation_members` | Entity membership; matching workspace enforced by FKs; one orchestrator maximum, type A only. |
| `messages` | Conversation + optional task; exactly one human or entity author; message body is data. |
| `tasks` | Workspace + conversation; exactly one human/entity requester; optional assigned entity; state, delivery receipt, goal, result, workspace-unique idempotency key. |
| `task_events` | Task event history, optional prior/next state and details. |
| `permission_rules` | Workspace/optional entity; three documented permission modes, JSON rules. Evaluation is WP-E1-03. |
| `approvals` | Task + proposed action; pending/approved/rejected; decision metadata. Execution resume is WP-E1-03. |
| `context_packages` | Task + recipient; goal, facts, history slice, source refs, constraints, expected output. |
| `audit_log` | Workspace + optional actor/task; decision and reason; append-only service ACL. |

Workspace-bearing child relations use composite foreign keys so a service-role
write also cannot attach an entity/task/conversation from a different tenant.
Enums are text `CHECK` constraints; this migration does not impose an invented
transition graph. Event recording and state changes belong to WP-E1-02.

## Human versus entity enforcement

All 14 tables enable RLS. `authenticated` uses `auth.uid()`; `anon` receives no
table grants. Helpers have a fixed empty search path, qualified table references,
and explicitly restricted execution privileges. Security-definer membership
lookups avoid recursive membership policies.

| Object | Human rights |
| --- | --- |
| Profiles, workspaces, human membership | Workspace-gated read. No client identity/membership provisioning grant is specified in ADR-001. |
| Entities | Workspace member read; admin/owner insert and update profile fields; owner delete. Verified permissions and health fields are service-owned. |
| Conversations + entity membership | Workspace member read/write, as prototype scope specifies. |
| Messages | Workspace member read/write; human inserts use their own JWT identity. Humans cannot forge entity authors. |
| Tasks | Workspace member read; insert their own request with default submitted/stored values. No direct update/delete or execution-field insertion. |
| Task events | Workspace-gated read; service writes. |
| Permission rules | Admin/owner manage within the workspace. |
| Approvals | Workspace member read; admin/owner update status to approved/rejected. Creation and execution-owned metadata stay with the service. |
| Credentials | No human/anonymous grant; service only. |
| Context packages | No direct human/anonymous grant. Filtered delivery must go through the WP-E1-03 permission engine. |
| Audit | Workspace member read; service insert/select only, without update/delete/truncate grants. |

The entity API uses `service_role`, which bypasses RLS. These policies are **not**
proof of entity-path authorization. The API-key lookup, conversation-membership
checks, assigned-task restrictions, and recipient context filtering must be
implemented in the application before connecting entities. The schema includes
hash storage only, not key issuance or a hashing algorithm.

## Validation and limits

`npm ci && npm test` executes the migration and seed on embedded PostgreSQL
(PGlite), then runs actual role/ACL/RLS queries. `.github/workflows/database.yml`
runs the same suite on PostgreSQL 17 through `npm run db:verify:postgres` in an
empty, disposable database. Its minimal Auth harness exists only in `tests/`.

The tests exercise SQL identity claims, not real Supabase Auth JWT issuance,
PostgREST, Realtime, or hosted project configuration. Running them is not a hosted
Supabase acceptance claim. Provider side-effect deduplication, queue behavior,
approval-driven task transitions, source authorization, and the UI are later
packages. Task uniqueness alone does not guarantee exactly-once external effects.
