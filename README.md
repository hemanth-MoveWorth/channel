# SignalDesk Channel

Local prototype under ADR-002/003. Node.js 22.13+ supplies SQLite and the test
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
external service. The entity registration/chat UI and complete approval/context
engine are later packages, so this is not a claim of a finished product.

See [docs/API-v0.1.md](docs/API-v0.1.md) for the implemented task routes and
[docs/WP-E1-02-REPORT.md](docs/WP-E1-02-REPORT.md) for crash/restart evidence.
