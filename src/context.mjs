import { createHash,randomUUID } from 'node:crypto';
import { evaluatePermission,resourceTypes,actions } from './permissions.mjs';
import { sourceAccess } from './sources.mjs';
import { auditDecision } from './audit.mjs';
import { AppError } from './errors.mjs';
import { requesterCategory,assigneeCategory } from './categories.mjs';

export function contextInput(value={}) {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new AppError(422,'invalid_context','Context must be an object.');
  const {facts=[],source_refs=[],constraints=[],expected_output={}}=value;
  for(const [name,list] of Object.entries({facts,source_refs,constraints})) {
    if(!Array.isArray(list)||list.length>100||list.some(x=>typeof x!=='string'||!x.trim()))throw new AppError(422,'invalid_context',`${name} must contain at most 100 nonempty strings.`);
  }
  if(!expected_output||typeof expected_output!=='object'||Array.isArray(expected_output))throw new AppError(422,'invalid_context','expected_output must be an object.');
  // history is read from this task's conversation; never trust a supplied slice.
  return {facts,source_refs:[...new Set(source_refs)].sort(),constraints,expected_output};
}
export function taskResource(body) {
  const resource_type=body.resource_type??'task';const action=body.action??'execute';const resource_id=body.resource_id??null;
  if(!resourceTypes.includes(resource_type)||!actions.includes(action)||(resource_id!==null&&(typeof resource_id!=='string'||!resource_id||resource_id==='*')) || (resource_type!=='task'&&!resource_id)) {
    throw new AppError(422,'invalid_resource','Task permission target must be a concrete resource and action.');
  }
  return {resource_type,resource_id,action};
}
// Evaluate all recipients before dispatching any: an ask or deny cannot be
// bypassed by selecting an earlier, less restricted queue recipient.
export function evaluateTaskPlan(db,task,{includeCategories=true}={}) {
  const input=contextInput(JSON.parse(task.context_input));
  const checks=[];const packages={};
  if(includeCategories)checks.push(requesterCategory(db,task.requester_entity_id?
    {kind:'entity',entity_id:task.requester_entity_id}:{kind:'human',user_id:task.created_by_user_id},task.workspace_id,task.category,task.id));
  const messages=db.prepare(`SELECT id,body,sender_entity_id,author_user_id FROM messages
    WHERE workspace_id=? AND conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 20`).all(task.workspace_id,task.conversation_id).reverse();
  for(const recipient of JSON.parse(task.recipient_entity_ids)) {
    const membership=db.prepare('SELECT 1 FROM conversation_members WHERE workspace_id=? AND conversation_id=? AND entity_id=?').get(task.workspace_id,task.conversation_id,recipient);
    if(!membership) {
      checks.push({subject_entity_id:recipient,effect:'deny',reason:'recipient_not_conversation_member'});
      auditDecision(db,{workspaceId:task.workspace_id,actor:{kind:'entity',entity_id:recipient},taskId:task.id,action:'context.membership',decision:'deny',reason:'recipient_not_conversation_member'});
      continue;
    }
    if(includeCategories)checks.push(assigneeCategory(db,task.workspace_id,recipient,task.category,task.id));
    const permission=(resourceType,resourceId,action)=>{
      const result=evaluatePermission(db,{workspaceId:task.workspace_id,subjectEntityId:recipient,resourceType,resourceId,action,taskId:task.id});
      checks.push(result);return result;
    };
    permission(task.resource_type,task.resource_id??task.id,task.action);
    if(messages.length)permission('conversation',task.conversation_id,'read');
    // A source targeted as the task resource also needs a grant; an allow rule
    // never substitutes for private-source access.
    const sourceIds=[...new Set([...input.source_refs,...(task.resource_type==='source'?[task.resource_id]:[])])].sort();
    for(const sourceId of sourceIds) {
      const acl=sourceAccess(db,task.workspace_id,recipient,sourceId,task.id);
      checks.push({subject_entity_id:recipient,...acl});
      permission('source',sourceId,'read');
    }
    packages[recipient]={goal:task.goal,facts:input.facts,history_slice:messages,source_refs:input.source_refs,
      constraints:input.constraints,expected_output:input.expected_output};
  }
  const denied=checks.find(c=>c.effect==='deny');const asks=checks.filter(c=>c.effect==='ask');
  const effect=denied?'deny':asks.length?'ask':'allow';
  const fingerprint=createHash('sha256').update(JSON.stringify({attempt:task.attempt,category:task.category,goal:task.goal,input,checks})).digest('hex');
  return {effect,reason:denied?.reason??(asks.length?'human_approval_required':'permission_allowed'),checks,asks,fingerprint,packages};
}
export function executionGate(db,task) {
  const plan=evaluateTaskPlan(db,task);
  if(plan.effect==='deny')return plan;
  if(plan.effect==='ask') {
    const approved=db.prepare("SELECT id FROM approvals WHERE task_id=? AND attempt=? AND gate_fingerprint=? AND status='approved'").get(task.id,task.attempt,plan.fingerprint);
    if(!approved) {
      db.prepare(`INSERT INTO approvals(id,workspace_id,task_id,action,attempt,gate_fingerprint,created_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(task_id,attempt,gate_fingerprint) DO NOTHING`)
        .run(randomUUID(),task.workspace_id,task.id,JSON.stringify({checks:plan.asks}),task.attempt,plan.fingerprint,new Date().toISOString());
      auditDecision(db,{workspaceId:task.workspace_id,taskId:task.id,action:'approval.request',decision:'ask',reason:'human_approval_required'});
      return plan;
    }
    auditDecision(db,{workspaceId:task.workspace_id,taskId:task.id,action:'approval.use',decision:'allow',reason:'approved_task_attempt_and_rules'});
  }
  for(const [recipient,context] of Object.entries(plan.packages)) {
    // Only an authorized, current package is persisted. SQLite keeps this and
    // the claimed job in the same caller transaction.
    db.prepare('DELETE FROM context_packages WHERE task_id=? AND attempt=? AND recipient_entity_id=? AND gate_fingerprint IS NOT NULL').run(task.id,task.attempt,recipient);
    db.prepare(`INSERT INTO context_packages(id,workspace_id,task_id,recipient_entity_id,goal,facts,history_slice,source_refs,constraints,expected_output,attempt,gate_fingerprint)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),task.workspace_id,task.id,recipient,context.goal,
        JSON.stringify(context.facts),JSON.stringify(context.history_slice),JSON.stringify(context.source_refs),JSON.stringify(context.constraints),JSON.stringify(context.expected_output),task.attempt,plan.fingerprint);
    auditDecision(db,{workspaceId:task.workspace_id,actor:{kind:'entity',entity_id:recipient},taskId:task.id,action:'context.assemble',decision:'allow',reason:'recipient_sources_authorized'});
  }
  return {...plan,effect:'allow'};
}
