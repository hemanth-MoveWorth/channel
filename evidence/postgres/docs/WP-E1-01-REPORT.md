# WP-E1-01 report

Contract reviewed: `ARCHITECTURE.md` including accepted ADR-001, and
`WORK-PACKAGES.md`, at base commit `3de14e8`.
Branch: `feat/wp-e1-01`. Architecture was not edited and no new ADR was invented.

Publication: blocked. Git push was denied with HTTP 403 for the local credential's
account, and the connected GitHub app rejected branch/tree writes with HTTP 403
`Resource not accessible by integration`. No feature branch or PR was created
remotely. The local feature-branch commit, patch, and source archive are preserved
for review/import. The GitHub Actions workflow has not run.

## Delivered

- Transactional migration under `supabase/migrations/` with the 11 requested
  core tables plus ADR-001's workspaces, workspace membership, and credentials:
  14 RLS-enabled tables total.
- Composite tenant foreign keys; exact documented task states and delivery
  receipts; unique task idempotency keys; at most one type A orchestrator per
  conversation and one active key hash per entity.
- Human-path RLS and ACLs. Profile verification cannot be self-granted. Entity
  service-role enforcement is explicitly documented as future application work.
- Seed: two disconnected demo entities and one group, attached to an existing
  Auth user; duplicate-free rerun and protection against replacing the owner.
- Readable schema contract for Entity 2 in `docs/SCHEMA.md`.
- Executable SQL acceptance suite and PostgreSQL 17 GitHub Actions workflow.

## Acceptance evidence

Local command: `npm test`. Result: one suite passed with **44 SQL acceptance
checks**, including actual PostgreSQL role changes, table permissions, RLS
filtering, constraints and expected SQLSTATE failures. `git diff --check` passed.
The locked dependency installation audited 16 packages with zero vulnerabilities.

| Criterion | Evidence / limitation |
| --- | --- |
| Migration applies cleanly | Passed on embedded PostgreSQL (PGlite); same migration is configured for PostgreSQL 17 in GitHub Actions. |
| RLS enabled and policies enforced | All 14 tables checked; owner/admin/member/other tenant/anonymous role cases executed. |
| Seed loads | Two demo profiles, one group, two group memberships; rerun checked; changed-owner seed denied. |
| Entity 2 can read schema | Migration and `docs/SCHEMA.md` are available as source files in the PR. This is not credential-table access or protocol integration sign-off. |
| Supabase start / hosted Supabase | **Not run.** Docker is unavailable and the user specified GitHub only, with no Supabase project. |

The Auth stand-in is test-only. SQL-level access tests do not prove real Supabase
JWT issuance, PostgREST, Realtime, or deployed project settings. The package is
implemented and locally SQL-validated; original Supabase runtime acceptance remains
unverified. GitHub CI results should be read from the PR's checks, not inferred
from the presence of the workflow file.

## Deviations and boundaries

Per the user's GitHub-only direction, no hosted project was provisioned and no
credentials were requested again. Embedded PostgreSQL and disposable PostgreSQL
CI provide reproducible SQL checks without external accounts. Mow needs to record
whether this evidence substitutes for the original Supabase runtime criterion.

Human rights absent from ADR-001 are not granted: identity/membership provisioning
and raw context delivery remain service-only. Conversation-level human tightening
is deferred exactly as the ADR states. Workspace roles do not grant entity access;
the application permission engine must enforce that path.

Queue execution, state-transition event recording, permission-rule JSON
interpretation, approved-action execution and the browser interface are not claimed
as implemented by this database package.

## Specification questions before WP-E1-02

These are flags for Mow, not proposed or silently accepted contracts:

1. **Transition graph:** the arrow sequence lists states, but does not specify
   legal resume transitions from `input_required` / `awaiting_approval`, optional
   skipping of those states, or which states can fail/cancel.
2. **Frozen API and delivery interface:** route/method/request/response/error
   contracts and webhook acknowledgement/result formats are not in the architecture.
   `WORK-PACKAGES.md` requires cross-package interfaces to go through Mow.
3. **Exactly-once external effect contract:** a persisted idempotency key alone
   cannot prevent an external action repeating after success followed by a lost
   acknowledgement. Specify recipient-side deduplication/result recovery or a
   narrower acceptance effect that is atomic with the database transaction.

WP-E1-02 is not started pending these specifications. WP-E1-03 and WP-E1-04 follow
in order and are not started. No architecture decision has been changed in code.
