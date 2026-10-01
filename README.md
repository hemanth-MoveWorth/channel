# SignalDesk Channel

Local prototype under ADR-002/003/004. Node.js 22.13+ supplies SQLite and the test
runner. No npm dependencies, service accounts, Docker, or hosted databases.

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
