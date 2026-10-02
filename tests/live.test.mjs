// Deterministic core/transport checks only. These are NOT the live-agent acceptance proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture,listen,closeServer } from './helpers.mjs';
import { openDatabase } from '../src/database.mjs';
import { hashKey } from '../src/access.mjs';
import { demo } from '../src/seed.mjs';
import { createApiServer } from '../src/server.mjs';
import { createMessage } from '../src/dashboard.mjs';
import { armExchange,sendGreeting,claimExchange,replyExchange,stopExchange,recoverExchanges,readLiveInbox,exchangeState } from '../src/live-exchange.mjs';
import { codexArguments,peerPrompt,runProcess } from '../src/live-runtime.mjs';

function setup(){const f=fixture();f.db.prepare('INSERT INTO live_pairs VALUES (?,?,?)').run(demo.workspace,demo.research,demo.writing);
  return {...f,sender:{kind:'entity',entity_id:demo.research,workspace_id:demo.workspace},receiver:{kind:'entity',entity_id:demo.writing,workspace_id:demo.workspace}};}
const content={to_id:demo.writing,body:'Transport test greeting'};
const response={body:'Unit-test transport payload, not an AI reply',session_id:'00000000-0000-4000-8000-000000000123'};
function sent(f){const x=armExchange(f.db,f.owner,demo.workspace);const r=sendGreeting(f.db,f.sender,content,'hello-'+x.id);return {...x,...r.exchange};}
function finish(f,x){claimExchange(f.db,f.receiver,demo.workspace);return replyExchange(f.db,f.receiver,demo.workspace,x.id,response,'reply-'+x.id);}

test('ADR-012 core creates exactly two-member DM, preserves sender identity, deduplicates and reuses DM',()=>{
  const f=setup();try{
    assert.throws(()=>sendGreeting(f.db,f.sender,content,'k'),{code:'exchange_not_armed'});
    const x=armExchange(f.db,f.owner,demo.workspace);
    assert.throws(()=>sendGreeting(f.db,f.sender,{...content,to_id:demo.research},'self'),{code:'invalid_recipient'});
    assert.throws(()=>sendGreeting(f.db,f.sender,{...content,to_id:'foreign'},'foreign'),{code:'invalid_recipient'});
    const r=sendGreeting(f.db,f.sender,{...content,sender:demo.writing},'k');assert.equal(r.message.sender,demo.research);
    assert.notEqual(r.message.conversation_id,demo.group);
    assert.equal(f.db.prepare('SELECT count(*) n FROM conversation_members WHERE conversation_id=?').get(r.message.conversation_id).n,2);
    assert.equal(sendGreeting(f.db,f.sender,content,'k').message.id,r.message.id);
    assert.throws(()=>sendGreeting(f.db,f.sender,{...content,body:'changed'},'k'),{code:'idempotency_conflict'});
    assert.throws(()=>sendGreeting(f.db,f.sender,content,'new-key'),{code:'exchange_not_armed'});
    finish(f,x);const next=sent(f);assert.equal(next.conversation_id,r.message.conversation_id);
  }finally{f.close();}
});
test('ADR-012 durable claim admits one worker; crash recovery never reruns claimed work',()=>{
  const f=setup();const second=openDatabase(f.path);try{
    const x=sent(f);assert.equal(claimExchange(f.db,f.receiver,demo.workspace).id,x.id);
    assert.equal(claimExchange(second,f.receiver,demo.workspace),null);
    recoverExchanges(second);assert.equal(exchangeState(f.db,x.id).state,'uncertain');
    assert.equal(claimExchange(f.db,f.receiver,demo.workspace),null);
    assert.throws(()=>replyExchange(f.db,f.receiver,demo.workspace,x.id,response,'late'),{code:'exchange_not_claimed'});
  }finally{second.close();f.close();}
});
test('ADR-012 reply and read survive restart; reply retries produce one message and never another run',()=>{
  const f=setup();try{
    const x=sent(f);const r=finish(f,x);
    assert.equal(replyExchange(f.db,f.receiver,demo.workspace,x.id,response,'reply-'+x.id).message.id,r.message.id);
    assert.throws(()=>replyExchange(f.db,f.receiver,demo.workspace,x.id,response,'another-key'),{code:'exchange_not_claimed'});
    const reopened=openDatabase(f.path);try{
      recoverExchanges(reopened);assert.equal(exchangeState(reopened,x.id).state,'replied');
      assert.equal(claimExchange(reopened,f.receiver,demo.workspace),null);
      assert.equal(readLiveInbox(reopened,f.sender,demo.workspace)[0].message.id,r.message.id);
      assert.equal(readLiveInbox(f.db,f.sender,demo.workspace).length,0);assert.ok(exchangeState(f.db,x.id).read_at);
      assert.equal(f.db.prepare('SELECT count(*) n FROM messages WHERE conversation_id=?').get(x.conversation_id).n,2);
    }finally{reopened.close();}
  }finally{f.close();}
});
test('ADR-012 Stop, expiration and human-only arm block further writes and model claims',()=>{
  const f=setup();try{
    assert.throws(()=>armExchange(f.db,f.sender,demo.workspace),{code:'forbidden'});
    let x=sent(f);claimExchange(f.db,f.receiver,demo.workspace);
    assert.throws(()=>stopExchange(f.db,f.receiver,demo.workspace,x.id),{code:'forbidden'});
    stopExchange(f.db,f.owner,demo.workspace,x.id);
    assert.throws(()=>replyExchange(f.db,f.receiver,demo.workspace,x.id,response,'stopped'),{code:'exchange_not_claimed'});
    x=sent(f);f.db.prepare('UPDATE live_exchanges SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',x.id);
    assert.equal(claimExchange(f.db,f.receiver,demo.workspace),null);assert.equal(exchangeState(f.db,x.id).state,'expired');
    assert.throws(()=>createMessage(f.db,f.sender,demo.workspace,x.conversation_id,{body:'bypass'}),{code:'live_scope_only'});
  }finally{f.close();}
});
test('ADR-012 raw HTTP enforces identities, no human fallback, no legacy task/message bypass',async()=>{
  const f=setup();for(const [id,key] of [[demo.research,'hermes-test'],[demo.writing,'codex-test']])f.db.prepare('INSERT INTO entity_credentials VALUES (?,?,?,?,NULL)').run(id,id,hashKey(key),new Date().toISOString());
  const server=createApiServer(f.db,{live:{}}),base=await listen(server);
  async function request(path,body,key){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(key?{Authorization:`Bearer ${key}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return r.status;}
  try{
    assert.equal(await request('/v1/live/arm',{},'hermes-test'),403);
    assert.equal(await request('/v1/live/arm',{},'invalid-test'),401);
    assert.equal(await request('/v1/live/arm',{}),201);
    assert.equal(await request('/v1/live/messages',content),403);
    assert.equal(await request('/v1/live/messages',content,'codex-test'),403);
    assert.equal(await request('/v1/live/inbox',undefined,'codex-test'),403);
    assert.equal(await request('/v1/tasks',f.body,'hermes-test'),403);
    assert.equal(await request(`/v1/conversations/${demo.group}/messages`,{body:'bypass'},'hermes-test'),403);
  }finally{await closeServer(server);f.close();}
});
test('ADR-012 invocation uses isolated config, read-only sandbox and stdin; shell metacharacters stay literal',async()=>{
  const args=codexArguments('empty-dir','answer.txt');
  for(const flag of ['--ignore-user-config','read-only','--skip-git-repo-check','shell_tool','unified_exec','apps','plugins','hooks'])assert.ok(args.includes(flag));
  assert.equal(args.at(-1),'-');assert.ok(!args.includes('resume'));
  const input='$(whoami) `code` </peer_content> "quoted"\nsecond line';
  const echoed=await runProcess(process.execPath,['-e','process.stdin.pipe(process.stdout)'],{input,timeoutMs:1000});
  assert.equal(echoed.stdout,input);assert.ok(!peerPrompt(input).includes('</peer_content>'));
  await assert.rejects(runProcess(process.execPath,['-e','setTimeout(()=>{},10000)'],{input:'',timeoutMs:50}),/run_timeout/);
});
