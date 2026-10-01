import { randomUUID, createHash } from 'node:crypto';
import { AppError } from './errors.mjs';

export const hashKey = key => createHash('sha256').update(key).digest('hex');
export function authenticateEntity(db,key) {
  if (typeof key !== 'string' || key.length === 0) throw new AppError(401,'unauthorized','An entity key is required.');
  const entity = db.prepare(`SELECT e.id,e.workspace_id FROM entities e JOIN entity_credentials c ON c.entity_id=e.id
    WHERE c.key_hash=? AND c.revoked_at IS NULL`).get(hashKey(key));
  if (!entity) throw new AppError(401,'unauthorized','Invalid or revoked entity key.');
  return { kind:'entity', entity_id:entity.id, workspace_id:entity.workspace_id };
}
export function authorize(db,actor,workspaceId,action,{conversationId,assignedEntityId}={}) {
  const membership = actor?.kind === 'human'
    ? db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspaceId,actor.user_id)
    : null;
  // Re-read entity identity. A caller-supplied workspace_id never grants access.
  const entity = actor?.kind === 'entity' ? db.prepare('SELECT workspace_id FROM entities WHERE id=?').get(actor.entity_id) : null;
  let allowed = false;
  if (membership) {
    const rights = {
      'profiles:read':['owner','admin','member'], 'entities:write':['owner','admin'], 'entities:delete':['owner'],
      'conversations:read':['owner','admin','member'], 'conversations:write':['owner','admin','member'],
      'messages:read':['owner','admin','member'], 'messages:write':['owner','admin','member'],
      'tasks:read':['owner','admin','member'], 'tasks:create':['owner','admin','member'],
      'tasks:control':['owner','admin','member'], 'permissions:manage':['owner','admin'],
      'approvals:read':['owner','admin','member'], 'approvals:decide':['owner','admin'],
      'audit:read':['owner','admin','member'],
    };
    allowed = rights[action]?.includes(membership.role) ?? false;
  } else if (entity?.workspace_id === workspaceId) {
    const inConversation = conversationId && db.prepare('SELECT 1 FROM conversation_members WHERE workspace_id=? AND conversation_id=? AND entity_id=?')
      .get(workspaceId,conversationId,actor.entity_id);
    if (action === 'profiles:read') allowed = true;
    if (['conversations:read','messages:read','messages:write','tasks:create','tasks:read'].includes(action)) allowed = Boolean(inConversation);
    if (action === 'tasks:control') allowed = assignedEntityId === actor.entity_id;
  }
  // No generic allow fallback, and never a credential or raw-context read grant.
  // This is the ADR-001 boundary; action-rule evaluation is WP-E1-03.
  if (!allowed) {
    if (db.prepare('SELECT 1 FROM workspaces WHERE id=?').get(workspaceId)) {
      // Use only an actor FK in this tenant; foreign actors are not attached to
      // another tenant's audit row and credentials never enter the reason.
      db.prepare(`INSERT INTO audit_log(id,workspace_id,actor_user_id,actor_entity_id,action,decision,reason,created_at)
        VALUES (?,?,?,?,?,'deny','not_authorized',?)`).run(randomUUID(),workspaceId,membership?actor.user_id:null,
        entity?.workspace_id===workspaceId?actor.entity_id:null,action,new Date().toISOString());
    }
    throw new AppError(403,'forbidden','This identity is not authorized for that action.');
  }
}
export function listEntities(db,actor,workspaceId,capability) {
  authorize(db,actor,workspaceId,'profiles:read');
  return db.prepare(`SELECT id,workspace_id,owner_user_id,name,description,capabilities,connection_type,
    webhook_url,verified_permissions,availability,last_check FROM entities WHERE workspace_id=? ORDER BY id`).all(workspaceId)
    .map(row => ({...row, capabilities:JSON.parse(row.capabilities), verified_permissions:JSON.parse(row.verified_permissions)}))
    .filter(row => !capability || row.capabilities.includes(capability));
}
