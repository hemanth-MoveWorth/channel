import { randomBytes,randomUUID } from 'node:crypto';
import { mkdirSync,readFileSync,writeFileSync,existsSync,unlinkSync } from 'node:fs';
import { resolve,join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase,migrate,transaction } from '../src/database.mjs';
import { hashKey } from '../src/access.mjs';
import { createApiServer } from '../src/server.mjs';
import { recoverExchanges,exchangeState } from '../src/live-exchange.mjs';
import { LiveRuntime } from '../src/live-runtime.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const data=join(root,'data/live');mkdirSync(data,{recursive:true});
const dbPath=resolve(process.env.SIGNALDESK_DB_PATH??join(data,'channel.db'));
mkdirSync(dirname(dbPath),{recursive:true});const lock=dbPath+'.live-lock';
try{writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});}catch(error){
  if(error.code!=='EEXIST')throw error;
  const pid=Number(readFileSync(lock,'utf8'));let running=true;
  try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')running=false;}
  if(running)throw new Error('A live server already owns this database.');
  unlinkSync(lock);writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
}
process.on('exit',()=>{try{if(readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);}catch{}});
const owner='00000000-0000-4000-8000-000000000012',workspace='10000000-0000-4000-8000-000000000012';
const hermes='20000000-0000-4000-8000-000000000012',codex='20000000-0000-4000-8000-000000000013';
const db=openDatabase(dbPath);migrate(db);
const keysFile=join(data,'keys.json');
const keys=existsSync(keysFile)?JSON.parse(readFileSync(keysFile,'utf8')):{hermes:randomBytes(32).toString('base64url'),codex:randomBytes(32).toString('base64url')};
transaction(db,()=>{
  db.prepare('INSERT INTO users VALUES (?,?) ON CONFLICT DO NOTHING').run(owner,'Local supervisor');
  db.prepare('INSERT INTO workspaces VALUES (?,?,?) ON CONFLICT DO NOTHING').run(workspace,'SignalDesk live test',owner);
  db.prepare("INSERT INTO workspace_members VALUES (?,?,'owner') ON CONFLICT DO NOTHING").run(workspace,owner);
  for(const [id,name,type,key] of [[hermes,'Hermes','B',keys.hermes],[codex,'Codex','A',keys.codex]]) {
    db.prepare("INSERT INTO entities(id,workspace_id,owner_user_id,name,description,capabilities,connection_type,category_grants) VALUES (?,?,?,?,?,'[\"greeting\"]',?,'[]') ON CONFLICT DO NOTHING")
      .run(id,workspace,owner,name,`${name}: real installed agent; bounded local greeting only.`,type);
    const credential=db.prepare('SELECT key_hash FROM entity_credentials WHERE entity_id=? AND revoked_at IS NULL').get(id);
    if(credential&&credential.key_hash!==hashKey(key))throw new Error('Credential file does not match the database; refusing to rotate silently.');
    if(!credential)db.prepare('INSERT INTO entity_credentials VALUES (?,?,?,?,NULL)').run(randomUUID(),id,hashKey(key),new Date().toISOString());
  }
  db.prepare('INSERT INTO live_pairs VALUES (?,?,?) ON CONFLICT DO NOTHING').run(workspace,hermes,codex);
});
if(!existsSync(keysFile))writeFileSync(keysFile,JSON.stringify(keys),{mode:0o600});
recoverExchanges(db);
const port=Number(process.env.SIGNALDESK_PORT??3000),base=`http://127.0.0.1:${port}`;
writeFileSync(join(data,'hermes-connection.json'),JSON.stringify({base,key:keys.hermes}),{mode:0o600});
const runtimeConfig=JSON.parse(readFileSync(join(data,'runtime.json'),'utf8'));
const runtime=new LiveRuntime({db,base,workspace,receiver:codex,key:keys.codex,codex:runtimeConfig.codex,hermes:runtimeConfig.hermes,
  evidenceDirectory:join(data,'evidence'),agentDirectory:join(data,'agent-work')});
mkdirSync(runtime.agentDirectory,{recursive:true});
const api=createApiServer(db,{localUserId:owner,localWorkspaceId:workspace,live:runtime});
await new Promise((r,j)=>{api.once('error',j);api.listen(port,'127.0.0.1',r);});
console.log(`SignalDesk live chat: ${base} — actual Hermes and Codex, SQLite, no simulated answers.`);
const controller=new AbortController();
const expiry=setInterval(()=>{for(const name of runtime.controllers.keys()){
  const id=name.split(':')[0];if(['expired','stopped'].includes(exchangeState(db,id)?.state))runtime.stop(id);
}},250);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>controller.abort());
try{await runtime.run(controller.signal);}finally{clearInterval(expiry);await runtime.close();api.close();api.closeAllConnections();db.close();}
