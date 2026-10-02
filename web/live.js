const $=id=>document.getElementById(id);
let current=null,busy=false,refreshing=false,lastMessages='';
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
async function api(path,body){const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error?.message??'Connection failed');return data.data;}
const labels={armed:'Armed · waiting for Hermes',sent:'Hermes sent a message',claimed:'Codex is responding',replied:'Codex replied',failed:'Agent run failed',uncertain:'Interrupted · no automatic rerun',expired:'Five-minute limit reached',stopped:'Stopped by you'};
async function refresh(){if(refreshing)return;refreshing=true;try{
  const data=await api('/v1/live');current=data.exchanges[0]??null;$('connection').textContent='Connected · local server';
  $('agents').replaceChildren(...data.entities.map(a=>{const card=el('div',undefined,'agent');card.append(el('strong',a.name),el('span',a.name==='Codex'?'Installed Codex · isolated turn':'Installed Hermes · MCP'));return card;}));
  const active=current&&['armed','sent','claimed'].includes(current.state);
  $('run').disabled=busy||active;$('arm').disabled=busy||active;$('stop').disabled=busy||!active;
  $('state').textContent=current?labels[current.state]:'No exchange yet';
  $('read').textContent=current?.read_at?'Hermes read the reply':current?.reply_id?'Waiting for Hermes to read':'Waiting for reply';
  const steps=[['Exchange armed',Boolean(current)],['Hermes sent greeting',Boolean(current?.message_id)],['Codex turn started',Boolean(current?.claimed_at)],['Codex replied',Boolean(current?.reply_id)],['Hermes read reply',Boolean(current?.read_at)]];
  $('timeline').replaceChildren(...steps.map(([label,done])=>el('li',(done?'✓ ':'○ ')+label,done?'done':'pending')));
  $('session').textContent=current?.session_id?'Actual Codex session: '+current.session_id:'';
  if(current?.read_at)$('instruction').textContent='Exchange complete. Hermes received Codex’s actual reply. Start another test whenever you want.';
  if(current?.failure_code){$('error').hidden=false;$('error').textContent=labels[current.state]+'. '+current.failure_code.replaceAll('_',' ')+'. No simulated answer was posted.';}
  const messages=current?.conversation_id?await api(`/v1/conversations/${current.conversation_id}/messages`):[];
  const signature=JSON.stringify(messages);if(signature!==lastMessages){lastMessages=signature;
    if(messages.length){$('messages').replaceChildren(...messages.map(m=>{const name=data.entities.find(a=>a.id===m.sender)?.name??'Unknown';const card=el('article',undefined,'message'+(name==='Codex'?' codex':''));const meta=el('div',undefined,'meta');meta.append(el('strong',name),el('time',new Date(m.created_at).toLocaleTimeString()));card.append(meta,el('p',m.body));return card;}));$('messages').scrollTop=$('messages').scrollHeight;}
    else $('messages').replaceChildren(el('p','Your conversation starts here.'),el('p','Results appear only when the agents respond.'));
  }
}catch(e){$('connection').textContent='Server disconnected';$('error').hidden=false;$('error').textContent=e.message;}finally{refreshing=false;}}
async function action(fn){if(busy)return;busy=true;$('error').hidden=true;try{await fn();}catch(e){$('error').hidden=false;$('error').textContent=e.message;}finally{busy=false;await refresh();}}
$('run').onclick=()=>action(async()=>{await api('/v1/live/start',{});$('instruction').textContent='Real Hermes is starting. It will discover Codex, send Hi through MCP, and wait for its reply.';});
$('arm').onclick=()=>action(async()=>{const x=await api('/v1/live/arm',{});$('instruction').textContent=`In Hermes: “Use SignalDesk to find Codex, send Hi with idempotency key hello-${x.id}, then check your inbox until it replies. Quote the reply and stop.”`;});
$('stop').onclick=()=>action(()=>api(`/v1/live/${current.id}/stop`,{}));
refresh();setInterval(refresh,1000);
