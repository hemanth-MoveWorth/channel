import { randomUUID,createHash } from 'node:crypto';
import { transaction } from './database.mjs';
import { authorize } from './access.mjs';
import { AppError } from './errors.mjs';
import { contextInput,taskResource,evaluateTaskPlan } from './context.mjs';
import { auditDecision } from './audit.mjs';

export const transitions=Object.freeze({
  submitted:['queued','cancelled'], queued:['working','cancelled'],
  working:['input_required','awaiting_approval','completed','failed','cancelled'],
  input_required:['working','cancelled'], awaiting_approval:['working','cancelled'],
  failed:['queued'], completed:[], cancelled:[],
});
export const now=()=>new Date().toISOString();
export function text(value,name) {
  if (typeof value!=='string' || !value.trim() || value.length>65536) throw new AppError(422,'invalid_request',`${name} must be a nonempty string.`);
  return value;
}
export function rawTask(db,id) {
  const task=db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!task) throw new AppError(404,'not_found','Task not found.');
  return task;
}
export function publicTask(task) {
  const {request_hash,context_input,...row}=task;
  return {...row,recipient_entity_ids:JSON.parse(row.recipient_entity_ids),result:row.result?JSON.parse(row.result):null};
}
export function getTask(db,actor,id) {
  const task=rawTask(db,id);
  authorize(db,actor,task.workspace_id,'tasks:read',{conversationId:task.conversation_id});
  const data=publicTask(task);
  if(actor.kind==='human')data.approvals=db.prepare('SELECT id,action,status,attempt,decided_at,created_at FROM approvals WHERE task_id=? ORDER BY created_at,id').all(id)
    .map(row=>({...row,action:JSON.parse(row.action)}));
  return data;
}
export function recordEvent(db,task,eventType,fromState,toState,details={}) {
  db.prepare(`INSERT INTO task_events VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(),task.workspace_id,task.id,
    eventType,fromState,toState,JSON.stringify(details),now());
}
function audit(db,task,actor,action,reason) {
  db.prepare(`INSERT INTO audit_log VALUES (?,?,?,?,?,?,?,?,?)`).run(randomUUID(),task.workspace_id,
    actor?.kind==='human'?actor.user_id:null,actor?.kind==='entity'?actor.entity_id:null,task.id,action,'allow',reason,now());
}
export const deliveryKey=(task,recipient)=>`${task.id}:${task.attempt}:webhook:${recipient}`;
export function enqueue(db,task) {
  for (const recipient of JSON.parse(task.recipient_entity_ids)) {
    db.prepare(`INSERT INTO job_queue(id,workspace_id,task_id,recipient_entity_id,action,idempotency_key,available_at)
      VALUES (?,?,?,?,'webhook',?,?) ON CONFLICT(idempotency_key) DO NOTHING`)
      .run(randomUUID(),task.workspace_id,task.id,recipient,deliveryKey(task,recipient),Date.now());
  }
}
// Internal mutation primitive. HTTP and entity callers must use transitionTask;
// the worker uses this only after it has atomically claimed a persisted job.
export function move(db,task,toState,reason,{manualRetry=false,approvalDecision=null,cancelRequested=false,actor=null}={}) {
  if (!transitions[task.state]?.includes(toState)) throw new AppError(422,'invalid_transition',`Cannot transition from ${task.state} to ${toState}.`);
  if (task.state==='failed' && !manualRetry) throw new AppError(422,'manual_retry_required','A failed task can only be retried manually by the local human.');
  if (task.state==='awaiting_approval' && !(cancelRequested && toState==='cancelled')) {
    const required=toState==='working'?'approved':'rejected';
    if (approvalDecision!==required) throw new AppError(422,'approval_required','Use the approval service to decide this task.');
    if (required==='rejected') reason='approval_rejected';
  }
  const nextAttempt=task.attempt+(task.state==='failed'?1:0);
  db.prepare('UPDATE tasks SET state=?,attempt=? WHERE id=?').run(toState,nextAttempt,task.id);
  recordEvent(db,task,'transition',task.state,toState,{reason:reason??null,attempt:nextAttempt});
  const updated=rawTask(db,task.id);
  if (toState==='queued') {
    if (task.state==='failed') db.prepare("UPDATE tasks SET delivery_receipt='stored',blocked_reason=NULL WHERE id=?").run(task.id);
    enqueue(db,updated);
  }
  if (['completed','failed','cancelled'].includes(toState)) {
    db.prepare("UPDATE job_queue SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE task_id=? AND status IN ('pending','leased')").run(task.id);
  }
  audit(db,task,actor,'task.transition',reason??toState);
  return rawTask(db,task.id);
}
export function transitionTask(db,actor,id,{to_state,reason},options={}) {
  const task=rawTask(db,id);
  const requesterRight=actor.kind==='entity'&&actor.entity_id===task.requester_entity_id&&
    (to_state==='cancelled'||(task.state==='input_required'&&to_state==='working'));
  if(requesterRight)authorize(db,actor,task.workspace_id,'profiles:read');
  else authorize(db,actor,task.workspace_id,'tasks:control',{assignedEntityId:task.assigned_entity_id});
  if (options.approvalDecision) authorize(db,actor,task.workspace_id,'approvals:decide');
  text(to_state,'to_state');
  if (reason!==undefined && reason!==null) text(reason,'reason');
  return transaction(db,()=>publicTask(move(db,rawTask(db,id),to_state,reason,
    {manualRetry:actor.kind==='human',approvalDecision:options.approvalDecision,cancelRequested:requesterRight&&to_state==='cancelled',actor})));
}
export function createTask(db,actor,body,idempotencyKey=randomUUID()) {
  const workspace=text(body.workspace_id,'workspace_id');
  const conversation=text(body.conversation_id,'conversation_id');
  authorize(db,actor,workspace,'tasks:create',{conversationId:conversation});
  if (!db.prepare('SELECT 1 FROM conversations WHERE id=? AND workspace_id=?').get(conversation,workspace)) throw new AppError(422,'invalid_request','Conversation is not in this workspace.');
  const goal=text(body.goal,'goal'); text(idempotencyKey,'Idempotency-Key');
  const resource=taskResource(body);const context=contextInput(body.context_package);
  const supplied=body.recipient_entity_ids??[body.assigned_entity_id];
  if (!Array.isArray(supplied) || !supplied.length || supplied.length>100) throw new AppError(422,'invalid_request','Supply 1–100 recipient entity IDs.');
  const recipients=[...new Set(supplied.map(id=>text(id,'recipient entity ID')))].sort();
  const assigned=text(body.assigned_entity_id??recipients[0],'assigned_entity_id');
  if (!recipients.includes(assigned)) throw new AppError(422,'invalid_request','Assigned entity must be a recipient.');
  for (const id of recipients) {
    if (!db.prepare('SELECT 1 FROM conversation_members WHERE workspace_id=? AND conversation_id=? AND entity_id=?').get(workspace,conversation,id)) {
      throw new AppError(422,'invalid_request','Every recipient must be a member of this conversation.');
    }
  }
  const requestHash=createHash('sha256').update(JSON.stringify([actor.kind,actor.user_id??actor.entity_id,workspace,conversation,goal,assigned,recipients,resource,context])).digest('hex');
  const outcome=transaction(db,()=>{
    const prior=db.prepare('SELECT * FROM tasks WHERE workspace_id=? AND idempotency_key=?').get(workspace,idempotencyKey);
    if (prior) {
      if (prior.request_hash!==requestHash) throw new AppError(409,'idempotency_conflict','Idempotency-Key was already used for a different request.');
      auditDecision(db,{workspaceId:workspace,actor,taskId:prior.id,action:'task.replay',decision:prior.blocked_reason?'deny':'allow',reason:prior.blocked_reason??'idempotent_request'});
      return prior.blocked_reason?{denied:prior.blocked_reason}:{task:publicTask(prior),created:false};
    }
    const id=randomUUID();
    db.prepare(`INSERT INTO tasks(id,workspace_id,conversation_id,requester_entity_id,created_by_user_id,assigned_entity_id,goal,
      idempotency_key,created_at,recipient_entity_ids,request_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id,workspace,conversation,
      actor.kind==='entity'?actor.entity_id:null,actor.kind==='human'?actor.user_id:null,assigned,goal,idempotencyKey,now(),JSON.stringify(recipients),requestHash);
    const task=rawTask(db,id);
    db.prepare('UPDATE tasks SET resource_type=?,resource_id=?,action=?,context_input=? WHERE id=?')
      .run(resource.resource_type,resource.resource_id,resource.action,JSON.stringify(context),id);
    recordEvent(db,task,'created',null,'submitted',{attempt:1});
    audit(db,task,actor,'task.create','submitted');
    const current=rawTask(db,id);const plan=evaluateTaskPlan(db,current);
    if(plan.effect==='deny') {
      db.prepare('UPDATE tasks SET blocked_reason=? WHERE id=?').run(plan.reason,id);
      move(db,current,'cancelled',`permission_denied:${plan.reason}`,{actor});
      return {denied:plan.reason};
    }
    return {task:publicTask(move(db,current,'queued','task_created',{actor})),created:true};
  });
  // Keep denial audit/event records even when the HTTP request returns 403.
  if(outcome.denied)throw new AppError(403,'permission_denied',`Request blocked: ${outcome.denied}.`);
  return outcome;
}
