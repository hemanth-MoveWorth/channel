import { randomUUID, createHash } from 'node:crypto';
import { transaction } from './database.mjs';
import { authorize } from './access.mjs';
import { auditDecision } from './audit.mjs';
import { AppError } from './errors.mjs';

const timestamp = () => new Date().toISOString();
const fail = (status, code, message) => { throw new AppError(status, code, message); };
const row = (db, id) => db.prepare('SELECT * FROM live_exchanges WHERE id=?').get(id);
const pair = (db, workspace) => db.prepare('SELECT * FROM live_pairs WHERE workspace_id=?').get(workspace)
  ?? fail(404, 'not_found', 'Live prototype is not configured.');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const message = (db, id) => {
  const m = db.prepare('SELECT * FROM messages WHERE id=?').get(id);
  return { id:m.id, conversation_id:m.conversation_id, sender:m.sender_entity_id, body:m.body,
    kind:m.kind, parent_message_id:m.parent_message_id, created_at:m.created_at };
};
function inputText(value, name, max) {
  if(typeof value!=='string' || !value.trim() || value.length>max) fail(422,'invalid_request',`${name} must contain 1–${max} characters.`);
  return value;
}
function entity(db, actor, workspace, role) {
  if(actor?.kind!=='entity') fail(403,'forbidden','An entity credential is required.');
  authorize(db,actor,workspace,'profiles:read');
  const p=pair(db,workspace);
  if(actor.entity_id!==p[role]) fail(403,'forbidden','This entity cannot perform that exchange action.');
  return p;
}
function human(db,actor,workspace) {
  if(actor?.kind!=='human') fail(403,'forbidden','Only the local human may arm or stop exchanges.');
  authorize(db,actor,workspace,'entities:write');
  pair(db,workspace);
}
function expire(db) {
  db.prepare("UPDATE live_exchanges SET state='expired',finished_at=?,failure_code='deadline' WHERE state IN ('armed','sent','claimed') AND expires_at<=?")
    .run(timestamp(),timestamp());
}
function event(db,actor,workspace,reason) {
  auditDecision(db,{workspaceId:workspace,actor,action:'live.exchange',decision:'allow',reason});
}
export function rejectLiveWrite(db,actor) {
  if(actor?.kind==='entity' && db.prepare('SELECT 1 FROM live_pairs WHERE sender_id=? OR receiver_id=?').get(actor.entity_id,actor.entity_id))
    fail(403,'live_scope_only','This prototype entity may write only through the bounded live exchange.');
}
export function liveStatus(db,actor,workspace) {
  human(db,actor,workspace);expire(db);
  const p=pair(db,workspace);
  const entities=db.prepare('SELECT id,name,description,connection_type FROM entities WHERE id IN (?,?) ORDER BY name').all(p.sender_id,p.receiver_id);
  return {entities,exchanges:db.prepare('SELECT * FROM live_exchanges WHERE workspace_id=? ORDER BY created_at DESC,id DESC LIMIT 20').all(workspace)};
}
export function armExchange(db,actor,workspace) {
  human(db,actor,workspace);expire(db);
  return transaction(db,()=>{
    if(db.prepare("SELECT 1 FROM live_exchanges WHERE workspace_id=? AND state IN ('armed','sent','claimed')").get(workspace))
      fail(409,'exchange_active','Stop or finish the current exchange first.');
    const id=randomUUID();
    db.prepare("INSERT INTO live_exchanges(id,workspace_id,state,created_at,expires_at) VALUES (?,?,'armed',?,?)")
      .run(id,workspace,timestamp(),new Date(Date.now()+300000).toISOString());
    event(db,actor,workspace,'armed');return row(db,id);
  });
}
export function stopExchange(db,actor,workspace,id) {
  human(db,actor,workspace);
  const x=row(db,id);if(!x || x.workspace_id!==workspace)fail(404,'not_found','Exchange not found.');
  return transaction(db,()=>{
    db.prepare("UPDATE live_exchanges SET state='stopped',finished_at=?,failure_code='stopped_by_user' WHERE id=? AND state IN ('armed','sent','claimed')").run(timestamp(),id);
    event(db,actor,workspace,'stopped');return row(db,id);
  });
}
function existing(db,actor,key,fingerprint) {
  const prior=db.prepare('SELECT * FROM live_message_keys WHERE workspace_id=? AND sender_id=? AND key=?').get(actor.workspace_id,actor.entity_id,key);
  if(!prior)return null;
  if(prior.request_hash!==fingerprint)fail(409,'idempotency_conflict','This key was used for different message content.');
  return {message:message(db,prior.message_id),exchange:row(db,prior.exchange_id),replayed:true};
}
function saveKey(db,actor,key,fingerprint,id,exchangeId) {
  db.prepare('INSERT INTO live_message_keys VALUES (?,?,?,?,?,?)').run(actor.workspace_id,actor.entity_id,key,fingerprint,id,exchangeId);
}
function insert(db,actor,conversation,body,parent=null) {
  authorize(db,actor,actor.workspace_id,'messages:write',{conversationId:conversation});
  const id=randomUUID();
  db.prepare("INSERT INTO messages(id,workspace_id,conversation_id,sender_entity_id,body,created_at,kind,parent_message_id) VALUES (?,?,?,?,?,?,'chat',?)")
    .run(id,actor.workspace_id,conversation,actor.entity_id,body,timestamp(),parent);
  return id;
}
export function sendGreeting(db,actor,input,key) {
  const p=entity(db,actor,actor.workspace_id,'sender_id');
  const body=inputText(input.body,'body',2000);inputText(key,'Idempotency-Key',200);
  if(input.to_id!==p.receiver_id || input.to_id===actor.entity_id)fail(422,'invalid_recipient','Select the configured Codex recipient.');
  const fingerprint=hash([input.to_id,body]);expire(db);
  return transaction(db,()=>{
    const prior=existing(db,actor,key,fingerprint);if(prior)return prior;
    const x=db.prepare("SELECT * FROM live_exchanges WHERE workspace_id=? AND state='armed'").get(actor.workspace_id);
    if(!x)fail(409,'exchange_not_armed','Ask the human to arm an exchange first.');
    // Only an exact two-member DM is reusable. Never enroll the caller into a group.
    let dm=db.prepare(`SELECT c.id FROM conversations c WHERE c.workspace_id=? AND c.kind='dm'
      AND (SELECT count(*) FROM conversation_members m WHERE m.conversation_id=c.id)=2
      AND EXISTS(SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.entity_id=?)
      AND EXISTS(SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.entity_id=?)
      ORDER BY c.created_at,c.id LIMIT 1`).get(actor.workspace_id,p.sender_id,p.receiver_id);
    if(!dm) {
      dm={id:randomUUID()};
      db.prepare("INSERT INTO conversations(id,workspace_id,kind,name,created_at) VALUES (?,?,'dm','Hermes + Codex',?)").run(dm.id,actor.workspace_id,timestamp());
      for(const member of [p.sender_id,p.receiver_id])db.prepare('INSERT INTO conversation_members VALUES (?,?,?,0)').run(actor.workspace_id,dm.id,member);
    }
    const id=insert(db,actor,dm.id,body);
    db.prepare("UPDATE live_exchanges SET state='sent',conversation_id=?,message_id=? WHERE id=?").run(dm.id,id,x.id);
    saveKey(db,actor,key,fingerprint,id,x.id);event(db,actor,actor.workspace_id,'sent');
    return {message:message(db,id),exchange:row(db,x.id),replayed:false};
  });
}
export function claimExchange(db,actor,workspace) {
  entity(db,actor,workspace,'receiver_id');expire(db);
  return transaction(db,()=>{
    const x=db.prepare("SELECT * FROM live_exchanges WHERE workspace_id=? AND state='sent' ORDER BY created_at LIMIT 1").get(workspace);
    if(!x)return null;
    db.prepare("UPDATE live_exchanges SET state='claimed',claimed_at=? WHERE id=? AND state='sent'").run(timestamp(),x.id);
    event(db,actor,workspace,'claimed');return {...row(db,x.id),message:message(db,x.message_id)};
  });
}
export function replyExchange(db,actor,workspace,id,input,key) {
  entity(db,actor,workspace,'receiver_id');
  const body=inputText(input.body,'body',8000),session=inputText(input.session_id,'session_id',100);
  inputText(key,'Idempotency-Key',200);
  if(!/^[0-9a-f-]{36}$/i.test(session))fail(422,'invalid_session','Expected an actual Codex session UUID.');
  const fingerprint=hash([id,body,session]);expire(db);
  return transaction(db,()=>{
    const prior=existing(db,actor,key,fingerprint);if(prior)return prior;
    const x=row(db,id);
    if(!x || x.workspace_id!==workspace)fail(404,'not_found','Exchange not found.');
    if(x.state!=='claimed')fail(409,'exchange_not_claimed','Exchange is stopped, expired, or already finished.');
    const mid=insert(db,actor,x.conversation_id,body,x.message_id);
    db.prepare("UPDATE live_exchanges SET state='replied',reply_id=?,session_id=?,finished_at=? WHERE id=?").run(mid,session,timestamp(),id);
    saveKey(db,actor,key,fingerprint,mid,id);event(db,actor,workspace,'replied');
    return {message:message(db,mid),exchange:row(db,id),replayed:false};
  });
}
export function readLiveInbox(db,actor,workspace) {
  entity(db,actor,workspace,'sender_id');expire(db);
  return transaction(db,()=>{
    const xs=db.prepare("SELECT * FROM live_exchanges WHERE workspace_id=? AND state='replied' AND read_at IS NULL ORDER BY created_at LIMIT 20").all(workspace);
    for(const x of xs)db.prepare('UPDATE live_exchanges SET read_at=? WHERE id=?').run(timestamp(),x.id);
    if(xs.length)event(db,actor,workspace,'reply_read');
    return xs.map(x=>({exchange_id:x.id,message:message(db,x.reply_id)}));
  });
}
export function endExchange(db,id,state,code) {
  if(!['failed','uncertain'].includes(state))throw new Error('Invalid terminal state');
  db.prepare("UPDATE live_exchanges SET state=?,finished_at=?,failure_code=? WHERE id=? AND state IN ('armed','sent','claimed')").run(state,timestamp(),code,id);
}
export function recoverExchanges(db) {
  // Called only by the single owning live-server process, after acquiring its DB lock.
  db.prepare("UPDATE live_exchanges SET state='uncertain',finished_at=?,failure_code='interrupted_after_claim' WHERE state='claimed'").run(timestamp());expire(db);
}
export function exchangeState(db,id) { expire(db);return row(db,id); }
