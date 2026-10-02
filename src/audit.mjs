import { randomUUID } from 'node:crypto';
export function auditDecision(db,{workspaceId,actor,taskId=null,action,decision,reason}) {
  const human=actor?.kind==='human' && db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspaceId,actor.user_id);
  const entity=actor?.kind==='entity' && db.prepare('SELECT 1 FROM entities WHERE workspace_id=? AND id=?').get(workspaceId,actor.entity_id);
  db.prepare(`INSERT INTO audit_log(id,workspace_id,actor_user_id,actor_entity_id,task_id,action,decision,reason,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(randomUUID(),workspaceId,human?actor.user_id:null,entity?actor.entity_id:null,
      taskId,action,decision,reason,new Date().toISOString());
}
