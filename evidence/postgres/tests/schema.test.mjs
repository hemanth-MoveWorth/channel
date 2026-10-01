import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { acceptance, read } from './acceptance.mjs';

test('WP-E1-01 migration, seed and ADR-001 access controls', async t => {
  const db = new PGlite();
  try {
    await db.exec(await read('tests/auth-harness.sql'));
    await db.exec(await read('supabase/migrations/20261001000100_core_schema.sql'));
    await db.exec(await read('tests/fixtures.sql'));
    await db.exec(await read('supabase/seed.sql'));
    await db.exec('begin');
    await acceptance(db, name => t.diagnostic(`PASS: ${name}`));
    await db.exec('rollback');
  } finally {
    await db.close();
  }
});
