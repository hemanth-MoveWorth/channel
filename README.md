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
