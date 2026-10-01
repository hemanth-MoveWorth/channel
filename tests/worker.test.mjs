import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { openDatabase,transaction } from '../src/database.mjs';
import { createApiServer } from '../src/server.mjs';
import { createTask,transitionTask,getTask } from '../src/tasks.mjs';
import { Worker,loopbackUrl } from '../src/worker.mjs';
import { fixture,listen,closeServer,waitFor } from './helpers.mjs';
import { demo } from '../src/seed.mjs';
import { hashKey } from '../src/access.mjs';

async function stop(child) {
  if (child && child.exitCode===null && child.signalCode===null) {
    const ended=once(child,'exit');child.kill('SIGKILL');await ended;
  }
}
test('kill after recipient commit before ACK, restart, one durable side effect, stable key',async t=>{
  const f=fixture();
  const recipientDb=openDatabase(join(f.dir,'recipient.db'));
  recipientDb.exec('CREATE TABLE effects (idempotency_key TEXT PRIMARY KEY,task_id TEXT NOT NULL); CREATE TABLE received (idempotency_key TEXT NOT NULL)');
  let firstResolve;const firstSeen=new Promise(resolve=>{firstResolve=resolve;});
  const receivedPayloads=[];let hold=true;
  const recipient=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));receivedPayloads.push(input);
    transaction(recipientDb,()=>{
      recipientDb.prepare('INSERT INTO received VALUES (?)').run(input.idempotency_key);
      recipientDb.prepare('INSERT INTO effects VALUES (?,?) ON CONFLICT(idempotency_key) DO NOTHING').run(input.idempotency_key,input.task_id);
    });
    if(hold){hold=false;firstResolve();return;} // Effect committed, ACK deliberately lost.
    res.writeHead(200,{'Content-Type':'application/json'});res.end('{"accepted":true}');
  });
  const webhook=await listen(recipient);
  const api=createApiServer(f.db);const apiBase=await listen(api);
  let worker;let replacement;
  const spawnWorker=()=>spawn(process.execPath,['tests/worker-process.mjs',apiBase],{
    env:{...process.env,SIGNALDESK_DB_PATH:f.path},stdio:['ignore','ignore','pipe'],windowsHide:true,
  });
  try {
    f.db.prepare("UPDATE entities SET webhook_url=? WHERE id=?").run(webhook,demo.research);
    const {task}=createTask(f.db,f.owner,{...f.body,recipient_entity_ids:[demo.research,demo.research]});
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM job_queue').get().n,1);
    worker=spawnWorker();
    await Promise.race([firstSeen,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Worker failed to reach local recipient.')),5000).unref())]);
    await stop(worker);
    assert.equal(recipientDb.prepare('SELECT count(*) AS n FROM effects').get().n,1);
    assert.equal(f.db.prepare('SELECT status FROM deliveries').get().status,'pending');
    assert.equal(f.db.prepare('SELECT status FROM job_queue').get().status,'leased');
    replacement=spawnWorker();
    await waitFor(()=>getTask(f.db,f.owner,task.id).delivery_receipt==='accepted_for_execution');
    await stop(replacement);
    assert.equal(recipientDb.prepare('SELECT count(*) AS n FROM effects').get().n,1);
    assert.equal(recipientDb.prepare('SELECT count(*) AS n FROM received').get().n,2);
    assert.equal(receivedPayloads[0].idempotency_key,receivedPayloads[1].idempotency_key);
    assert.equal(receivedPayloads[0].idempotency_key,`${task.id}:1:webhook:${demo.research}`);
    assert.deepEqual(Object.keys(receivedPayloads[0]).sort(),['context_package','idempotency_key','kind','reply_to','task_id']);
    assert.equal(receivedPayloads[0].reply_to,`${apiBase}/v1/tasks/${task.id}/transition`);
    const receipts=f.db.prepare("SELECT details FROM task_events WHERE task_id=? AND event_type='delivery_receipt' ORDER BY rowid").all(task.id).map(r=>JSON.parse(r.details).to);
    assert.deepEqual(receipts,['delivered','accepted_for_execution']);
    assert.equal(f.db.prepare('SELECT tries FROM job_queue').get().tries,2);
    // Crash/replay after durable ACK must consult deliveries and skip HTTP.
    f.db.prepare("UPDATE job_queue SET status='pending',available_at=0").run();
    await new Worker(f.db,{replyBase:apiBase}).tick();
    assert.equal(recipientDb.prepare('SELECT count(*) AS n FROM received').get().n,2);
    assert.equal(f.db.prepare('SELECT status FROM job_queue').get().status,'done');
    t.diagnostic('Killed real worker after recipient commit; replacement sent the same key twice overall, recipient committed one effect; logged ACK replay made no third POST.');
  } finally {
    await stop(worker);await stop(replacement);await closeServer(recipient);await closeServer(api);recipientDb.close();f.close();
  }
});

test('cancel API prevents pending delivery and surviving in-flight retry',async()=>{
  const f=fixture();let hits=0;let firstResolve;const seen=new Promise(resolve=>{firstResolve=resolve;});
  const recipient=createServer((req,res)=>{hits++;firstResolve();req.resume();});
  const webhook=await listen(recipient);const api=createApiServer(f.db);const base=await listen(api);
  try {
    f.db.prepare('UPDATE entities SET webhook_url=? WHERE id=?').run(webhook,demo.research);
    const worker=new Worker(f.db,{replyBase:base,timeoutMs:300,leaseMs:500,pollMs:20,backoffMs:20});
    const pending=createTask(f.db,f.owner,f.body).task;
    const cancel=async id=>{
      const response=await fetch(`${base}/v1/tasks/${id}/transition`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to_state:'cancelled',reason:'user_stop'})});
      assert.equal(response.status,200);assert.equal((await response.json()).data.state,'cancelled');
    };
    await cancel(pending.id);assert.equal(await worker.tick(),false);assert.equal(hits,0);
    const active=createTask(f.db,f.owner,f.body).task;
    const running=worker.tick();await seen;await cancel(active.id);await running;
    assert.equal(f.db.prepare('SELECT status FROM job_queue WHERE task_id=?').get(active.id).status,'cancelled');
    assert.equal(await worker.tick(),false);assert.equal(hits,1);
  } finally {await closeServer(recipient);await closeServer(api);f.close();}
});

test('non-ACK retries back off with same scope; concurrent claims cannot share a live lease',async()=>{
  const f=fixture();let hits=0;
  const recipient=createServer((req,res)=>{hits++;req.resume();res.writeHead(200,{'Content-Type':'application/json'});res.end('{"accepted":false}');});
  const webhook=await listen(recipient);
  try {
    f.db.prepare('UPDATE entities SET webhook_url=? WHERE id=?').run(webhook,demo.research);
    const {task}=createTask(f.db,f.owner,f.body);
    const worker=new Worker(f.db,{backoffMs:1000});await worker.tick();
    let job=f.db.prepare('SELECT * FROM job_queue').get();
    assert.equal(job.status,'pending');assert.ok(job.available_at>Date.now());assert.equal(job.tries,1);
    assert.equal(getTask(f.db,f.owner,task.id).delivery_receipt,'stored');
    assert.equal(await worker.tick(),false);assert.equal(hits,1);
    f.db.prepare('UPDATE job_queue SET available_at=0').run();
    const claimed=worker.claim();
    const other=openDatabase(f.path);
    try {assert.equal(new Worker(other).claim(),null);} finally {other.close();}
    assert.equal(claimed.idempotency_key,job.idempotency_key);
    assert.throws(()=>loopbackUrl('https://example.com/webhook'));
    assert.throws(()=>loopbackUrl('http://user:password@127.0.0.1/'));
  } finally {await closeServer(recipient);f.close();}
});

test('recipient completion before ACK preserves terminal state and records delivery',async()=>{
  const f=fixture();let callbackStatus;
  f.db.prepare('INSERT INTO entity_credentials VALUES (?,?,?,?,NULL)').run('callback-credential',demo.research,hashKey('callback-test-key'),new Date().toISOString());
  const api=createApiServer(f.db);const base=await listen(api);
  const recipient=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const callback=await fetch(payload.reply_to,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer callback-test-key'},
      body:JSON.stringify({to_state:'completed',reason:'local_result_ready'})});
    callbackStatus=callback.status;await callback.json();
    res.writeHead(200,{'Content-Type':'application/json'});res.end('{"accepted":true}');
  });
  const webhook=await listen(recipient);
  try {
    f.db.prepare('UPDATE entities SET webhook_url=? WHERE id=?').run(webhook,demo.research);
    const {task}=createTask(f.db,f.owner,f.body);
    const worker=new Worker(f.db,{replyBase:base});await worker.tick();
    assert.equal(callbackStatus,200);assert.equal(getTask(f.db,f.owner,task.id).state,'completed');
    assert.equal(getTask(f.db,f.owner,task.id).delivery_receipt,'accepted_for_execution');
    assert.equal(f.db.prepare('SELECT status FROM deliveries').get().status,'delivered');
    assert.equal(await worker.tick(),false);
  } finally {await closeServer(recipient);await closeServer(api);f.close();}
});
