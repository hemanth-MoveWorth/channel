import { createServer } from 'node:http';
import { authenticateEntity,listEntities } from './access.mjs';
import { createTask,getTask,transitionTask } from './tasks.mjs';
import { AppError } from './errors.mjs';
import { demo } from './seed.mjs';
import { decideApproval } from './approvals.mjs';
import { listTasks,listApprovals,listConversations,createConversation,listMessages,createMessage,inbox } from './dashboard.mjs';
import { readFileSync } from 'node:fs';
import { liveStatus,armExchange,stopExchange,sendGreeting,replyExchange,readLiveInbox,rejectLiveWrite } from './live-exchange.mjs';
const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']]]);

async function json(req) {
  if (req.headers['content-type']?.split(';')[0].trim()!=='application/json') throw new AppError(415,'invalid_content_type','Use application/json.');
  const chunks=[]; let size=0;
  for await (const chunk of req) {
    size+=chunk.length;
    if(size>65536) throw new AppError(413,'request_too_large','Request exceeds 64 KiB.');
    chunks.push(chunk);
  }
  try {
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!body || Array.isArray(body) || typeof body!=='object') throw new Error();
    return body;
  } catch { throw new AppError(400,'invalid_json','Expected a JSON object.'); }
}
export function createApiServer(db,{localUserId=demo.user,localWorkspaceId=demo.workspace,assetRoot=new URL('../web/',import.meta.url),live=null}={}) {
  return createServer(async(req,res)=>{
    try {
      const base=`http://127.0.0.1:${res.socket.localPort}`;
      if (req.headers.host!==new URL(base).host) throw new AppError(403,'forbidden','Invalid local host.');
      if (req.headers.origin && req.headers.origin!==base) throw new AppError(403,'forbidden','Cross-origin requests are not allowed.');
      const auth=req.headers.authorization;
      let actor;
      if (auth!==undefined) {
        if (!auth.startsWith('Bearer ') || auth.length<=7) throw new AppError(401,'unauthorized','Expected an entity bearer key.');
        actor=authenticateEntity(db,auth.slice(7));
      } else actor={kind:'human',user_id:localUserId}; // ADR-003 trusted loopback human UI.
      const url=new URL(req.url,base); let data; let status=200;
      const workspace=actor.kind==='entity'?actor.workspace_id:localWorkspaceId;
      const liveAssets=new Map([['/',['live.html','text/html; charset=utf-8']],['/live.js',['live.js','text/javascript; charset=utf-8']],['/live.css',['live.css','text/css; charset=utf-8']]]);
      const asset=live&&liveAssets.has(url.pathname)?liveAssets.get(url.pathname):assets.get(url.pathname);
      if(req.method==='GET'&&asset) {
        const [file,type]=asset;
        const content=readFileSync(new URL(file,assetRoot));
        res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
          'Content-Security-Policy':"default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
        res.end(content);return;
      }
      if(live&&url.pathname==='/v1/live'&&req.method==='GET') {
        data={...liveStatus(db,actor,workspace),runtime:live.status?.()??{}};
      } else if(live&&['/v1/live/arm','/v1/live/start'].includes(url.pathname)&&req.method==='POST') {
        await json(req);data=armExchange(db,actor,workspace);status=201;
        if(url.pathname.endsWith('/start'))live.start?.(data);
      } else if(live&&/^\/v1\/live\/[^/]+\/stop$/.test(url.pathname)&&req.method==='POST') {
        await json(req);const id=decodeURIComponent(url.pathname.split('/')[3]);
        data=stopExchange(db,actor,workspace,id);live.stop?.(id);
      } else if(live&&url.pathname==='/v1/live/messages'&&req.method==='POST') {
        data=sendGreeting(db,actor,await json(req),req.headers['idempotency-key']);status=data.replayed?200:201;
      } else if(live&&url.pathname==='/v1/live/inbox'&&req.method==='GET') {
        data=readLiveInbox(db,actor,workspace);
      } else if(live&&/^\/v1\/live\/[^/]+\/reply$/.test(url.pathname)&&req.method==='POST') {
        data=replyExchange(db,actor,workspace,decodeURIComponent(url.pathname.split('/')[3]),await json(req),req.headers['idempotency-key']);status=data.replayed?200:201;
      } else if(req.method==='GET'&&url.pathname==='/v1/tasks') {
        data=listTasks(db,actor,workspace,url.searchParams);
      } else if(req.method==='GET'&&url.pathname==='/v1/approvals') {
        data=listApprovals(db,actor,workspace,url.searchParams.get('state')??'pending');
      } else if(req.method==='GET'&&url.pathname==='/v1/conversations') {
        data=listConversations(db,actor,workspace);
      } else if(req.method==='POST'&&url.pathname==='/v1/conversations') {
        data=createConversation(db,actor,workspace,await json(req));status=201;
      } else if(/^\/v1\/conversations\/[^/]+\/messages$/.test(url.pathname)&&['GET','POST'].includes(req.method)) {
        const id=decodeURIComponent(url.pathname.split('/')[3]);
        if(req.method==='GET')data=listMessages(db,actor,workspace,id);
        else {data=createMessage(db,actor,workspace,id,await json(req));status=201;}
      } else if(req.method==='GET'&&url.pathname==='/v1/inbox') {
        data=inbox(db,actor,workspace);
      } else if (req.method==='POST' && url.pathname==='/v1/tasks') {
        rejectLiveWrite(db,actor);
        const input=await json(req);
        const result=createTask(db,actor,input,req.headers['idempotency-key']); data=result.task;
        status=result.created?201:200;
      } else if (req.method==='GET' && /^\/v1\/tasks\/[^/]+$/.test(url.pathname)) {
        data=getTask(db,actor,decodeURIComponent(url.pathname.split('/')[3]));
      } else if (req.method==='POST' && /^\/v1\/tasks\/[^/]+\/transition$/.test(url.pathname)) {
        const input=await json(req);
        // Caller cannot smuggle internal manualRetry/approvalDecision options.
        data=transitionTask(db,actor,decodeURIComponent(url.pathname.split('/')[3]),{to_state:input.to_state,reason:input.reason});
      } else if(req.method==='POST' && /^\/v1\/tasks\/[^/]+\/(approve|reject)$/.test(url.pathname)) {
        await json(req); // A decision has no caller-provided identity/grants.
        data=decideApproval(db,actor,decodeURIComponent(url.pathname.split('/')[3]),url.pathname.endsWith('/approve')?'approved':'rejected');
      } else if (req.method==='GET' && url.pathname==='/v1/entities') {
        data=listEntities(db,actor,actor.kind==='entity'?actor.workspace_id:localWorkspaceId,url.searchParams.get('capability'));
      } else if (req.method==='GET' && /^\/v1\/entities\/[^/]+$/.test(url.pathname)) {
        const id=decodeURIComponent(url.pathname.split('/')[3]);
        data=listEntities(db,actor,actor.kind==='entity'?actor.workspace_id:localWorkspaceId).find(e=>e.id===id);
        if (!data) throw new AppError(404,'not_found','Entity not found.');
      } else throw new AppError(404,'not_found','This route is not implemented in the current work package.');
      res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({data}));
    } catch (error) {
      const known=error instanceof AppError;
      res.writeHead(known?error.status:500,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({error:{code:known?error.code:'internal_error',message:known?error.message:'Request failed.'}}));
    }
  });
}
