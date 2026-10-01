import { createServer } from 'node:http';
import { authenticateEntity,listEntities } from './access.mjs';
import { createTask,getTask,transitionTask } from './tasks.mjs';
import { AppError } from './errors.mjs';
import { demo } from './seed.mjs';
import { decideApproval } from './approvals.mjs';

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
export function createApiServer(db,{localUserId=demo.user,localWorkspaceId=demo.workspace}={}) {
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
      if (req.method==='POST' && url.pathname==='/v1/tasks') {
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
