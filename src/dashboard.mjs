import { randomUUID } from 'node:crypto';
import { authorize } from './access.mjs';
import { transaction } from './database.mjs';
import { auditDecision } from './audit.mjs';
import { publicTask,rawTask,text,now,transitions } from './tasks.mjs';
import { AppError } from './errors.mjs';
import { rejectLiveWrite } from './live-exchange.mjs';

function human(db,actor,workspace,action) {
  if(actor.kind!=='human') {
    auditDecision(db,{workspaceId:workspace,actor,action,decision:'deny',reason:'human_dashboard_only'});
    throw new AppError(403,'forbidden','This dashboard endpoint requires the local human.');
  }
  authorize(db,actor,workspace,action);
}
export function listTasks(db,actor,workspace,query) {
  human(db,actor,workspace,'tasks:read');
  const limit=Number(query.get('limit')??50),offset=Number(query.get('offset')??0);
  if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)throw new AppError(422,'invalid_page','Use limit 1–100 and a nonnegative offset.');
  const where=['workspace_id=?'],args=[workspace];
  for(const [filter,column] of [['status','state'],['assignee','assigned_entity_id'],['requester','requester_entity_id']]) {
    const value=query.get(filter);
    if(value) {
      if(filter==='status'&&!Object.hasOwn(transitions,value))throw new AppError(422,'invalid_status','Unknown task status.');
      where.push(`${column}=?`);args.push(value);
    }
  }
  const clause=where.join(' AND ');
  return {items:db.prepare(`SELECT * FROM tasks WHERE ${clause} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...args,limit,offset).map(publicTask),
    total:db.prepare(`SELECT count(*) AS n FROM tasks WHERE ${clause}`).get(...args).n,limit,offset};
}
export function listApprovals(db,actor,workspace,state='pending') {
  human(db,actor,workspace,'approvals:read');
  if(!['pending','approved','rejected'].includes(state))throw new AppError(422,'invalid_state','Unknown approval state.');
  return db.prepare(`SELECT a.id,a.task_id,a.action,a.status,a.attempt,a.created_at,a.decided_at,t.goal
    FROM approvals a JOIN tasks t ON t.id=a.task_id WHERE a.workspace_id=? AND a.status=?
    AND (a.status<>'pending' OR (t.state='awaiting_approval' AND a.attempt=t.attempt)) ORDER BY a.created_at,a.id`)
    .all(workspace,state).map(row=>({...row,action:JSON.parse(row.action)}));
}
function conversation(db,workspace,id) {
  const row=db.prepare('SELECT * FROM conversations WHERE workspace_id=? AND id=?').get(workspace,id);
  if(!row)throw new AppError(404,'not_found','Conversation not found.');
  const members=db.prepare('SELECT entity_id,is_orchestrator FROM conversation_members WHERE conversation_id=? ORDER BY entity_id').all(id);
  return {id:row.id,workspace_id:row.workspace_id,type:row.kind,title:row.name,member_ids:members.map(m=>m.entity_id),
    orchestrator_entity_id:members.find(m=>m.is_orchestrator)?.entity_id??null,created_at:row.created_at};
}
export function listConversations(db,actor,workspace) {
  if(actor.kind==='human')authorize(db,actor,workspace,'conversations:read');
  else authorize(db,actor,workspace,'profiles:read');
  const rows=actor.kind==='human'?db.prepare('SELECT id FROM conversations WHERE workspace_id=? ORDER BY created_at,id').all(workspace):
    db.prepare('SELECT conversation_id AS id FROM conversation_members WHERE workspace_id=? AND entity_id=? ORDER BY conversation_id').all(workspace,actor.entity_id);
  return rows.map(r=>conversation(db,workspace,r.id));
}
export function createConversation(db,actor,workspace,input) {
  authorize(db,actor,workspace,'conversations:write');
  if(input.workspace_id!==undefined&&input.workspace_id!==workspace)throw new AppError(403,'forbidden','Workspace mismatch.');
  const title=text(input.title,'title'),type=input.type;
  if(!['dm','group'].includes(type)||!Array.isArray(input.member_ids)||!input.member_ids.length||input.member_ids.length>100)throw new AppError(422,'invalid_conversation','Choose a type and 1–100 members.');
  const members=[...new Set(input.member_ids.map(id=>text(id,'member_id')))];
  const orchestrator=input.orchestrator_entity_id??null;
  if(orchestrator&&!members.includes(orchestrator))throw new AppError(422,'invalid_orchestrator','Orchestrator must be a conversation member.');
  for(const id of members) {
    const e=db.prepare('SELECT connection_type FROM entities WHERE workspace_id=? AND id=?').get(workspace,id);
    if(!e)throw new AppError(422,'invalid_member','Member must belong to this workspace.');
    if(id===orchestrator&&e.connection_type!=='A')throw new AppError(422,'invalid_orchestrator','Only a type A entity may orchestrate.');
  }
  return transaction(db,()=>{
    const id=randomUUID();db.prepare('INSERT INTO conversations(id,workspace_id,kind,name,created_at) VALUES (?,?,?,?,?)').run(id,workspace,type,title,now());
    for(const member of members)db.prepare('INSERT INTO conversation_members VALUES (?,?,?,?)').run(workspace,id,member,Number(member===orchestrator));
    auditDecision(db,{workspaceId:workspace,actor,action:'conversation.create',decision:'allow',reason:'workspace_member'});
    return conversation(db,workspace,id);
  });
}
const publicMessage=row=>({id:row.id,conversation_id:row.conversation_id,sender:row.sender_entity_id??'human',kind:row.kind,
  body:row.body,parent_message_id:row.parent_message_id,task_id:row.task_id,created_at:row.created_at});
export function listMessages(db,actor,workspace,id) {
  authorize(db,actor,workspace,'messages:read',{conversationId:id});conversation(db,workspace,id);
  return db.prepare('SELECT * FROM messages WHERE workspace_id=? AND conversation_id=? ORDER BY created_at,id').all(workspace,id).map(publicMessage);
}
export function createMessage(db,actor,workspace,id,input) {
  rejectLiveWrite(db,actor);
  authorize(db,actor,workspace,'messages:write',{conversationId:id});conversation(db,workspace,id);
  const body=text(input.body,'body'),kind=input.kind??'chat',taskId=input.task_id??null,parent=input.parent_message_id??null;
  if(!['chat','task_request','task_result','system'].includes(kind))throw new AppError(422,'invalid_kind','Unknown message kind.');
  if(['task_request','task_result'].includes(kind)&&!taskId)throw new AppError(422,'task_required','Task messages require a task ID.');
  if(taskId) {
    const task=rawTask(db,taskId);
    if(task.workspace_id!==workspace||task.conversation_id!==id)throw new AppError(422,'invalid_task','Task must belong to this conversation.');
    if(kind==='task_result'&&actor.kind==='entity'&&task.assigned_entity_id!==actor.entity_id) {
      auditDecision(db,{workspaceId:workspace,actor,taskId,action:'message.task_result',decision:'deny',reason:'assigned_entity_required'});
      throw new AppError(403,'forbidden','Only the assigned entity can submit a result.');
    }
  }
  if(parent&&!db.prepare('SELECT 1 FROM messages WHERE id=? AND conversation_id=? AND workspace_id=?').get(parent,id,workspace))throw new AppError(422,'invalid_parent','Parent must belong to this conversation.');
  return transaction(db,()=>{
    const messageId=randomUUID();db.prepare(`INSERT INTO messages(id,workspace_id,conversation_id,task_id,sender_entity_id,author_user_id,body,created_at,kind,parent_message_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(messageId,workspace,id,taskId,actor.kind==='entity'?actor.entity_id:null,actor.kind==='human'?actor.user_id:null,body,now(),kind,parent);
    auditDecision(db,{workspaceId:workspace,actor,taskId,action:'message.create',decision:'allow',reason:'conversation_authorized'});
    return publicMessage(db.prepare('SELECT * FROM messages WHERE id=?').get(messageId));
  });
}
export function inbox(db,actor,workspace) {
  if(actor.kind!=='entity')throw new AppError(403,'forbidden','Inbox requires an entity key.');
  authorize(db,actor,workspace,'profiles:read');
  const tasks=db.prepare(`SELECT t.* FROM tasks t JOIN conversation_members m ON m.conversation_id=t.conversation_id
    WHERE t.workspace_id=? AND m.entity_id=? AND t.assigned_entity_id=? AND t.state NOT IN ('completed','failed','cancelled')`).all(workspace,actor.entity_id,actor.entity_id);
  const messages=db.prepare(`SELECT m.* FROM messages m JOIN conversation_members c ON c.conversation_id=m.conversation_id
    WHERE m.workspace_id=? AND c.entity_id=? AND (m.sender_entity_id IS NULL OR m.sender_entity_id<>?)`).all(workspace,actor.entity_id,actor.entity_id);
  // ADR-005 defines no mention addressing syntax or read cursor. Return messages
  // and pending tasks; don't infer mentions from untrusted text.
  return [...tasks.map(t=>({kind:'task',ref_id:t.id,summary:t.goal,created_at:t.created_at})),
    ...messages.map(m=>({kind:'message',ref_id:m.id,summary:m.body,created_at:m.created_at}))].sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.ref_id.localeCompare(b.ref_id));
}
