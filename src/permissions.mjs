import { randomUUID } from 'node:crypto';
import { authorize } from './access.mjs';
import { auditDecision } from './audit.mjs';
import { transaction } from './database.mjs';
import { AppError } from './errors.mjs';

export const resourceTypes=['source','tool','conversation','task'];
export const actions=['read','write','execute','share'];
function validateRule(rule) {
  if (!rule || typeof rule!=='object' || Array.isArray(rule) ||
      typeof rule.subject_entity_id!=='string' || !rule.subject_entity_id ||
      !resourceTypes.includes(rule.resource_type) || typeof rule.resource_id!=='string' || !rule.resource_id ||
      !actions.includes(rule.action) || !['allow','deny','ask'].includes(rule.effect) ||
      !Number.isSafeInteger(rule.priority) || typeof rule.created_by!=='string' || typeof rule.note!=='string') {
    throw new AppError(422,'invalid_rule','Rule must follow ADR-004.');
  }
  return rule;
}
const actorName=actor=>`${actor.kind==='human'?'user':'entity'}:${actor.user_id??actor.entity_id}`;
function storeRule(db,workspaceId,mode,rule,id=randomUUID()) {
  db.prepare('INSERT INTO permission_rules(id,workspace_id,entity_id,mode,rule_json) VALUES (?,?,?,?,?)')
    .run(id,workspaceId,rule.subject_entity_id==='*'?null:rule.subject_entity_id,mode,JSON.stringify(rule));
  return id;
}
export function addRule(db,actor,workspaceId,input) {
  authorize(db,actor,workspaceId,'permissions:manage');
  const rule=validateRule({...input,created_by:actorName(actor),note:input.note??''});
  if (rule.subject_entity_id!=='*' && !db.prepare('SELECT 1 FROM entities WHERE workspace_id=? AND id=?').get(workspaceId,rule.subject_entity_id)) {
    throw new AppError(422,'invalid_rule','Rule subject is not in this workspace.');
  }
  return transaction(db,()=>{
    const id=storeRule(db,workspaceId,'standing_rules',rule);
    auditDecision(db,{workspaceId,actor,action:'permission_rule.create',decision:'allow',reason:'workspace_admin'});
    return {id,...rule};
  });
}
// Modes are explicit canonical rule sets, never a bypass in the evaluator.
// Changing a mode preserves standing deny rules. Full access still needs source
// ownership/grants; ask is once per logical task attempt, not per transport retry.
export function setPermissionMode(db,actor,workspaceId,subject,mode) {
  authorize(db,actor,workspaceId,'permissions:manage');
  if (!['standing_rules','ask_every_time','full_access_workspace'].includes(mode)) throw new AppError(422,'invalid_mode','Unknown permission mode.');
  if (subject!=='*' && !db.prepare('SELECT 1 FROM entities WHERE workspace_id=? AND id=?').get(workspaceId,subject)) throw new AppError(422,'invalid_rule','Rule subject is not in this workspace.');
  return transaction(db,()=>{
    db.prepare("DELETE FROM permission_rules WHERE workspace_id=? AND entity_id IS ? AND mode<>'standing_rules'").run(workspaceId,subject==='*'?null:subject);
    if (mode!=='standing_rules') for (const resource_type of resourceTypes) for (const action of actions) {
      storeRule(db,workspaceId,mode,{subject_entity_id:subject,resource_type,resource_id:'*',action,
        effect:mode==='ask_every_time'?'ask':'allow',priority:0,created_by:actorName(actor),note:`Configured ${mode}`});
    }
    auditDecision(db,{workspaceId,actor,action:'permission_mode.configure',decision:'allow',reason:mode});
  });
}
export function evaluatePermission(db,{workspaceId,subjectEntityId,resourceType,resourceId,action,taskId=null}) {
  const actor={kind:'entity',entity_id:subjectEntityId};
  let matches=[];let reason;let effect='deny';let selected=[];
  if (!db.prepare('SELECT 1 FROM entities WHERE workspace_id=? AND id=?').get(workspaceId,subjectEntityId)) reason='subject_outside_workspace';
  else if (!resourceTypes.includes(resourceType) || !actions.includes(action) || typeof resourceId!=='string') reason='invalid_permission_target';
  else {
    const rows=db.prepare('SELECT id,rule_json FROM permission_rules WHERE workspace_id=? AND (entity_id IS NULL OR entity_id=?) ORDER BY id').all(workspaceId,subjectEntityId);
    for (const row of rows) {
      let rule;try {rule=validateRule(JSON.parse(row.rule_json));} catch {reason='invalid_rule';break;}
      if ((rule.subject_entity_id==='*'||rule.subject_entity_id===subjectEntityId) && rule.resource_type===resourceType &&
          (rule.resource_id==='*'||rule.resource_id===resourceId) && rule.action===action) {
        // ADR-004's three ranks: entity+resource, entity-only, wildcard subject.
        matches.push({id:row.id,rule,specificity:rule.subject_entity_id==='*'?0:rule.resource_id==='*'?1:2});
      }
    }
    if (!reason) {
      const denies=matches.filter(m=>m.rule.effect==='deny');
      if (denies.length) {selected=denies;reason='explicit_deny';}
      else if (!matches.length) reason='no_matching_rule';
      else {
        const specificity=Math.max(...matches.map(m=>m.specificity));
        let candidates=matches.filter(m=>m.specificity===specificity);
        if(candidates.some(m=>m.rule.effect==='ask'))candidates=candidates.filter(m=>m.rule.effect==='ask');
        const priority=Math.max(...candidates.map(m=>m.rule.priority));
        selected=candidates.filter(m=>m.rule.priority===priority);
        if(selected.length!==1)reason='priority_tie';
        else {effect=selected[0].rule.effect;reason=`matching_${effect}`;}
      }
    }
  }
  const result={subject_entity_id:subjectEntityId,resource_type:resourceType,resource_id:resourceId,action,effect,reason,
    rule_ids:selected.map(m=>m.id).sort()};
  auditDecision(db,{workspaceId,actor,taskId,action:`permission.${resourceType}.${action}`,decision:effect,reason});
  return result;
}
