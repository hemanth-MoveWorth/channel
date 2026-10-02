import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { transaction } from './database.mjs';
import { move,rawTask,recordEvent,now,enforceExecution } from './tasks.mjs';

export function loopbackUrl(value) {
  const url=new URL(value);
  if (!['http:','https:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('Phase 0 delivery requires a loopback URL without credentials.');
  }
  return url;
}
export class Worker {
  constructor(db,{replyBase='http://127.0.0.1:3000',leaseMs=30000,timeoutMs=5000,pollMs=100,backoffMs=250}={}) {
    this.db=db; this.replyBase=loopbackUrl(replyBase).origin;
    this.leaseMs=leaseMs; this.timeoutMs=timeoutMs; this.pollMs=pollMs; this.backoffMs=backoffMs;
    if (leaseMs<=timeoutMs || [leaseMs,timeoutMs,pollMs,backoffMs].some(n=>!Number.isFinite(n)||n<=0)) throw new Error('Worker lease must exceed request timeout; all durations must be positive.');
  }
  claim() {
    const db=this.db;
    return transaction(db,()=>{
      const time=Date.now();
      const job=db.prepare(`SELECT q.* FROM job_queue q JOIN tasks t ON t.id=q.task_id
        WHERE ((q.status='pending' AND q.available_at<=?) OR (q.status='leased' AND q.lease_until<=?))
          AND t.state IN ('queued','working') ORDER BY q.available_at,q.id LIMIT 1`).get(time,time);
      if (!job) return null;
      const token=randomUUID();
      db.prepare("UPDATE job_queue SET status='leased',lease_token=?,lease_until=?,tries=tries+1 WHERE id=?")
        .run(token,time+this.leaseMs,job.id);
      let task=rawTask(db,job.task_id);
      if (task.state==='queued') task=move(db,task,'working',null);
      const delivered=db.prepare("SELECT 1 FROM deliveries WHERE idempotency_key=? AND status='delivered'").get(job.idempotency_key);
      if (delivered) {
        db.prepare("UPDATE job_queue SET status='done',lease_token=NULL,lease_until=NULL WHERE id=?").run(job.id);
        return {skipped:true};
      }
      const gate=enforceExecution(db,task);
      if(gate.effect!=='allow')return {skipped:true};
      db.prepare(`INSERT INTO deliveries VALUES (?,?,?,?,'pending',NULL,?) ON CONFLICT(idempotency_key) DO NOTHING`)
        .run(job.idempotency_key,job.task_id,job.action,job.recipient_entity_id,now());
      return {...job,lease_token:token,tries:job.tries+1,task,context:gate.packages[job.recipient_entity_id]};
    });
  }
  async tick() {
    const job=this.claim();
    if (!job) return false;
    if (job.skipped) return true;
    const db=this.db;
    const abort=new AbortController();
    const timeout=setTimeout(()=>abort.abort(),this.timeoutMs);
    // A stop/pause prevents future delivery and aborts a currently waiting POST.
    // An effect already committed by a recipient cannot be undone by cancellation.
    const watch=setInterval(()=>{
      const task=rawTask(db,job.task_id);
      if (['cancelled','failed'].includes(task.state) || task.attempt!==job.task.attempt) abort.abort();
    },Math.min(50,this.pollMs));
    try {
      const task=rawTask(db,job.task_id);
      if (task.state!=='working') throw new Error('Task no longer working.');
      const entity=db.prepare('SELECT webhook_url,connection_type FROM entities WHERE id=? AND workspace_id=?').get(job.recipient_entity_id,job.workspace_id);
      if (!entity || entity.connection_type!=='A' || !entity.webhook_url) throw new Error('No type A webhook.');
      const url=loopbackUrl(entity.webhook_url);
      if (url.origin===this.replyBase) throw new Error('Webhook cannot target the trusted local control API.');
      const context=job.context;
      const response=await fetch(url,{method:'POST',redirect:'error',signal:abort.signal,
        headers:{'Content-Type':'application/json','Idempotency-Key':job.idempotency_key},
        body:JSON.stringify({task_id:task.id,kind:'task',context_package:context,idempotency_key:job.idempotency_key,
          reply_to:`${this.replyBase}/v1/tasks/${encodeURIComponent(task.id)}/transition`})});
      if (response.status!==200) throw new Error('Webhook did not acknowledge.');
      // ACK schema is tiny. Do not persist or log arbitrary provider content.
      let body='';
      for await (const chunk of response.body) {
        body+=Buffer.from(chunk).toString('utf8');
        if (body.length>4096) { abort.abort(); throw new Error('ACK too large.'); }
      }
      if (JSON.parse(body).accepted!==true) throw new Error('Invalid ACK.');
      transaction(db,()=>{
        const lease=db.prepare("SELECT 1 FROM job_queue WHERE id=? AND status='leased' AND lease_token=?").get(job.id,job.lease_token);
        const latest=rawTask(db,job.task_id);
        // A fast recipient may finish via reply_to before it ACKs this POST.
        // Its completion cancels outstanding jobs, but this same attempt's ACK
        // still proves delivery. Never revive a cancelled or manually retried task.
        const completedBeforeAck=latest.state==='completed' && latest.attempt===task.attempt &&
          db.prepare("SELECT 1 FROM job_queue WHERE id=? AND status='cancelled'").get(job.id);
        if (!lease && !completedBeforeAck) return;
        db.prepare("UPDATE deliveries SET status='delivered',response=? WHERE idempotency_key=?").run('{"accepted":true}',job.idempotency_key);
        db.prepare("UPDATE job_queue SET status='done',lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=?").run(job.id);
        const pending=db.prepare("SELECT count(*) AS n FROM job_queue WHERE task_id=? AND idempotency_key LIKE ? AND status<>'done'")
          .get(task.id,`${task.id}:${task.attempt}:%`).n;
        if (pending===0) {
          const current=rawTask(db,task.id);
          if (current.delivery_receipt==='stored') {
            db.prepare("UPDATE tasks SET delivery_receipt='delivered' WHERE id=?").run(task.id);
            recordEvent(db,current,'delivery_receipt',null,null,{from:'stored',to:'delivered',attempt:task.attempt});
          }
          if (current.delivery_receipt!=='accepted_for_execution') {
            db.prepare("UPDATE tasks SET delivery_receipt='accepted_for_execution' WHERE id=?").run(task.id);
            recordEvent(db,current,'delivery_receipt',null,null,{from:'delivered',to:'accepted_for_execution',attempt:task.attempt});
          }
        }
      });
    } catch {
      // Fixed error code, no URL, request, response, API key, or context logging.
      const backoff=Math.min(30000,this.backoffMs*2**Math.min(job.tries-1,10));
      db.prepare(`UPDATE job_queue SET status='pending',lease_token=NULL,lease_until=NULL,available_at=?,last_error='delivery_not_acknowledged'
        WHERE id=? AND status='leased' AND lease_token=?`).run(Date.now()+backoff,job.id,job.lease_token);
    } finally { clearTimeout(timeout); clearInterval(watch); }
    return true;
  }
  async run(signal) {
    while (!signal.aborted) {
      await this.tick();
      try { await delay(this.pollMs,undefined,{signal}); } catch { break; }
    }
  }
}
