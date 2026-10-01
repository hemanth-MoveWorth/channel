# WP-E1-01 — SQLite acceptance

Authority: accepted ADR-001, superseding ADR-002, and current WP-E1-01 at
`255139e`. Feature branch: `feat/wp-e1-01`.

Delivered plain ordered SQL under `db/migrations/`, built-in Node SQLite migrate
and seed scripts, all 15 required domain tables (including `job_queue`),
`db/policies.md`, and a checked application directory read with entity-key lookup.
Migration tracking adds a `schema_migrations` infrastructure table.

Acceptance command: `node --test tests/schema.test.mjs`.
Result: PASS on a fresh SQLite 3.51.3 file using Node 22.22.3 on Windows.

- Migration applied cleanly and a second application was a no-op.
- Seed ran twice with exactly two demo entities, one group and two memberships.
- Closing and reopening the SQLite file preserved the seed.
- Unauthorized human read was rejected with 403 at the application layer and
  recorded as a denied decision. Unknown actions and entity self-grants denied.
- Valid entity key resolved to its entity; revoked key returned 401. Profile
  serialization excluded credentials. SQLite foreign-key integrity check passed.
- This acceptance test used no network calls, containers, service accounts or
  external database.

The original 44 embedded-PostgreSQL checks are supplementary evidence under
`evidence/postgres/`. They are not the acceptance path. PostgreSQL CI is archived;
the active GitHub workflow uses Node and local SQLite only.

SQLite does not enforce RLS. Identity authorization is application code; full
permission-rule evaluation and per-source context filtering remain WP-E1-03.
The local database file must not be shared with untrusted entities. They use the
API, not file access.

Publication handoff: the human will push `feat/wp-e1-01` from their authenticated
terminal because this agent's Git and connector writes previously returned 403.
No remote push or PR creation is claimed.
