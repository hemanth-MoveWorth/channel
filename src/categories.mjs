import { authorize } from './access.mjs';
import { auditDecision } from './audit.mjs';
import { transaction } from './database.mjs';
import { AppError } from './errors.mjs';

export const ACTION_CATEGORIES=Object.freeze(['research','read_context','tool_use','write','send_external','publish']);
export function category(value) {
  if(!ACTION_CATEGORIES.includes(value))throw new AppError(422,'invalid_category','Declare a task category from ADR-009.');
  return value;
}
function entity(db,workspace,id) {
  const row=db.prepare('SELECT category_grants,category_policy FROM entities WHERE workspace_id=? AND id=?').get(workspace,id);
  if(!row)throw new AppError(404,'not_found','Entity not found.');
  return row;
}
function grants(value) {
  if(!Array.isArray(value)||value.some(c=>!ACTION_CATEGORIES.includes(c)))throw new AppError(422,'invalid_category_grants','Grants must be an array of categories.');
  return [...new Set(value)];
}
function policy(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||!['ask_every_time','standing_rules','full_access_workspace'].includes(value.kind))throw new AppError(422,'invalid_category_policy','Unknown category policy mode.');
  if(value.kind!=='standing_rules')return {kind:value.kind};
  if(!value.rules||typeof value.rules!=='object'||Array.isArray(value.rules)||Object.entries(value.rules).some(([c,e])=>!ACTION_CATEGORIES.includes(c)||!['allow','ask','deny'].includes(e)))throw new AppError(422,'invalid_category_policy','Standing rules map categories to allow, ask or deny.');
  return {kind:value.kind,rules:{...value.rules}};
}
// Local human AdminApi operations; never exposed to entity-key HTTP callers.
export function grantCategories(db,actor,workspace,id,input) {
  authorize(db,actor,workspace,'permissions:manage');entity(db,workspace,id);const value=grants(input);
  return transaction(db,()=>{
    db.prepare('UPDATE entities SET category_grants=? WHERE workspace_id=? AND id=?').run(JSON.stringify(value),workspace,id);
    auditDecision(db,{workspaceId:workspace,actor,action:'category.grant',decision:'allow',reason:'workspace_admin'});
  });
}
export function setApprovalMode(db,actor,workspace,id,input) {
  authorize(db,actor,workspace,'permissions:manage');entity(db,workspace,id);const value=policy(input);
  return transaction(db,()=>{
    db.prepare('UPDATE entities SET category_policy=? WHERE workspace_id=? AND id=?').run(JSON.stringify(value),workspace,id);
    auditDecision(db,{workspaceId:workspace,actor,action:'category.policy',decision:'allow',reason:'workspace_admin'});
  });
}
export function requesterCategory(db,actor,workspace,requested,taskId=null) {
  let effect='deny',reason='requester_category_not_granted';
  if(!ACTION_CATEGORIES.includes(requested))reason='missing_or_invalid_category';
  else if(actor.kind==='human') {
    // A trusted human request is itself the human's category authorisation.
    // Entity grants are never inferred from the human's request or permissions.
    const member=db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspace,actor.user_id);
    if(member){effect='allow';reason='human_requested_category';}
  } else if(actor.kind==='entity') {
    try{if(grants(JSON.parse(entity(db,workspace,actor.entity_id).category_grants)).includes(requested)){effect='allow';reason='requester_category_granted';}}
    catch{reason='invalid_requester_category_grants';}
  }
  auditDecision(db,{workspaceId:workspace,actor,taskId,action:'category.request',decision:effect,reason});
  return {side:'requester',subject_entity_id:actor.entity_id??null,category:requested,effect,reason};
}
export function assigneeCategory(db,workspace,id,requested,taskId=null) {
  let effect='deny',reason='assignee_category_denied';
  try {
    category(requested);const value=policy(JSON.parse(entity(db,workspace,id).category_policy));
    effect=value.kind==='ask_every_time'?'ask':value.kind==='full_access_workspace'?'allow':value.rules[requested]??'deny';
    reason=`assignee_category_${effect}`;
  }catch{reason='invalid_assignee_category_policy';}
  auditDecision(db,{workspaceId:workspace,actor:{kind:'entity',entity_id:id},taskId,action:'category.accept',decision:effect,reason});
  return {side:'assignee',subject_entity_id:id,category:requested,effect,reason};
}
