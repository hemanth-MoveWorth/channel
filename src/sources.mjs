import { randomUUID } from 'node:crypto';
import { authorize } from './access.mjs';
import { auditDecision } from './audit.mjs';
import { transaction } from './database.mjs';
import { AppError } from './errors.mjs';

export function registerSource(db,actor,workspaceId,{visibility='private'}={}) {
  authorize(db,actor,workspaceId,'profiles:read');
  if(!['private','shared'].includes(visibility))throw new AppError(422,'invalid_source','Invalid source visibility.');
  return transaction(db,()=>{
    const id=randomUUID();const owner_type=actor.kind==='human'?'user':'entity';const owner_id=actor.user_id??actor.entity_id;
    db.prepare('INSERT INTO sources VALUES (?,?,?,?,?)').run(id,workspaceId,owner_type,owner_id,visibility);
    auditDecision(db,{workspaceId,actor,action:'source.register',decision:'allow',reason:'registering_identity_is_owner'});
    return {id,workspace_id:workspaceId,owner_type,owner_id,visibility};
  });
}
export function grantSource(db,actor,sourceId,granteeEntityId) {
  const source=db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
  if(!source)throw new AppError(404,'not_found','Source not found.');
  const membership=actor.kind==='human'?db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(source.workspace_id,actor.user_id):null;
  const owns=source.owner_type===(actor.kind==='human'?'user':'entity') && source.owner_id===(actor.user_id??actor.entity_id);
  if(!owns && !['owner','admin'].includes(membership?.role)) {
    auditDecision(db,{workspaceId:source.workspace_id,actor,action:'source.grant',decision:'deny',reason:'owner_or_admin_required'});
    throw new AppError(403,'forbidden','Only the source owner or workspace admin can grant access.');
  }
  if(!db.prepare('SELECT 1 FROM entities WHERE workspace_id=? AND id=?').get(source.workspace_id,granteeEntityId))throw new AppError(422,'invalid_grant','Grantee must be an entity in the source workspace.');
  return transaction(db,()=>{
    const by=`${actor.kind==='human'?'user':'entity'}:${actor.user_id??actor.entity_id}`;
    db.prepare("INSERT INTO source_grants VALUES (?,?,?,'read',?,?) ON CONFLICT(source_id,grantee_entity_id,scope) DO NOTHING")
      .run(sourceId,source.workspace_id,granteeEntityId,by,new Date().toISOString());
    auditDecision(db,{workspaceId:source.workspace_id,actor,action:'source.grant',decision:'allow',reason:owns?'source_owner':'workspace_admin'});
  });
}
export function sourceAccess(db,workspaceId,recipientId,sourceId,taskId=null) {
  const source=db.prepare('SELECT * FROM sources WHERE workspace_id=? AND id=?').get(workspaceId,sourceId);
  const recipient=db.prepare('SELECT 1 FROM entities WHERE workspace_id=? AND id=?').get(workspaceId,recipientId);
  const grant=source && db.prepare("SELECT 1 FROM source_grants WHERE source_id=? AND grantee_entity_id=? AND scope='read'").get(sourceId,recipientId);
  const owns=source?.owner_type==='entity' && source.owner_id===recipientId;
  const allowed=Boolean(recipient && source && (owns||grant||source.visibility==='shared'));
  const reason=allowed?(owns?'source_owner':grant?'source_grant':'source_shared'):'source_not_shared_with_recipient';
  auditDecision(db,{workspaceId,actor:{kind:'entity',entity_id:recipientId},taskId,action:'source.read_access',decision:allowed?'allow':'deny',reason});
  return {effect:allowed?'allow':'deny',reason,source_id:sourceId};
}
