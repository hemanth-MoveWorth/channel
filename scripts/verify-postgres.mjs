// Disposable PostgreSQL CI database ONLY: this creates the test Auth stand-in.
import pg from 'pg';
import { acceptance, read } from '../tests/acceptance.mjs';
if (!process.env.SIGNALDESK_TEST_DATABASE_URL) throw new Error('Set SIGNALDESK_TEST_DATABASE_URL to an EMPTY disposable PostgreSQL database.');
const db = new pg.Client({ connectionString: process.env.SIGNALDESK_TEST_DATABASE_URL });
await db.connect();
const adapter = { query: (...args) => db.query(...args), exec: sql => db.query(sql) };
try {
  await db.query(await read('tests/auth-harness.sql'));
  await db.query(await read('supabase/migrations/20261001000100_core_schema.sql'));
  await db.query(await read('tests/fixtures.sql'));
  await db.query(await read('supabase/seed.sql'));
  await db.query('begin');
  let passed = 0;
  await acceptance(adapter, name => { passed++; console.log(`PASS: ${name}`); });
  await db.query('rollback');
  console.log(`${passed} PostgreSQL acceptance checks passed. Supabase Auth/REST integration is not covered by the Auth stand-in.`);
} catch (err) {
  // Deliberately don't print driver errors, connection strings, or SQL parameters.
  console.error(`Database verification failed (SQLSTATE ${err.code ?? 'unknown'}).`);
  process.exitCode = 1;
} finally {
  await db.end();
}
