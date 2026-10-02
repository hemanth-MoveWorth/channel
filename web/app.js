const $=id=>document.getElementById(id);
const state={entities:[],conversations:[],selected:localStorage.getItem('signaldesk.conversation')??'',offset:0,limit:10,busy:false,loading:false};
const signatures=new Map();
function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
function changed(id,value,render){const key=JSON.stringify(value);if(signatures.get(id)===key)return;signatures.set(id,key);render();}
function name(id){return id==='human'?'You':state.entities.find(e=>e.id===id)?.name??id;}
function option(value,label){const o=node('option',label);o.value=value;return o;}
function empty(target,text){target.replaceChildren(node('p',text,'empty'));}
function error(err){$('notice').textContent=err.message;$('notice').hidden=false;}
async function api(path,body){const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error?.message??'Request failed');return data.data;}
async function act(fn){if(state.busy)return;state.busy=true;$('notice').hidden=true;try{await fn();await refresh();}catch(err){error(err);}finally{state.busy=false;}}
function button(label,fn,cls='secondary'){const b=node('button',label,cls);b.type='button';b.addEventListener('click',()=>act(async()=>{b.disabled=true;try{await fn();}finally{b.disabled=false;}}));return b;}
function renderEntities(){changed('entities',state.entities,()=>{
  $('entity-count').textContent=state.entities.length;$('entities').replaceChildren();
  for(const e of state.entities){const card=node('article',undefined,'entity');card.append(node('strong',e.name),node('p',`Type ${e.connection_type} · ${e.availability}`,'muted small'));
    for(const c of e.capabilities)card.append(node('span',typeof c==='string'?c:JSON.stringify(c),'tag'));
    const d=node('details');d.append(node('summary','View profile'),node('p',e.description),node('p',`Verified permissions: ${JSON.stringify(e.verified_permissions)}`),node('p',e.webhook_url?'Webhook configured':'No webhook configured'));card.append(d);$('entities').append(card);
  }
  if(!state.entities.length)empty($('entities'),'No entities connected yet.');
  const selected=new Set([...$('member-options').querySelectorAll('input:checked')].map(e=>e.value));$('member-options').replaceChildren();
  for(const e of state.entities){const l=node('label');const c=node('input');c.type='checkbox';c.value=e.id;c.checked=selected.has(e.id);c.addEventListener('change',orchestrators);l.append(c,document.createTextNode(e.name));$('member-options').append(l);}orchestrators();
});}
function orchestrators(){const s=$('conversation-form').elements.orchestrator_entity_id;const prior=s.value;const members=new Set([...$('member-options').querySelectorAll('input:checked')].map(e=>e.value));s.replaceChildren(option('','No orchestrator'));for(const e of state.entities.filter(e=>e.connection_type==='A'&&members.has(e.id)))s.append(option(e.id,e.name));if([...s.options].some(o=>o.value===prior))s.value=prior;}
function renderConversations(){
  if(!state.conversations.some(c=>c.id===state.selected))state.selected=state.conversations[0]?.id??'';
  changed('conversations',[state.conversations,state.selected],()=>{const select=$('conversation-select');select.replaceChildren(option('','Choose a conversation'));for(const c of state.conversations)select.append(option(c.id,`${c.type==='group'?'Group':'DM'} · ${c.title}`));select.value=state.selected;});
  const current=state.conversations.find(c=>c.id===state.selected);
  $('conversation-meta').textContent=current?`${current.member_ids.map(name).join(', ')}${current.orchestrator_entity_id?` · Orchestrator: ${name(current.orchestrator_entity_id)}`:''}`:'Create a conversation to begin.';
  changed('assignees',[current,state.entities],()=>{const s=$('task-form').elements.assigned_entity_id,prior=s.value;s.replaceChildren();for(const id of current?.member_ids??[])s.append(option(id,name(id)));if([...s.options].some(o=>o.value===prior))s.value=prior;else if(current?.orchestrator_entity_id)s.value=current.orchestrator_entity_id;});
  for(const f of [$('task-form'),$('message-form')])for(const el of f.elements)el.disabled=!current;
}
function renderMessages(messages){changed('messages',[state.selected,messages,state.entities],()=>{const target=$('messages');const bottom=target.scrollHeight-target.scrollTop-target.clientHeight<60;target.replaceChildren();if(!messages.length)empty(target,'No messages yet. Start the conversation below.');
  for(const m of messages){const card=node('article',undefined,`message${m.kind==='task_result'?' result':''}`);const meta=node('div',undefined,'meta');meta.append(node('strong',name(m.sender)),node('span',`${m.kind.replaceAll('_',' ')} · ${new Date(m.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`));card.append(meta,node('p',m.body));if(m.task_id)card.append(node('span',`Task ${m.task_id.slice(0,8)}`,'muted small'));target.append(card);}if(bottom)target.scrollTop=target.scrollHeight;});}
function renderApprovals(items){changed('approvals',items,()=>{$('approval-count').textContent=items.length;const target=$('approvals');target.replaceChildren();if(!items.length)empty(target,'All clear. No requests need your approval.');
  for(const a of items){const card=node('article',undefined,'approval');card.dataset.taskId=a.task_id;card.append(node('strong',a.goal),node('p',`Attempt ${a.attempt} · Waiting for your decision`,'muted small'));const detail=node('details');detail.append(node('summary','Requested access'));for(const c of a.action.checks??[])detail.append(node('p',`${name(c.subject_entity_id)} · ${c.category ? 'category: '+c.category : c.action+' '+c.resource_type+' '+c.resource_id}`,'small'));const actions=node('div',undefined,'actions');actions.append(button('Approve',()=>api(`/v1/tasks/${a.task_id}/approve`,{}),''),button('Reject',()=>api(`/v1/tasks/${a.task_id}/reject`,{}),'danger'));card.append(detail,actions);target.append(card);}
});}
function renderTasks(page){changed('tasks',[page,state.entities],()=>{$('task-total').textContent=page.total;const target=$('tasks');target.replaceChildren();if(!page.items.length)empty(target,'No tasks match this view.');
  for(const t of page.items){const card=node('article',undefined,'task');card.dataset.taskId=t.id;card.append(node('strong',t.goal),node('span',t.state.replaceAll('_',' '),`state ${t.state}`),node('p',`${name(t.assigned_entity_id)} · ${t.delivery_receipt.replaceAll('_',' ')}`,'muted small'));
    card.append(node('p','Category: '+(t.category??'Unclassified'),'muted small'));if(t.reason)card.append(node('p',t.reason.replaceAll('_',' '),'small'));if(t.blocked_reason)card.append(node('p',t.blocked_reason,'small'));
    if(t.result)card.append(node('p',JSON.stringify(t.result),'small'));
    const actions=node('div',undefined,'actions');actions.append(button('Open conversation',async()=>{state.selected=t.conversation_id;localStorage.setItem('signaldesk.conversation',state.selected);}));
    if(!['completed','failed','cancelled'].includes(t.state))actions.append(button('Stop',()=>t.state==='awaiting_approval'?api(`/v1/tasks/${t.id}/reject`,{}):api(`/v1/tasks/${t.id}/transition`,{to_state:'cancelled',reason:'stopped_by_user'}),'danger'));
    card.append(actions);target.append(card);
  }
  $('previous').disabled=page.offset===0;$('next').disabled=page.offset+page.limit>=page.total;$('page-label').textContent=page.total?`${page.offset+1}–${Math.min(page.total,page.offset+page.limit)} of ${page.total}`:'0 tasks';
});}
async function refresh(){if(state.loading)return;state.loading=true;try{
  const [entities,conversations,tasks,approvals]=await Promise.all([api('/v1/entities'),api('/v1/conversations'),api(`/v1/tasks?limit=${state.limit}&offset=${state.offset}&status=${encodeURIComponent($('status-filter').value)}`),api('/v1/approvals?state=pending')]);
  state.entities=entities;state.conversations=conversations;renderEntities();renderConversations();renderTasks(tasks);renderApprovals(approvals);
  const id=state.selected;const messages=id?await api(`/v1/conversations/${id}/messages`):[];if(id===state.selected)renderMessages(messages);
  $('connection').textContent='Connected · Updated '+new Date().toLocaleTimeString();
}catch(err){$('connection').textContent='Connection interrupted';error(err);}finally{state.loading=false;}}
$('refresh').addEventListener('click',refresh);
$('conversation-select').addEventListener('change',e=>{state.selected=e.target.value;localStorage.setItem('signaldesk.conversation',state.selected);refresh();});
$('new-conversation').addEventListener('click',()=>{$('conversation-form').hidden=!$('conversation-form').hidden;});
$('conversation-form').addEventListener('submit',e=>{e.preventDefault();act(async()=>{const f=e.target;const result=await api('/v1/conversations',{type:f.elements.type.value,title:f.elements.title.value,member_ids:[...$('member-options').querySelectorAll('input:checked')].map(e=>e.value),orchestrator_entity_id:f.elements.orchestrator_entity_id.value||null});state.selected=result.id;localStorage.setItem('signaldesk.conversation',result.id);f.reset();f.hidden=true;orchestrators();});});
$('message-form').addEventListener('submit',e=>{e.preventDefault();act(async()=>{await api(`/v1/conversations/${state.selected}/messages`,{kind:'chat',body:e.target.elements.body.value});e.target.reset();});});
$('task-form').addEventListener('submit',e=>{e.preventDefault();act(async()=>{const c=state.conversations.find(c=>c.id===state.selected);await api('/v1/tasks',{workspace_id:c.workspace_id,conversation_id:c.id,assigned_entity_id:e.target.elements.assigned_entity_id.value,category:e.target.elements.category.value,goal:e.target.elements.goal.value});e.target.elements.goal.value='';state.offset=0;$('status-filter').value='';});});
$('status-filter').addEventListener('change',()=>{state.offset=0;refresh();});$('previous').addEventListener('click',()=>{state.offset=Math.max(0,state.offset-state.limit);refresh();});$('next').addEventListener('click',()=>{state.offset+=state.limit;refresh();});
refresh();setInterval(refresh,2000);
