# WP-E1-04 acceptance report

Contract: ADR-005 at `6c02d9d`, with ADR-002/003/004. Branch `feat/wp-e1-04`,
stacked on accepted WP-E1-03 (`a8a10c6`). No architecture edits.

## Delivered

- One local page: directory, DM/group conversations, messages, work requests,
  live task states and receipts, approval queue with Approve/Reject, and Stop.
- Group creation with member selection and a type A orchestrator; the choice is
  persisted and shown when opening the conversation.
- Frozen dashboard list routes, conversation/message payload mapping, pagination,
  task-linked results, and limited requester updates under ADR-005.
- SQLite migration 004 for conversation timestamps and message kind/parent links.
- Self-contained `npm run demo` for repeatable browser testing, using real HTTP,
  the worker and SQLite with local deterministic tools; zero external services.

## Automated acceptance

`npm test`: **23 passed, 0 failed**. Node 22.22.3 / SQLite 3.51.3 / Windows.
Raw output: `evidence/sqlite/wp-e1-04-acceptance.txt`.

New tests cover human-only dashboard lists, pagination/filtering, outsider denial,
conversation shapes and membership, orchestrator eligibility, authenticated sender
attribution, cross-conversation reference rejection, forged result rejection,
inbox shapes, requester input/cancellation rights, entity approval/rejection denial,
local static asset routing and content-security policy. All prior permission,
source-grant, migration, state graph and real worker kill/restart tests pass.

## Browser acceptance — executed, not inferred from API tests

Tested the served page through Codex's browser on `http://127.0.0.1:3000`:

| Step | Visible result and persisted evidence |
| --- | --- |
| Create group | Launch research contains both demo entities; Demo Research Agent is selected and displayed as orchestrator. |
| Send message | Shared launch context appears in the group as a human chat message. |
| Create request | Review the launch brief and report the word count appears in Task activity and Needs approval; receipt remains stored. |
| Approve | Local tool receives the checked context, posts a task_result (9 words; 1 conversation message), and task becomes completed / accepted_for_execution. SQLite confirms 1 delivery and 1 result. |
| Reject | Separate request becomes cancelled; SQLite confirms rejected approval, 0 deliveries and 0 results. |
| Stop | A separate paused request becomes cancelled through Stop; SQLite confirms 0 deliveries and 0 results. |
| Reload | Group, result, completed task and both cancelled tasks remain visible after a full page reload. |
| Create DM | Research DM opens with only Demo Research Agent listed. |
| Untrusted content | An img/onerror string is displayed literally; message DOM contains 0 image nodes. Browser console has no captured errors/warnings. |
| Status filter | Selecting completed shows the completed request. |

The default browser used a narrow viewport; the page's stacked layout remained
usable. Screenshots of the paused and completed loop are supplied with the handoff.
Database confirmation is in `evidence/sqlite/wp-e1-04-browser.txt`.

## Scope and deviations

No external service, cloud deployment, Docker, AI provider or new public management
endpoint was used. The demo recipient is a deterministic local tool, not a model.
This proves the package's clickable request/approval/result loop; it does not claim
the full prototype's live-tool, autonomous orchestration or security sign-off.

DM/group payloads follow ADR-005. Existing database names kind/name are mapped to
type/title. The paginated endpoint uses documented limit/offset and an items/total
envelope. Optional references return null. Legacy conversations without timestamps
retain an empty created_at; newly created/seeded conversations receive timestamps.

The selected orchestrator is persisted; orchestration execution remains integration
work. Result content travels via the specified task_result message shape. No new
result-transition body fields, mention syntax or source-management API are invented.
See docs/DASHBOARD-API.md for integration details.

## Publication

Human push is pending, per the existing GitHub credential arrangement. Open the
WP-E1-04 PR against feat/wp-e1-03 until that branch is merged. No push, created PR
or GitHub CI run is claimed. WP-E1-01 is closed; WP-E1-02 and WP-E1-03 remain
accepted pending the human push/PR review. WP-E1-04 is ready for Mow's review.
