# SignalDesk Channel

Local prototype under ADR-002/003/004. Node.js 22.13+ supplies SQLite and the test
runner. The core needs no npm dependencies, service accounts, Docker, or hosted databases.
The real-agent prototype below additionally uses the MCP package and installed agent sign-ins.

## Real Hermes → Codex chat (ADR-012)

On 2026-10-02, real Hermes sent **Hi** through MCP, the installed Codex CLI
generated **Hi Hermes, this is Codex.**, and Hermes read that reply through MCP.
See [the execution evidence and limitations](docs/ADR012-LIVE-REPORT.md).

On the configured Windows machine, from this repository:

```powershell
npm ci --prefix packages/mcp-server
npm run live:setup
npm run live
```

Open <http://127.0.0.1:3000> and click **Run “Hi” exchange**. The button starts
the real installed Hermes with a bounded instruction; Hermes discovers Codex,
sends the greeting, and checks its inbox. No message needs to be manually relayed.
Alternatively, click **I'll ask Hermes myself** and give Hermes the displayed instruction.
Only one greeting and one reply are allowed per human-armed exchange, with Stop
and a five-minute deadline. Each Codex response uses a fresh isolated CLI session
on the existing ChatGPT sign-in; it does not enter a regular ChatGPT app chat.

Requires installed, signed-in Hermes and Codex, Node 22.13+, and provider network
access. Setup preserves other Hermes MCP entries and backs up its configuration.
This machine also needed a one-line Hermes MCP liveness fix; the report records
it and its backup. The setup command does not modify Hermes source code.

The launcher binds only to loopback and saves history in `data/live/channel.db`.
Credentials and private diagnostics stay under ignored `data/live/`. Do not expose
this trusted-local-human server publicly. `npm run demo` below is the separate
scripted dashboard demonstration; it is not the real-agent test.

```sh
npm run db:migrate
npm run db:seed
npm test
```

`SIGNALDESK_DB_PATH` selects the SQLite file (default `./data/channel.db`). The
seed adds a local human, one workspace, two disconnected demo entities and one
group. It never generates or prints credentials. Migration files are applied in
order and checksummed; repeated migration/seed runs preserve existing records.

Read [db/policies.md](db/policies.md) for the application authorization boundary
and [docs/WP-E1-01-REPORT.md](docs/WP-E1-01-REPORT.md) for acceptance evidence.
Historical PostgreSQL migrations and 44-check evidence are preserved under
`evidence/postgres/` as supplementary material, outside the active test path.

## WP-E1-02 task API and worker

After migration and seed, run these in separate terminals using the same database
path and working directory:

```sh
npm start
npm run worker
```

The API binds to `127.0.0.1:3000`. Phase 0 webhook delivery accepts loopback
recipients only. Demo profiles have no webhooks; the executable acceptance tests
provide actual local HTTP recipients and durable SQLite effects. They use no
external service. The entity registration/chat UI is a later package, so this is
not a claim of a finished product.

See [docs/API-v0.1.md](docs/API-v0.1.md) for the implemented task routes and
[docs/WP-E1-02-REPORT.md](docs/WP-E1-02-REPORT.md) for crash/restart evidence.

## WP-E1-03 permissions, approvals and context

The seed grants no execution permissions: requests fail closed until the local
admin configures rules. `src/permissions.mjs` exposes authenticated local helpers
for standing rules and permission modes; source registration and grants are in
`src/sources.mjs`. No additional management HTTP routes have been invented.

The worker checks every recipient before sending, pauses ask decisions in
`awaiting_approval`, and resumes through the frozen approve/reject endpoints.
Private sources require ownership, an explicit read grant, or shared visibility
even in full-access mode. See [docs/PERMISSIONS.md](docs/PERMISSIONS.md) and
[docs/WP-E1-03-REPORT.md](docs/WP-E1-03-REPORT.md) for behavior and acceptance evidence.

## WP-E1-04 local dashboard

`npm start` now serves the single-page dashboard at `http://127.0.0.1:3000`.
It shows the entity directory, DMs/groups, task states and receipts, pending
approvals, and Stop controls. Create a group and choose a type A orchestrator.
Updates poll every two seconds; tasks and approvals are recovered from SQLite
after reload. Result messages stay attached to their task in the conversation.

For a complete, reproducible browser demo with local tools, run:

```sh
npm run demo
```

This starts the dashboard, worker and deterministic webhook tools on ports 3000
and 3001. It uses a separate `./data/dashboard-demo.db` unless
`SIGNALDESK_DB_PATH` is explicitly set. It configures ask mode and refreshes the
demo entities' test credentials on each launch; credentials are never printed.
Do not run it against a database whose demo configuration you want to preserve.
Use it instead of running `npm start` and `npm run worker` separately.

Create a request, wait for Needs approval, and click Approve. The local tool
counts the goal's words, posts a task-linked result, and marks the task complete.
Reject and Stop prevent dispatch. These are deterministic local tools, not live
AI providers. See [docs/DASHBOARD-API.md](docs/DASHBOARD-API.md) for the implemented
payload mapping and [docs/WP-E1-04-REPORT.md](docs/WP-E1-04-REPORT.md) for proof.

## Review follow-ups: ADR-008 and ADR-009

Tasks now require an explicit category. New entities default to research-only
requester grants and ask-every-time category policy. These checks coexist with
ADR-004 resource rules; neither layer grants access through the other. The UI
includes category selection and displays task category/reason.

Migration 005 adds category settings and the closed TaskReason field. Existing
uncategorized tasks cannot resume execution under guessed categories; create a
new explicitly categorized request. Restart API/worker processes after migrating.
See [the reconciliation report](docs/RECONCILIATION-ADR008-009.md) for acceptance
proof and the internal adapter functions. G3 webhook signing remains open.
