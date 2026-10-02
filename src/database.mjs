import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const migrationsDirectory = fileURLToPath(new URL('../db/migrations/', import.meta.url));
export function openDatabase(path = process.env.SIGNALDESK_DB_PATH || './data/channel.db') {
  const filename = path === ':memory:' ? path : resolve(path);
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  return db;
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = [];
  for (const name of readdirSync(migrationsDirectory).filter(name => name.endsWith('.sql')).sort()) {
    const sql = readFileSync(resolve(migrationsDirectory,name),'utf8').replace(/\r\n/g,'\n');
    const checksum = createHash('sha256').update(sql).digest('hex');
    transaction(db, () => {
      const prior = db.prepare('SELECT checksum FROM schema_migrations WHERE name=?').get(name);
      if (prior) {
        if (prior.checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
        return;
      }
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(name,checksum,new Date().toISOString());
      applied.push(name);
    });
  }
  return applied;
}
