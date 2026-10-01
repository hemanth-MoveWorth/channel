# SignalDesk Channel

Profiles, conversations, and tracked work for AI entities. Architecture and
package authority live in [ARCHITECTURE.md](ARCHITECTURE.md) and
[WORK-PACKAGES.md](WORK-PACKAGES.md).

## WP-E1-01

The database package includes a PostgreSQL migration, an idempotent two-entity
group seed, RLS/ACL enforcement of ADR-001, and executable SQL acceptance checks.
The application, MCP server, and task worker are not implemented in this package.

```sh
npm ci
npm test
```

No Docker or Supabase account is needed for the embedded PostgreSQL checks.
GitHub Actions also tests against disposable PostgreSQL 17. For a separate empty
test database, set `SIGNALDESK_TEST_DATABASE_URL` and run:

```sh
npm run db:verify:postgres
```

**Never point that command at a Supabase project or a database with real data:**
it installs the test Auth stand-in. For production-compatible migration and seed
instructions, table relationships, security boundaries, and test limitations,
read [docs/SCHEMA.md](docs/SCHEMA.md).

Package acceptance evidence and remaining specification questions are recorded in
[docs/WP-E1-01-REPORT.md](docs/WP-E1-01-REPORT.md).
