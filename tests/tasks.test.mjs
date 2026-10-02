import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTask,transitionTask,getTask,transitions } from '../src/tasks.mjs';
import { fixture,listen,closeServer } from './helpers.mjs';
import { createApiServer } from '../src/server.mjs';
import { demo } from '../src/seed.mjs';
import { hashKey } from '../src/access.mjs';

test('ADR-003 transition matrix, event atomicity, manual retry and approval guard',()=>{
  const f=fixture();
  try {
    const states=Object.keys(transitions); let count=0;
    for (const from of states) for (const to of states) {
      const {task}=createTask(f.db,f.owner,f.body);
      f.db.prepare('UPDATE tasks SET state=? WHERE id=?').run(from,task.id);
      const before=f.db.prepare('SELECT count(*) AS n FROM task_events WHERE task_id=?').get(task.id).n;
      const options=from==='awaiting_approval'?{approvalDecision:to==='working'?'approved':'rejected'}:{};
      if (transitions[from].includes(to)) {
        const result=transitionTask(f.db,f.owner,task.id,{to_state:to},options);
        assert.equal(result.state,to);
        assert.equal(result.attempt,from==='failed'?2:1);
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_events WHERE task_id=?').get(task.id).n,before+1);
        const event=f.db.prepare("SELECT * FROM task_events WHERE task_id=? AND from_state=? AND to_state=? ORDER BY rowid DESC LIMIT 1").get(task.id,from,to);
        assert.ok(event);
        if (from==='awaiting_approval' && to==='cancelled') assert.equal(JSON.parse(event.details).reason,'approval_rejected');
      } else {
        assert.throws(()=>transitionTask(f.db,f.owner,task.id,{to_state:to},options),e=>e.status===422);
        assert.equal(getTask(f.db,f.owner,task.id).state,from);
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_events WHERE task_id=?').get(task.id).n,before);
      }
      count++;
    }
    assert.equal(count,64);
    const {task}=createTask(f.db,f.owner,f.body);
    f.db.prepare("UPDATE tasks SET state='awaiting_approval' WHERE id=?").run(task.id);
    assert.throws(()=>transitionTask(f.db,f.owner,task.id,{to_state:'working'}),e=>e.code==='approval_required');
    f.db.prepare("UPDATE tasks SET state='failed' WHERE id=?").run(task.id);
    assert.throws(()=>transitionTask(f.db,{kind:'entity',entity_id:demo.research},task.id,{to_state:'queued'}),e=>e.code==='manual_retry_required');
  } finally { f.close(); }
});

test('creation is idempotent, recipient list deduplicates, and explicit retry changes delivery scope',()=>{
  const f=fixture();
  try {
    const body={...f.body,recipient_entity_ids:[demo.research,demo.writing,demo.research]};
    const first=createTask(f.db,f.owner,body,'same-request');
    const replay=createTask(f.db,f.owner,body,'same-request');
    assert.equal(replay.created,false);assert.equal(replay.task.id,first.task.id);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get().n,1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM job_queue').get().n,2);
    assert.throws(()=>createTask(f.db,f.owner,{...body,goal:'different'},'same-request'),e=>e.status===409);
    const keys=f.db.prepare('SELECT idempotency_key FROM job_queue').all().map(r=>r.idempotency_key);
    assert.ok(keys.every(key=>key.startsWith(`${first.task.id}:1:webhook:`)));
    transitionTask(f.db,f.owner,first.task.id,{to_state:'working'});
    transitionTask(f.db,f.owner,first.task.id,{to_state:'failed'});
    transitionTask(f.db,f.owner,first.task.id,{to_state:'queued'});
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM job_queue WHERE status='pending'").get().n,2);
    const retry=f.db.prepare("SELECT idempotency_key FROM job_queue WHERE status='pending'").all();
    assert.ok(retry.every(r=>r.idempotency_key.startsWith(`${first.task.id}:2:webhook:`)));
  } finally { f.close(); }
});

test('task API JSON contract, cancel/stop, bearer identity and blocked approval bypass',async()=>{
  const f=fixture();const server=createApiServer(f.db);const base=await listen(server);
  try {
    const api=async(path,{method='GET',body,headers={}}={})=>{
      const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});
      return {status:res.status,body:await res.json()};
    };
    const created=await api('/v1/tasks',{method:'POST',body:f.body,headers:{'Idempotency-Key':'api-test'}});
    assert.equal(created.status,201); const id=created.body.data.id;
    assert.equal(created.body.data.state,'queued');
    const replay=await api('/v1/tasks',{method:'POST',body:f.body,headers:{'Idempotency-Key':'api-test'}});
    assert.equal(replay.status,200);assert.equal(replay.body.data.id,id);
    const invalid=await api(`/v1/tasks/${id}/transition`,{method:'POST',body:{to_state:'completed'}});
    assert.equal(invalid.status,422);assert.equal(invalid.body.error.code,'invalid_transition');
    const cancelled=await api(`/v1/tasks/${id}/transition`,{method:'POST',body:{to_state:'cancelled',reason:'stopped_by_user'}});
    assert.equal(cancelled.status,200);assert.equal(cancelled.body.data.state,'cancelled');
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM job_queue WHERE status='cancelled'").get().n,1);
    assert.equal((await api(`/v1/tasks/${id}`)).body.data.state,'cancelled');
    assert.equal((await api(`/v1/tasks/${id}`,{headers:{Authorization:'Bearer invalid'}})).status,401);
    assert.equal((await api('/v1/tasks',{method:'POST',body:f.body,headers:{Origin:'https://untrusted.example'}})).status,403);
    f.db.prepare('INSERT INTO entity_credentials VALUES (?,?,?,?,NULL)').run('research-key',demo.research,hashKey('research-test-key'),new Date().toISOString());
    f.db.prepare('INSERT INTO entity_credentials VALUES (?,?,?,?,NULL)').run('writing-key',demo.writing,hashKey('writing-test-key'),new Date().toISOString());
    const next=await api('/v1/tasks',{method:'POST',body:f.body});const nextId=next.body.data.id;
    const foreign=await api(`/v1/tasks/${nextId}/transition`,{method:'POST',body:{to_state:'working'},headers:{Authorization:'Bearer writing-test-key'}});
    assert.equal(foreign.status,403);
    const assigned=await api(`/v1/tasks/${nextId}/transition`,{method:'POST',body:{to_state:'working'},headers:{Authorization:'Bearer research-test-key'}});
    assert.equal(assigned.status,200);
    await api(`/v1/tasks/${nextId}/transition`,{method:'POST',body:{to_state:'awaiting_approval'}});
    const bypass=await api(`/v1/tasks/${nextId}/transition`,{method:'POST',body:{to_state:'working',approvalDecision:'approved'}});
    assert.equal(bypass.status,422);
    assert.equal((await api(`/v1/tasks/${nextId}`)).body.data.state,'awaiting_approval');
  } finally { await closeServer(server);f.close(); }
});
