import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture,listen,closeServer } from './helpers.mjs';
import { createApiServer } from '../src/server.mjs';
import { demo } from '../src/seed.mjs';
import { hashKey } from '../src/access.mjs';
import { createTask,transitionTask,getTask } from '../src/tasks.mjs';
import { Worker } from '../src/worker.mjs';

async function setup(){const f=fixture();const server=createApiServer(f.db),base=await listen(server);
  for(const [id,key] of [[demo.research,'research-key'],[demo.writing,'writing-key']])f.db.prepare('INSERT INTO entity_credentials VALUES (?,?,?,?,NULL)').run(id,id,hashKey(key),new Date().toISOString());
  return {...f,base,async request(path,body,key){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(key?{Authorization:`Bearer ${key}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};},async finish(){await closeServer(server);f.close();}};}

test('ADR-005 dashboard pagination, filters and approval lists preserve human/tenant boundary',async()=>{
  const f=await setup();try{
    createTask(f.db,f.owner,{...f.body,goal:'Human request'});
    createTask(f.db,{kind:'entity',entity_id:demo.writing},{...f.body,goal:'Entity request'});
    const page=await f.request('/v1/tasks?limit=1&offset=1');assert.equal(page.status,200);assert.equal(page.body.data.items.length,1);assert.equal(page.body.data.total,2);assert.ok(!('context_input' in page.body.data.items[0]));
    assert.equal((await f.request(`/v1/tasks?requester=${demo.writing}&assignee=${demo.research}&status=queued`)).body.data.total,1);
    assert.equal((await f.request('/v1/tasks?limit=0')).status,422);
    assert.equal((await f.request('/v1/tasks?status=invalid')).status,422);
    assert.equal((await f.request('/v1/tasks',undefined,'research-key')).status,403);
    assert.equal((await f.request('/v1/approvals?state=pending',undefined,'research-key')).status,403);
    assert.deepEqual((await f.request('/v1/approvals?state=pending')).body.data,[]);
    const outsider=createApiServer(f.db,{localUserId:'outsider'});const outsiderBase=await listen(outsider);
    try{assert.equal((await fetch(outsiderBase+'/v1/tasks')).status,403);}finally{await closeServer(outsider);}
  }finally{await f.finish();}
});

test('conversation/message shapes, orchestrator selection, sender attribution and task result isolation',async()=>{
  const f=await setup();try{
    const payload={type:'group',title:'Launch team',member_ids:[demo.research,demo.writing,demo.research],orchestrator_entity_id:demo.research};
    const created=await f.request('/v1/conversations',payload);assert.equal(created.status,201);const c=created.body.data;
    assert.equal(c.type,'group');assert.deepEqual(c.member_ids,[demo.research,demo.writing]);assert.equal(c.orchestrator_entity_id,demo.research);assert.ok(c.created_at);
    f.db.prepare("UPDATE entities SET connection_type='B' WHERE id=?").run(demo.writing);
    assert.equal((await f.request('/v1/conversations',{...payload,orchestrator_entity_id:demo.writing})).status,422);
    assert.equal((await f.request('/v1/conversations',{...payload,member_ids:['foreign']})).status,422);
    const dm=(await f.request('/v1/conversations',{type:'dm',title:'Private DM',member_ids:[demo.research]})).body.data;
    assert.equal((await f.request(`/v1/conversations/${dm.id}/messages`,{body:'Intrusion'},'writing-key')).status,403);
    assert.ok(!(await f.request('/v1/conversations',undefined,'writing-key')).body.data.some(c=>c.id===dm.id));
    const message=await f.request(`/v1/conversations/${c.id}/messages`,{body:'<script>window.pwned=true</script>',sender:demo.writing});
    assert.equal(message.body.data.sender,'human');assert.equal(message.body.data.kind,'chat');
    const {task}=createTask(f.db,f.owner,{...f.body,conversation_id:c.id});
    assert.equal((await f.request(`/v1/conversations/${c.id}/messages`,{body:'Forged result',kind:'task_result',task_id:task.id},'writing-key')).status,403);
    const result=await f.request(`/v1/conversations/${c.id}/messages`,{body:'Tool output',kind:'task_result',task_id:task.id,parent_message_id:message.body.data.id},'research-key');
    assert.equal(result.status,201);assert.equal(result.body.data.sender,demo.research);
    assert.equal((await f.request(`/v1/conversations/${dm.id}/messages`,{body:'Wrong conversation',task_id:task.id})).status,422);
    const items=(await f.request('/v1/inbox',undefined,'research-key')).body.data;assert.ok(items.some(i=>i.kind==='task'&&i.ref_id===task.id));assert.ok(items.some(i=>i.kind==='message'));
    for(const item of items)assert.deepEqual(Object.keys(item).sort(),['created_at','kind','ref_id','summary']);
  }finally{await f.finish();}
});

test('ADR-005 requester may cancel or resume input_required, never complete or approve another assignee task',async()=>{
  const f=await setup();try{
    const requester={kind:'entity',entity_id:demo.writing};const {task}=createTask(f.db,requester,f.body);
    transitionTask(f.db,f.owner,task.id,{to_state:'working'});transitionTask(f.db,f.owner,task.id,{to_state:'input_required'});
    assert.equal((await f.request(`/v1/tasks/${task.id}/transition`,{to_state:'completed'},'writing-key')).status,403);
    assert.equal((await f.request(`/v1/conversations/${demo.group}/messages`,{kind:'chat',task_id:task.id,body:'Here is the requested clarification'},'writing-key')).status,201);
    assert.equal((await f.request(`/v1/tasks/${task.id}/transition`,{to_state:'working',reason:'Clarification supplied'},'writing-key')).status,200);
    transitionTask(f.db,f.owner,task.id,{to_state:'awaiting_approval'});
    for(const key of ['research-key','writing-key'])for(const decision of ['approve','reject'])assert.equal((await f.request(`/v1/tasks/${task.id}/${decision}`,{},key)).status,403);
    assert.equal((await f.request(`/v1/tasks/${task.id}/transition`,{to_state:'cancelled',reason:'requester_stop'},'writing-key')).status,200);
    assert.equal(getTask(f.db,f.owner,task.id).state,'cancelled');assert.equal(await new Worker(f.db).tick(),false);
    assert.ok(f.db.prepare("SELECT 1 FROM audit_log WHERE actor_entity_id=? AND action='task.transition' AND reason='requester_stop'").get(demo.writing));
  }finally{await f.finish();}
});

test('dashboard serves only local static assets with content security policy',async()=>{
  const f=await setup();try{
    const page=await fetch(f.base);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);assert.match(await page.text(),/SignalDesk/);
    assert.equal((await fetch(f.base+'/app.js')).status,200);
    assert.equal((await fetch(f.base+'/db/migrations/001_core.sql')).status,404);
    assert.equal((await fetch(f.base+'/v1/tasks',{headers:{Origin:'https://untrusted.example'}})).status,403);
  }finally{await f.finish();}
});
