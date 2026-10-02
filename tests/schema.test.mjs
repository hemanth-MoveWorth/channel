import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase,migrate } from '../src/database.mjs';
import { seed,demo } from '../src/seed.mjs';
import { listEntities,authorize,authenticateEntity,hashKey } from '../src/access.mjs';

test('WP-E1-01 SQLite migration, seed, persistence and application authorization', t => {
  const parent=resolve('.tmp'); mkdirSync(parent,{recursive:true});
  const dir=mkdtempSync(join(parent,'schema-')); const path=join(dir,'channel.db');
  let db=openDatabase(path);
  try {
    const applied=migrate(db);
    assert.equal(applied[0],'001_core.sql');
    assert.equal(applied.length,db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n);
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

test('migrate and seed CLIs use SIGNALDESK_DB_PATH and the documented default',()=>{
  const parent=resolve('.tmp');mkdirSync(parent,{recursive:true});
  const dir=mkdtempSync(join(parent,'cli-'));
  try {
    for (const configured of [false,true]) {
      const env={...process.env}; delete env.SIGNALDESK_DB_PATH;
      if(configured)env.SIGNALDESK_DB_PATH=join(dir,'configured.db');
      for(const script of ['migrate','seed']) {
        const result=spawnSync(process.execPath,[fileURLToPath(new URL(`../scripts/${script}.mjs`,import.meta.url))],{cwd:dir,env,encoding:'utf8',windowsHide:true});
        assert.equal(result.status,0,result.stderr);assert.doesNotThrow(()=>JSON.parse(result.stdout));
      }
      const db=openDatabase(configured?env.SIGNALDESK_DB_PATH:join(dir,'data/channel.db'));
      try {assert.equal(db.prepare('SELECT count(*) AS n FROM entities').get().n,2);} finally {db.close();}
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
