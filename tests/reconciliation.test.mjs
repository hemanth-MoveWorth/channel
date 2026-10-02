import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readFileSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase,migrate,migrationsDirectory } from '../src/database.mjs';
import { fixture,listen,closeServer } from './helpers.mjs';
import { createApiServer } from '../src/server.mjs';
import { demo,seed } from '../src/seed.mjs';
import { createTask,transitionTask,reclassifyTask,getTask } from '../src/tasks.mjs';
import { ACTION_CATEGORIES,grantCategories,setApprovalMode } from '../src/categories.mjs';
import { TASK_REASONS,taskReason } from '../src/task-reasons.mjs';
import { decideApproval } from '../src/approvals.mjs';
import { Worker } from '../src/worker.mjs';
import { addRule,setPermissionMode } from '../src/permissions.mjs';
import { hashKey } from '../src/access.mjs';
const requester={kind:'entity',entity_id:demo.writing};
const assignee={kind:'entity',entity_id:demo.research};

test('migration upgrades the approved four-migration schema without inventing categories for legacy tasks',()=>{
  const db=openDatabase(':memory:');try {
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
    for(const file of readdirSync(migrationsDirectory).filter(f=>/^00[1-4]_/.test(f)).sort()) {
      const sql=readFileSync(join(migrationsDirectory,file),'utf8').replace(/\r\n/g,'\n');db.exec(sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(file,createHash('sha256').update(sql).digest('hex'),new Date().toISOString());
    }
    seed(db);
    db.prepare(`INSERT INTO tasks(id,workspace_id,conversation_id,created_by_user_id,assigned_entity_id,goal,state,idempotency_key,created_at,recipient_entity_ids)
      VALUES ('legacy',?,?,?,?,?,'queued','legacy',?,?)`).run(demo.workspace,demo.group,demo.user,demo.research,'Unclassified historical request',new Date().toISOString(),JSON.stringify([demo.research]));
    assert.deepEqual(migrate(db),['005_categories_reasons.sql']);assert.deepEqual(migrate(db),[]);
    assert.equal(db.prepare("SELECT category FROM tasks WHERE id='legacy'").get().category,null);
    assert.deepEqual(JSON.parse(db.prepare('SELECT category_grants FROM entities WHERE id=?').get(demo.research).category_grants),['research']);
    setPermissionMode(db,{kind:'human',user_id:demo.user},demo.workspace,'*','full_access_workspace');
    const stopped=transitionTask(db,assignee,'legacy',{to_state:'working'});
    assert.equal(stopped.state,'failed');assert.equal(stopped.reason,'permission_denied');
    assert.equal(db.prepare('SELECT count(*) AS n FROM deliveries').get().n,0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();}
});

test('missing static asset returns complete 500 JSON and the server still handles the next request',async()=>{
  const f=fixture();const api=createApiServer(f.db,{assetRoot:pathToFileURL(f.dir+'/')});const base=await listen(api);
  try {
    const response=await fetch(base+'/',{signal:AbortSignal.timeout(3000)});
    assert.equal(response.status,500);
    assert.deepEqual(await response.json(),{error:{code:'internal_error',message:'Request failed.'}});
    assert.equal((await fetch(base+'/v1/entities',{signal:AbortSignal.timeout(3000)})).status,200);
  } finally {await closeServer(api);f.close();}
});

test('ADR-009 bootstrap grants only research; undeclared/unknown/ungranted categories fail closed at create',()=>{
  const f=fixture();try {
    f.db.prepare("INSERT INTO entities(id,workspace_id,owner_user_id,name,connection_type) VALUES (?,?,?,'Fresh entity','A')").run('fresh',demo.workspace,demo.user);
    const fresh=f.db.prepare('SELECT category_grants,category_policy FROM entities WHERE id=?').get('fresh');
    assert.deepEqual(JSON.parse(fresh.category_grants),['research']);assert.deepEqual(JSON.parse(fresh.category_policy),{kind:'ask_every_time'});
    for(const category of [undefined,null,'unknown',...ACTION_CATEGORIES.slice(1)]) {
      assert.throws(()=>createTask(f.db,requester,{...f.body,category,requester_entity_id:demo.research,category_grants:ACTION_CATEGORIES}),e=>e.status===422);
    }
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM job_queue').get().n,0);
    assert.ok(f.db.prepare("SELECT 1 FROM audit_log WHERE action='category.request' AND decision='deny'").get());
    assert.throws(()=>grantCategories(f.db,requester,demo.workspace,demo.writing,ACTION_CATEGORIES),e=>e.status===403);
    assert.throws(()=>setApprovalMode(f.db,requester,demo.workspace,demo.research,{kind:'full_access_workspace'}),e=>e.status===403);
    grantCategories(f.db,f.owner,demo.workspace,demo.writing,['publish']);
    assert.equal(createTask(f.db,requester,{...f.body,category:'publish'}).task.category,'publish');
    assert.throws(()=>createTask(f.db,requester,f.body),e=>e.status===422); // Grants are exact, not a risk ceiling.
  }finally{f.close();}
});

test('assignee category policy is evaluated at API accept: deny fails; ask pauses; approval resumes',()=>{
  const f=fixture();try {
    setApprovalMode(f.db,f.owner,demo.workspace,demo.research,{kind:'standing_rules',rules:{research:'deny'}});
    const denied=createTask(f.db,requester,f.body).task;assert.equal(denied.state,'queued');
    const failure=transitionTask(f.db,assignee,denied.id,{to_state:'working'});
    assert.equal(failure.state,'failed');assert.equal(failure.reason,'permission_denied');
    assert.deepEqual(f.db.prepare("SELECT to_state FROM task_events WHERE task_id=? AND event_type='transition' ORDER BY rowid").all(denied.id).map(e=>e.to_state),['queued','working','failed']);
    setApprovalMode(f.db,f.owner,demo.workspace,demo.research,{kind:'ask_every_time'});
    const task=createTask(f.db,requester,f.body).task;
    const paused=transitionTask(f.db,assignee,task.id,{to_state:'working'});
    assert.equal(paused.state,'awaiting_approval');assert.equal(paused.reason,'policy_requires_approval');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM context_packages WHERE task_id=?').get(task.id).n,0);
    assert.throws(()=>transitionTask(f.db,assignee,task.id,{to_state:'completed'}),e=>e.status===422);
    assert.equal(decideApproval(f.db,f.owner,task.id,'approved').state,'working');
    assert.equal(transitionTask(f.db,assignee,task.id,{to_state:'completed'}).reason,null);
  }finally{f.close();}
});

test('upward reclassify covers the full category ordering and is assignee/working-only',()=>{
  const f=fixture();try{
    grantCategories(f.db,f.owner,demo.workspace,demo.writing,ACTION_CATEGORIES);
    for(const from of ACTION_CATEGORIES)for(const to of ACTION_CATEGORIES){
      const task=createTask(f.db,requester,{...f.body,category:from}).task;
      transitionTask(f.db,assignee,task.id,{to_state:'working'});
      if(ACTION_CATEGORIES.indexOf(to)>ACTION_CATEGORIES.indexOf(from))assert.equal(reclassifyTask(f.db,assignee,task.id,to).category,to);
      else {assert.throws(()=>reclassifyTask(f.db,assignee,task.id,to),e=>e.status===422);assert.equal(getTask(f.db,f.owner,task.id).category,from);}
    }
    const task=createTask(f.db,requester,f.body).task;
    assert.throws(()=>reclassifyTask(f.db,assignee,task.id,'publish'),e=>e.status===422);
    transitionTask(f.db,assignee,task.id,{to_state:'working'});
    assert.throws(()=>reclassifyTask(f.db,requester,task.id,'publish'),e=>e.status===403);
    assert.throws(()=>reclassifyTask(f.db,f.owner,task.id,'publish'),e=>e.status===403);
    transitionTask(f.db,assignee,task.id,{to_state:'input_required'});
    assert.throws(()=>reclassifyTask(f.db,assignee,task.id,'publish'),e=>e.status===422);
  }finally{f.close();}
});

test('reclassify reruns both checks: requester deny, assignee deny, and fresh ask approval',()=>{
  const f=fixture();try{
    const start=()=>{const task=createTask(f.db,requester,f.body).task;transitionTask(f.db,assignee,task.id,{to_state:'working'});return task;};
    const noGrant=start();assert.equal(reclassifyTask(f.db,assignee,noGrant.id,'publish').reason,'permission_denied');
    assert.equal(getTask(f.db,f.owner,noGrant.id).state,'failed');
    grantCategories(f.db,f.owner,demo.workspace,demo.writing,ACTION_CATEGORIES);
    setApprovalMode(f.db,f.owner,demo.workspace,demo.research,{kind:'standing_rules',rules:{research:'allow',publish:'deny'}});
    const denied=start();assert.equal(reclassifyTask(f.db,assignee,denied.id,'publish').state,'failed');
    setApprovalMode(f.db,f.owner,demo.workspace,demo.research,{kind:'ask_every_time'});
    const asking=createTask(f.db,requester,f.body).task;transitionTask(f.db,assignee,asking.id,{to_state:'working'});
    decideApproval(f.db,f.owner,asking.id,'approved');
    const reclassified=reclassifyTask(f.db,assignee,asking.id,'publish');
    assert.equal(reclassified.state,'awaiting_approval');assert.equal(reclassified.reason,'policy_requires_approval');
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM approvals WHERE task_id=? AND status='pending'").get(asking.id).n,1);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM approvals WHERE task_id=? AND status='approved'").get(asking.id).n,1);
    decideApproval(f.db,f.owner,asking.id,'approved');assert.equal(getTask(f.db,f.owner,asking.id).reason,null);
    const legacy=createTask(f.db,requester,f.body).task;f.db.prepare('UPDATE tasks SET category=NULL WHERE id=?').run(legacy.id);
    assert.equal(transitionTask(f.db,assignee,legacy.id,{to_state:'working'}).reason,'permission_denied');
  }finally{f.close();}
});

test('category revocation and ADR-004 deny block worker dispatch despite approval; no HTTP side effect',async()=>{
  const f=fixture();let sends=0;const recipient=createServer((req,res)=>{sends++;req.resume();res.end('{"accepted":true}');});const webhook=await listen(recipient);
  try{
    f.db.prepare('UPDATE entities SET webhook_url=? WHERE id=?').run(webhook,demo.research);
    const worker=new Worker(f.db);
    setApprovalMode(f.db,f.owner,demo.workspace,demo.research,{kind:'ask_every_time'});
    const task=createTask(f.db,requester,f.body).task;await worker.tick();decideApproval(f.db,f.owner,task.id,'approved');
    grantCategories(f.db,f.owner,demo.workspace,demo.writing,[]);await worker.tick();
    assert.equal(getTask(f.db,f.owner,task.id).state,'failed');assert.equal(sends,0);
    grantCategories(f.db,f.owner,demo.workspace,demo.writing,['research']);
    const changed=createTask(f.db,requester,f.body).task;await worker.tick();
    setApprovalMode(f.db,f.owner,demo.workspace,demo.research,{kind:'standing_rules',rules:{research:'deny'}});
    assert.throws(()=>decideApproval(f.db,f.owner,changed.id,'approved'),e=>e.status===403);
    assert.equal(sends,0);
    decideApproval(f.db,f.owner,changed.id,'rejected');
    setApprovalMode(f.db,f.owner,demo.workspace,demo.research,{kind:'full_access_workspace'});
    const resourceDenied=createTask(f.db,requester,f.body).task;
    addRule(f.db,f.owner,demo.workspace,{subject_entity_id:'*',resource_type:'task',resource_id:'*',action:'execute',effect:'deny',priority:0});
    await worker.tick();assert.equal(getTask(f.db,f.owner,resourceDenied.id).reason,'permission_denied');assert.equal(sends,0);
  }finally{await closeServer(recipient);f.close();}
});

test('TaskReason is the exact ADR-008 closed enum; HTTP rejects arbitrary text and persists valid reasons',async()=>{
  assert.deepEqual(TASK_REASONS,['rejected_by_assignee','approval_rejected','permission_denied','assignee_reported_failure','policy_requires_approval','hop_limit_reached','no_progress_limit_reached','budget_runtime_exceeded','stopped_by_user','parent_cancelled']);
  for(const value of TASK_REASONS)assert.equal(taskReason(value),value);
  const f=fixture();const api=createApiServer(f.db);const base=await listen(api);
  try {
    const task=createTask(f.db,f.owner,f.body).task;
    for(const reason of ['user_stop','external_auth_required','reclassified_needs_approval','arbitrary secret',{},42]) {
      const response=await fetch(`${base}/v1/tasks/${task.id}/transition`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to_state:'cancelled',reason})});
      assert.equal(response.status,422);assert.equal((await response.json()).error.code,'invalid_task_reason');
      assert.equal(getTask(f.db,f.owner,task.id).state,'queued');
    }
    f.db.prepare('INSERT INTO entity_credentials VALUES (?,?,?,?,NULL)').run('decline-key',demo.research,hashKey('decline-test'),new Date().toISOString());
    const response=await fetch(`${base}/v1/tasks/${task.id}/transition`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer decline-test'},body:JSON.stringify({to_state:'cancelled',reason:'rejected_by_assignee'})});
    assert.equal(response.status,200);assert.equal((await response.json()).data.reason,'rejected_by_assignee');
    const event=f.db.prepare("SELECT details FROM task_events WHERE task_id=? AND to_state='cancelled'").get(task.id);
    assert.equal(JSON.parse(event.details).reason,'rejected_by_assignee');
    assert.throws(()=>f.db.prepare('UPDATE tasks SET reason=? WHERE id=?').run('unknown',task.id));
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM audit_log WHERE reason LIKE '%arbitrary secret%'").get().n,0);
  }finally{await closeServer(api);f.close();}
});
