import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fixture,listen,closeServer } from './helpers.mjs';
import { demo } from '../src/seed.mjs';
import { Worker } from '../src/worker.mjs';
import { createApiServer } from '../src/server.mjs';
import { createTask,getTask,transitionTask } from '../src/tasks.mjs';
import { addRule,setPermissionMode } from '../src/permissions.mjs';
import { registerSource,grantSource } from '../src/sources.mjs';
import { hashKey } from '../src/access.mjs';
import { openDatabase } from '../src/database.mjs';

async function rig(mode='ask_every_time') {
  const f=fixture({mode});const received=[];let failOnce=false;
  const recipient=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(failOnce?503:200,{'Content-Type':'application/json'});failOnce=false;res.end('{"accepted":true}');
  });
  const webhook=await listen(recipient);f.db.prepare('UPDATE entities SET webhook_url=?').run(webhook);
  const api=createApiServer(f.db);const base=await listen(api);
  const worker=new Worker(f.db,{replyBase:base,backoffMs:10});
  const request=async(path,body={},headers={})=>{
    const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  return {...f,received,worker,base,request,failNext:()=>{failOnce=true;},async finish(){await closeServer(api);await closeServer(recipient);f.close();}};
}
const taskDeny=()=>({subject_entity_id:'*',resource_type:'task',resource_id:'*',action:'execute',effect:'deny',priority:-100,note:'deny execution'});

test('ask pauses with zero POSTs; human approval resumes; repeated approval and transport retry reuse one decision',async()=>{
  const f=await rig();
  try {
    const created=await f.request('/v1/tasks',f.body);assert.equal(created.status,201);const id=created.body.data.id;
    await f.worker.tick();assert.equal(getTask(f.db,f.owner,id).state,'awaiting_approval');assert.equal(f.received.length,0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM context_packages').get().n,0);
    assert.equal(getTask(f.db,f.owner,id).approvals[0].status,'pending');
    assert.equal(await f.worker.tick(),false);assert.equal(f.db.prepare('SELECT count(*) AS n FROM approvals').get().n,1);
    const approved=await f.request(`/v1/tasks/${id}/approve`);assert.equal(approved.status,200);assert.equal(approved.body.data.state,'working');
    assert.equal((await f.request(`/v1/tasks/${id}/approve`)).status,200);
    f.failNext();await f.worker.tick();assert.equal(f.received.length,1);
    f.db.prepare('UPDATE job_queue SET available_at=0').run();await f.worker.tick();
    assert.equal(f.received.length,2);assert.equal(f.received[0].idempotency_key,f.received[1].idempotency_key);
    assert.equal(getTask(f.db,f.owner,id).delivery_receipt,'accepted_for_execution');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM approvals').get().n,1);
    assert.ok(f.db.prepare("SELECT 1 FROM audit_log WHERE action='approval.use' AND decision='allow'").get());
    assert.equal((await f.request(`/v1/tasks/${id}/transition`,{to_state:'completed'})).status,200);
  } finally {await f.finish();}
});

test('entity and member cannot approve; rejection cancels durably and cannot later be approved',async()=>{
  const f=await rig();let memberServer;
  try {
    const {task}=createTask(f.db,f.owner,f.body);await f.worker.tick();
    f.db.prepare('INSERT INTO entity_credentials VALUES (?,?,?,?,NULL)').run('approval-key',demo.research,hashKey('approval-test-key'),new Date().toISOString());
    assert.equal((await f.request(`/v1/tasks/${task.id}/approve`,{},{Authorization:'Bearer approval-test-key'})).status,403);
    f.db.prepare('INSERT INTO users VALUES (?,?)').run('member','Member');
    f.db.prepare("INSERT INTO workspace_members VALUES (?,?,'member')").run(demo.workspace,'member');
    memberServer=createApiServer(f.db,{localUserId:'member'});const memberBase=await listen(memberServer);
    const memberReply=await fetch(`${memberBase}/v1/tasks/${task.id}/approve`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(memberReply.status,403);await memberReply.json();
    const rejected=await f.request(`/v1/tasks/${task.id}/reject`);assert.equal(rejected.status,200);assert.equal(rejected.body.data.state,'cancelled');
    assert.equal((await f.request(`/v1/tasks/${task.id}/reject`)).status,200);
    assert.equal((await f.request(`/v1/tasks/${task.id}/approve`)).status,409);
    const fresh=openDatabase(f.path);
    try {assert.equal(await new Worker(fresh,{replyBase:f.base}).tick(),false);} finally {fresh.close();}
    assert.equal(f.received.length,0);
    assert.ok(f.db.prepare("SELECT 1 FROM audit_log WHERE reason='approval_rejected' AND decision='deny'").get());
    const last=f.db.prepare("SELECT details FROM task_events WHERE task_id=? AND to_state='cancelled'").get(task.id);
    assert.equal(JSON.parse(last.details).reason,'approval_rejected');
  } finally {if(memberServer)await closeServer(memberServer);await f.finish();}
});

test('every recipient needs private-source access; authorized package includes only same-conversation history',async()=>{
  const f=await rig('full_access_workspace');
  try {
    const source=registerSource(f.db,f.owner,demo.workspace);grantSource(f.db,f.owner,source.id,demo.research);
    const body={...f.body,recipient_entity_ids:[demo.research,demo.writing],context_package:{facts:['Explicit shared fact'],source_refs:[source.id],
      constraints:['Use citations'],expected_output:{format:'summary'},history_slice:[{body:'FORGED HISTORY'}]}};
    assert.throws(()=>createTask(f.db,f.owner,body),e=>e.status===403);
    assert.equal(f.received.length,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM context_packages').get().n,0);
    grantSource(f.db,f.owner,source.id,demo.writing);
    f.db.prepare('INSERT INTO messages(id,workspace_id,conversation_id,author_user_id,body,created_at) VALUES (?,?,?,?,?,?)')
      .run('real-message',demo.workspace,demo.group,demo.user,'Real conversation context',new Date().toISOString());
    f.db.prepare("INSERT INTO conversations(id,workspace_id,kind,name) VALUES (?,?,'group','Other group')").run('other-group',demo.workspace);
    f.db.prepare('INSERT INTO messages(id,workspace_id,conversation_id,author_user_id,body,created_at) VALUES (?,?,?,?,?,?)')
      .run('other-message',demo.workspace,'other-group',demo.user,'OTHER GROUP PRIVATE HISTORY',new Date().toISOString());
    const {task}=createTask(f.db,f.owner,body);await f.worker.tick();await f.worker.tick();
    assert.equal(f.received.length,2);
    for(const delivery of f.received) {
      const ctx=delivery.context_package;
      assert.deepEqual(Object.keys(ctx).sort(),['constraints','expected_output','facts','goal','history_slice','source_refs']);
      assert.deepEqual(ctx.source_refs,[source.id]);assert.deepEqual(ctx.facts,['Explicit shared fact']);
      assert.equal(ctx.history_slice.length,1);assert.equal(ctx.history_slice[0].body,'Real conversation context');
      assert.ok(!JSON.stringify(ctx).includes('FORGED'));assert.ok(!JSON.stringify(ctx).includes('OTHER GROUP'));
    }
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM context_packages WHERE task_id=?').get(task.id).n,2);
    assert.ok(!Object.hasOwn(getTask(f.db,{kind:'entity',entity_id:demo.research},task.id),'context_input'));
  } finally {await f.finish();}
});

test('source grant revoked while awaiting approval blocks the approval without losing denial audit',async()=>{
  const f=await rig();
  try {
    const source=registerSource(f.db,{kind:'entity',entity_id:demo.writing},demo.workspace);grantSource(f.db,f.owner,source.id,demo.research);
    const {task}=createTask(f.db,f.owner,{...f.body,context_package:{source_refs:[source.id]}});await f.worker.tick();
    f.db.prepare('DELETE FROM source_grants WHERE source_id=?').run(source.id);
    const decision=await f.request(`/v1/tasks/${task.id}/approve`);
    assert.equal(decision.status,403);assert.equal(getTask(f.db,f.owner,task.id).state,'awaiting_approval');
    assert.equal(f.received.length,0);
    assert.ok(f.db.prepare("SELECT 1 FROM audit_log WHERE action='approval.approved' AND decision='deny' AND reason='source_not_shared_with_recipient'").get());
    assert.equal((await f.request(`/v1/tasks/${task.id}/reject`)).status,200);
  } finally {await f.finish();}
});

test('explicit deny added after approval is rechecked before dispatch',async()=>{
  const f=await rig();
  try {
    const {task}=createTask(f.db,f.owner,f.body);await f.worker.tick();
    assert.equal((await f.request(`/v1/tasks/${task.id}/approve`)).status,200);
    addRule(f.db,f.owner,demo.workspace,taskDeny());
    await f.worker.tick();assert.equal(f.received.length,0);
    assert.equal(getTask(f.db,f.owner,task.id).state,'failed');
    assert.equal(getTask(f.db,f.owner,task.id).blocked_reason,'explicit_deny');
    assert.ok(f.db.prepare("SELECT 1 FROM audit_log WHERE reason='explicit_deny' AND decision='deny'").get());
    f.db.prepare("DELETE FROM permission_rules WHERE mode='standing_rules'").run();
    const retry=transitionTask(f.db,f.owner,task.id,{to_state:'queued'});
    assert.equal(retry.blocked_reason,null);
    await f.worker.tick();assert.equal(getTask(f.db,f.owner,task.id).state,'awaiting_approval');
    assert.equal(f.received.length,0);
  } finally {await f.finish();}
});

test('changed rule fingerprint makes an approval stale; a new attempt cannot reuse an earlier approval',async()=>{
  const f=await rig();
  try {
    const stale=createTask(f.db,f.owner,f.body).task;await f.worker.tick();
    addRule(f.db,f.owner,demo.workspace,{subject_entity_id:demo.research,resource_type:'task',resource_id:stale.id,action:'execute',effect:'ask',priority:100});
    assert.equal((await f.request(`/v1/tasks/${stale.id}/approve`)).status,409);
    assert.equal((await f.request(`/v1/tasks/${stale.id}/reject`)).status,200);
    const {task}=createTask(f.db,f.owner,f.body);await f.worker.tick();await f.request(`/v1/tasks/${task.id}/approve`);
    transitionTask(f.db,f.owner,task.id,{to_state:'failed',reason:'manual_acceptance_failure'});
    transitionTask(f.db,f.owner,task.id,{to_state:'queued'});await f.worker.tick();
    assert.equal(getTask(f.db,f.owner,task.id).attempt,2);assert.equal(getTask(f.db,f.owner,task.id).state,'awaiting_approval');
    const decisions=f.db.prepare('SELECT status,attempt FROM approvals WHERE task_id=? ORDER BY attempt').all(task.id);
    assert.deepEqual(decisions.map(x=>({...x})),[{status:'approved',attempt:1},{status:'pending',attempt:2}]);
    assert.equal(f.received.length,0);
  } finally {await f.finish();}
});
