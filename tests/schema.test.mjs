import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { openDatabase,migrate } from '../src/database.mjs';
import { seed,demo } from '../src/seed.mjs';
import { listEntities,authorize,authenticateEntity,hashKey } from '../src/access.mjs';

test('WP-E1-01 SQLite migration, seed, persistence and application authorization', t => {
  const parent=resolve('.tmp'); mkdirSync(parent,{recursive:true});
  const dir=mkdtempSync(join(parent,'schema-')); const path=join(dir,'channel.db');
  let db=openDatabase(path);
  try {
    assert.deepEqual(migrate(db),['001_core.sql']);
    assert.deepEqual(migrate(db),[]);
    seed(db); seed(db);
    assert.equal(db.prepare('SELECT count(*) AS n FROM entities').get().n,2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM conversations').get().n,1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM conversation_members').get().n,2);
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
    for (const table of ['users','workspaces','workspace_members','entities','entity_credentials','conversations','conversation_members','messages','tasks','task_events','permission_rules','approvals','context_packages','audit_log','job_queue']) assert.ok(tables.includes(table),table);
    const owner={kind:'human',user_id:demo.user};
    assert.equal(listEntities(db,owner,demo.workspace).length,2);
    assert.equal(listEntities(db,owner,demo.workspace,'research')[0].id,demo.research);
    const key='test-key-only';
    db.prepare('INSERT INTO entity_credentials VALUES (?,?,?,?,NULL)').run('credential-1',demo.research,hashKey(key),new Date().toISOString());
    const actor=authenticateEntity(db,key);
    assert.equal(listEntities(db,actor,demo.workspace).length,2);
    assert.ok(!JSON.stringify(listEntities(db,actor,demo.workspace)).includes(hashKey(key)));
    assert.throws(()=>listEntities(db,{kind:'human',user_id:'outsider'},demo.workspace),e=>e.status===403);
    assert.equal(db.prepare("SELECT count(*) AS n FROM audit_log WHERE decision='deny'").get().n,1);
    assert.throws(()=>authorize(db,actor,demo.workspace,'credentials:read'),e=>e.status===403);
    assert.throws(()=>authorize(db,actor,demo.workspace,'entities:write'),e=>e.status===403);
    assert.throws(()=>authorize(db,actor,demo.workspace,'messages:write',{conversationId:'not-a-member'}),e=>e.status===403);
    db.prepare('UPDATE entity_credentials SET revoked_at=?').run(new Date().toISOString());
    assert.throws(()=>authenticateEntity(db,key),e=>e.status===401);
    db.close(); db=openDatabase(path);
    assert.equal(db.prepare('SELECT count(*) AS n FROM entities').get().n,2);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    t.diagnostic('SQLite file migrated, seeded twice, reopened; application denied and audited unauthorized access. No network or containers.');
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});
