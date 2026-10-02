// Reproducible browser acceptance fixture, not an LLM or production connector.
// Dedicated DB: never changes the default channel.db. Explicit ask-mode setup.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { openDatabase,migrate } from '../src/database.mjs';
import { seed,demo } from '../src/seed.mjs';
import { createApiServer } from '../src/server.mjs';
import { Worker } from '../src/worker.mjs';
import { setPermissionMode } from '../src/permissions.mjs';
import { hashKey } from '../src/access.mjs';
const db=openDatabase(process.env.SIGNALDESK_DB_PATH??'./data/dashboard-demo.db');migrate(db);seed(db);
setPermissionMode(db,{kind:'human',user_id:demo.user},demo.workspace,'*','ask_every_time');
const keys=new Map();
for(const id of [demo.research,demo.writing]){
  const key=randomUUID();keys.set(id,key);db.prepare('UPDATE entity_credentials SET revoked_at=? WHERE entity_id=? AND revoked_at IS NULL').run(new Date().toISOString(),id);
  db.prepare('INSERT INTO entity_credentials VALUES (?,?,?,?,NULL)').run(randomUUID(),id,hashKey(key),new Date().toISOString());
  db.prepare("UPDATE entities SET webhook_url=?,availability='available',description='Local deterministic acceptance tool. Counts words and reports received context; no AI provider.' WHERE id=?").run(`http://127.0.0.1:3001/${id}`,id);
}
async function request(path,key,body){const r=await fetch('http://127.0.0.1:3000'+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${key}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw new Error('Demo callback rejected');return (await r.json()).data;}
const recipient=createServer(async(req,res)=>{try{
  const key=keys.get(req.url.slice(1));if(!key){res.writeHead(404);res.end();return;}
  const chunks=[];for await(const c of req)chunks.push(c);const delivery=JSON.parse(Buffer.concat(chunks));
  const task=await request(`/v1/tasks/${delivery.task_id}`,key);
  const history=await request(`/v1/conversations/${task.conversation_id}/messages`,key);
  // A repeated webhook finds its existing task-linked result before posting again.
  if(!history.some(m=>m.kind==='task_result'&&m.task_id===task.id)){
    const context=delivery.context_package;
    await request(`/v1/conversations/${task.conversation_id}/messages`,key,{kind:'task_result',task_id:task.id,
      body:`Local tool result: counted ${context.goal.trim().split(/\s+/).length} words in your request. Received ${context.history_slice.length} conversation messages and ${context.source_refs.length} authorized source references.\nGoal: ${context.goal}`});
  }
  if(task.state==='working')await request(`/v1/tasks/${task.id}/transition`,key,{to_state:'completed'});
  res.writeHead(200,{'Content-Type':'application/json'});res.end('{"accepted":true}');
}catch{res.writeHead(503);res.end();}});
const api=createApiServer(db);const controller=new AbortController();
await new Promise((resolve,reject)=>{api.once('error',reject);api.listen(3000,'127.0.0.1',resolve);});
await new Promise((resolve,reject)=>{recipient.once('error',reject);recipient.listen(3001,'127.0.0.1',resolve);});
console.log('SignalDesk browser demo: http://127.0.0.1:3000 — local deterministic tools, ask mode.');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>controller.abort());
try{await new Worker(db).run(controller.signal);}finally{api.close();recipient.close();api.closeAllConnections();recipient.closeAllConnections();db.close();}
