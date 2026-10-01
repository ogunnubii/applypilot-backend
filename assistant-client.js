
function paySummary(job){
 const wrap=el('div');wrap.className='job-pay';const rows=job.metadata?.pay||[];
 if(job.metadata?.available===false){wrap.append(el('strong','Posting availability needs review'));return wrap;}
 if(!rows.length){wrap.append(el('strong',job.metadata?.checkedAt?'Annual pay not disclosed':'Annual pay · checking employer posting'));return wrap;}
 for(const pay of rows){
  const number=n=>Number(n).toLocaleString('en-US',{maximumFractionDigits:0}),range=(lo,hi)=>number(lo)+(lo===hi?'':'–'+number(hi));
  wrap.append(el('strong',pay.currency+' '+range(pay.annualMin,pay.annualMax)+' / year'+(pay.estimated?' · estimate':'')));
  if(pay.estimated)wrap.append(el('small','Posted '+pay.currency+' '+range(pay.min,pay.max)+' / '+pay.period+'; assumes '+pay.assumption+' per year. Actual paid time may differ.'));
  if(pay.label)wrap.append(el('small',pay.label));
 }
 wrap.append(el('small','Employer-posted ranges; location and level may affect your offer.'));return wrap;
}
function nextMatchCandidate(job){
 const m=job.metadata||{};return ['saved','queued'].includes(job.status)&&!job.local_attempt_at&&!Number(job.attempts||0)&&!job.challenge&&!job.handoff_available&&m.available===true&&(m.strong===true||m.matched===true)&&m.eligibility?.eligible===true&&Date.now()-Date.parse(m.checkedAt||'')<86400000;
}
function renderNextMatch(jobs){
 let box=$('#next-match');if(!box){box=el('section');box.id='next-match';box.className='next-match';$('#workspace').prepend(box);}
 $('#workspace').prepend(box);
 if(box.contains(document.activeElement))return;
 const job=[...jobs].filter(nextMatchCandidate).sort((a,b)=>(Number(b.match_score)||0)-(Number(a.match_score)||0)||String(b.created_at||'').localeCompare(String(a.created_at||''))||String(a.id).localeCompare(String(b.id)))[0];
 const signature=JSON.stringify(job||null);if(box.dataset.signature===signature)return;box.dataset.signature=signature;
 box.replaceChildren(el('span','YOUR NEXT APPLICATION'));
 if(!job){box.append(el('h2','Checking for your next eligible match'),el('p','New recommendations appear after profile fit, employer availability and work eligibility are checked. Applications already attempted stay out of this list.'));return;}
 const heading=el('div');heading.className='next-match-heading';heading.append(el('h2',job.title),paySummary(job));box.append(heading,el('p',job.company+' · '+(job.metadata.location||'Location not listed')));
 if(!job.metadata.strong)box.append(el('p','Related role match — review the required seniority and skills before applying. Strong matches are the ones selected for automatic applications.'));
 box.append(el('p','Ranked #1 · '+job.match_score+'/100 role and eligibility score'),el('p',(job.metadata.reasons||[]).join(' · ')),el('small','This score compares saved role preferences and posting evidence; it is not a hiring probability.'));
 const actions=el('div');actions.className='actions';
 if(job.status==='saved'){
  const apply=el('button','Apply to this match next');apply.onclick=async()=>{apply.disabled=true;try{await api('/jobs/'+job.id+'/queue','POST',{});$('#notice').textContent='Top match queued. Your application worker will continue when ready.';await refresh(true);}catch(error){$('#notice').textContent=error.message;apply.disabled=false;}};actions.append(apply);
 }else actions.append(el('strong','Queued for your application worker'));
 const source=el('a','Read employer posting ↗');source.href=job.url;source.target='_blank';source.rel='noopener noreferrer';actions.append(source);box.append(actions);
 const pending=jobs.some(j=>j.evidence?.active);if(pending)box.append(el('small','A form already in progress finishes or pauses before the next queued application.'));
}


// Persist only an explicitly remembered session, never the password.
function restoreSession(){const remembered=localStorage.getItem('applypilot-remembered-token');if(remembered)sessionStorage.setItem('applypilot-token',remembered);return remembered||sessionStorage.getItem('applypilot-token')||'';}
function saveSession(value,remember){sessionStorage.setItem('applypilot-token',value);if(remember)localStorage.setItem('applypilot-remembered-token',value);else localStorage.removeItem('applypilot-remembered-token');}
function clearSession(){sessionStorage.removeItem('applypilot-token');localStorage.removeItem('applypilot-remembered-token');localStorage.setItem('applypilot-signout',String(Date.now()));}
window.addEventListener('storage',e=>{if(e.key==='applypilot-signout'){sessionStorage.removeItem('applypilot-token');location.reload();}});
function rememberOption(form){const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.name='remember';box.style.cssText='width:auto;display:inline;margin-right:8px';label.style.cssText='display:block;margin:12px 0';label.append(box,document.createTextNode('Keep me signed in on this computer for up to 30 days'));form.insertBefore(label,form.querySelector('button'));return box;}
const $=s=>document.querySelector(s);let token=restoreSession(),busy=false,lastSignature='',pendingHandoff=null,externalRecords=[],overviewSignature='';
const el=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e};
async function api(path,method='GET',data){const r=await fetch(((location.hostname.endsWith('.netlify.app')||location.hostname.endsWith('.pages.dev'))?'https://marvelous-vitality-production-c2d8.up.railway.app':'')+'/api'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d}
function field(form,label){const l=el('label',label),i=el('textarea');i.required=true;i.maxLength=4000;l.append(i);form.append(l);return i}
function chatQuestionTools(parent,question,job,input,researchJobs=[job]){
 const tools=el('div');tools.className='chat-question-tools';tools.style.cssText='margin:8px 0 16px';
 const copy=el('button','Copy question for ChatGPT');copy.type='button';
 const open=el('a','Open ChatGPT');open.href='https://chatgpt.com/';open.target='_blank';open.rel='noopener noreferrer';open.style.marginLeft='12px';
 const status=el('p');status.setAttribute('role','status');
 const help=el('small','Copy the question, ask in your own ChatGPT chat, then paste and check the answer here before saving. Or request an in-site AI draft from your approved facts, if enabled in your profile. Review drafts before saving. Do not guess personal facts.');help.style.display='block';
 let manual;
 copy.onclick=async()=>{
  const text=String(typeof question==='function'?question():question).trim();
  if(!text){status.textContent='Enter the employer question first.';return;}
  copy.disabled=true;
  try{
   if(!navigator.clipboard?.writeText)throw Error('Clipboard unavailable');
   await navigator.clipboard.writeText(text);manual?.remove();manual=null;
   status.textContent='Question copied. Open ChatGPT, paste it there, then bring the answer back. Nothing has been sent or saved.';
  }catch{
   if(!manual){manual=el('textarea');manual.readOnly=true;manual.setAttribute('aria-label','Question to copy manually');tools.append(manual);}
   manual.value=text;manual.focus();manual.select();
   status.textContent='Automatic copying is unavailable. Copy the selected question with Ctrl+C, or use your device’s Copy command.';
  }finally{copy.disabled=false;}
 };
 if(job&&input){
  const draft=el('button','Draft with my saved facts');draft.type='button';draft.onclick=async()=>{const q=String(typeof question==='function'?question():question).trim();if(!q){status.textContent='Enter the question first.';return;}if(input.value.trim()){status.textContent='Your answer is preserved. Clear it first if you want a new draft.';return;}draft.disabled=true;const original=input.value;status.textContent='Drafting from approved facts…';try{const result=await api('/jobs/'+job.id+'/draft-answer','POST',{question:q});if(input.value!==original){status.textContent='Your edits are preserved. Request a draft again if needed.';return;}if(result.answer){input.value=result.answer;input.dispatchEvent(new Event('input',{bubbles:true}));const holder=parent.closest('section');if(holder)holder.dataset.dirty='true';status.textContent='AI draft — review before saving. Based on: '+result.sources.join('; ');}else status.textContent=result.reason||'More facts are needed.';}catch(e){status.textContent=e.message;}finally{draft.disabled=false;}};tools.append(draft);
  const contexts=(researchJobs||[]).filter(Boolean);
  if(contexts.length===1){const sources=el('div'),research=el('button','Draft from public job page');research.type='button';research.onclick=async()=>{const q=String(typeof question==='function'?question():question).trim();if(!q){status.textContent='Enter the question first.';return;}if(input.value.trim()){status.textContent='Your answer is preserved. Clear it first if you want a cited public-page draft.';return;}research.disabled=true;sources.replaceChildren();const original=input.value;status.textContent='Drafting from the public job page…';try{const result=await api('/jobs/'+job.id+'/research-answer','POST',{question:q});if(input.value!==original){status.textContent='Your edits are preserved. Request the public-page draft again if needed.';return;}if(!result.answer){status.textContent=result.reason||'The cited public page could not answer this question.';return;}input.value=result.answer;input.dataset.researchDraft='true';input.dispatchEvent(new Event('input',{bubbles:true}));const holder=parent.closest('section');if(holder)holder.dataset.dirty='true';status.textContent='Cited public-page draft — check the sources and review before saving. It stays with this application.';const valid=[];for(const source of result.citations||[]){try{const u=new URL(source.url);if(u.protocol!=='https:')continue;const a=el('a',source.title||u.hostname);a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';valid.push(a);}catch{}}if(valid.length){sources.append(el('small','Sources: '));for(const [i,a] of valid.entries()){if(i)sources.append(document.createTextNode(' · '));sources.append(a);}}input.addEventListener('input',()=>{sources.replaceChildren();status.textContent='Edited application-only draft — review before saving.';},{once:true});}catch(e){status.textContent=e.message;}finally{research.disabled=false;}};tools.append(research,sources);}
 }
 tools.append(copy,open,help,status);parent.append(tools);
}
async function notificationSettings(){
 if($('#blocker-notifications'))return;
 const section=el('section');section.id='blocker-notifications';section.style.marginBottom='20px';
 const label=el('label'),toggle=el('input');toggle.type='checkbox';label.append(toggle,document.createTextNode(' Email me when an application needs my input'));
 const status=el('p');status.setAttribute('role','status');section.append(label,status);$('#workspace').prepend(section);
 const display=d=>{toggle.checked=!!d.enabled;status.textContent=!d.configured?'Email delivery is not connected yet. Your preference is saved; a verified sender must be configured.':d.failed?'Email delivery needs attention. Check the dashboard for all blockers.':d.enabled?'Blocker emails are enabled. Emails link directly to the paused application.':'Blocker emails are off.';};
 try{display(await api('/notifications'));}catch{status.textContent='Notification settings could not be loaded.';}
 toggle.onchange=async()=>{toggle.disabled=true;try{display(await api('/notifications','PUT',{enabled:toggle.checked}));}catch(e){status.textContent=e.message;toggle.checked=!toggle.checked;}finally{toggle.disabled=false}};
}
async function refresh(force=false){
 if(busy||activeHandoff)return;
 const [{jobs},health,history,operations,activity,continuations]=await Promise.all([api('/jobs'),api('/status'),api('/application-history'),api('/operations').catch(()=>null),api('/activity').catch(()=>null),api('/continuations').catch(()=>null)]);
 const waiting=new Map((continuations?.requests||[]).map(r=>[r.job_id,r]));
 for(const job of jobs)job.continuation=waiting.get(job.id);
 const evidence=new Map((operations?.applications||[]).map(j=>[j.id,j]));
 for(const job of jobs)job.evidence=evidence.get(job.id);
 externalRecords=history.records;
 $('#login').hidden=true;$('#workspace').hidden=false;$('#logout').hidden=false;
 notificationSettings();
 updateDiscovery();updateAIStatus();
 const current=jobs.filter(j=>j.status!=='duplicate');
 const interviews=interviewRecords(externalRecords,current);
 renderHistoryOverview(externalRecords,current);
 const externalInterviews=interviews.filter(r=>!current.some(j=>j.status==='interview'&&interviewIdentity(j)===interviewIdentity(r)));
 if(pendingHandoff){
  const target=current.find(j=>j.id===pendingHandoff.id);
  if(target?.handoff_available){pendingHandoff=null;document.querySelector('#preparing-browser')?.remove();await openHandoff(target);return;}
  if(!target||['submitted','interview','rejected','offer'].includes(target.status)||['Unconfirmed submission','Submission in progress'].includes(target.challenge)){
   const message=target?.challenge?.includes('submission')?'A submission may already have occurred. Check the employer receipt before restarting.':'Application preparation ended. Check its current status below.';
   pendingHandoff=null;document.querySelector('#preparing-browser')?.remove();$('#notice').textContent=message;force=true;
  }else if(Date.now()-pendingHandoff.started>180000){pendingHandoff=null;const banner=$('#preparing-browser');if(banner)banner.textContent='The live browser is taking longer than expected. Check the application below or try again when the worker is available.';force=true;}
 }
 renderBrowserReadiness(current);renderMissingAnswers(current);renderContinuationQueue(continuations);drainContinuations(continuations);renderLibraryLauncher();renderFocusControl();renderArchiveControl(current);if($('#career-overview'))$('#workspace').prepend($('#career-overview'));renderOperations(operations,activity);renderNextMatch(current);
 $('#status').textContent=current.length?`${current.length} tracked applications${health.workerOnline?'':' · Worker unavailable; saved answers are retained'}`:'No applications currently need completion.';
 $('#needs-count').textContent=current.filter(j=>j.evidence?j.evidence.blocked||j.evidence.stalled:['paused','needs_review'].includes(j.status)||j.status==='local_browser'&&j.local_phase==='blocked').length;
 $('#applying-count').textContent=current.filter(j=>j.evidence?j.evidence.active:!j.local_attempt_at&&(['queued','running'].includes(j.status)||j.status==='local_browser'&&j.local_phase==='ready')).length;
 $('#local-count').textContent=current.filter(j=>j.status==='local_browser').length;
 const totals=Object.fromEntries(['saved','submitted','interview','offer','rejected'].map(state=>[state,(state==='interview'?interviews.length:current.filter(j=>j.status===state).length)]));
 for(const [state,value] of Object.entries(totals)){const target=$('#'+(state==='saved'?'found':state)+'-count');if(target)target.textContent=value;}
 const outcomes=new Map();for(const r of [...current,...externalRecords].filter(r=>['interview','offer','rejected'].includes(r.status)))outcomes.set(interviewIdentity(r),r.status);
 const decided=outcomes.size,positive=[...outcomes.values()].filter(s=>s==='interview'||s==='offer').length;
 const success=$('#success-rate');if(success)success.textContent=decided?Math.round(positive*100/decided)+'%':'—';
 $('#worker-state').textContent=health.workerOnline?'● Worker connected · Progress updates automatically':'○ Worker offline · Saved information is retained';
 const signature=JSON.stringify([current,externalRecords]);
 if(!force&&(signature===lastSignature||$('#jobs').contains(document.activeElement)||$('#jobs').querySelector('[data-dirty="true"],details[open]')))return;
 lastSignature=signature;$('#jobs').replaceChildren();
 const attention=globalThis.ApplyPilotPolicy.attentionOrder(current),attentionPositions=new Map(attention.map((j,i)=>[j.id,i+1]));
 const blocked=j=>globalThis.ApplyPilotPolicy.needsInput(j);
 const rank=j=>blocked(j)?0:1+['local_browser','running','queued','saved','submitted','interview','rejected','offer'].indexOf(j.status);
 const updated=j=>Number.isFinite(Date.parse(j.updated_at))?Date.parse(j.updated_at):0;
 current.sort((a,b)=>rank(a)-rank(b)||(attentionPositions.has(a.id)&&attentionPositions.has(b.id)?attentionPositions.get(a.id)-attentionPositions.get(b.id):0)||(['saved','queued'].includes(a.status)&&a.status===b.status?(Number(b.match_score)||0)-(Number(a.match_score)||0):0)||updated(b)-updated(a)||String(a.id).localeCompare(String(b.id)));
 for(const r of externalInterviews){const card=interviewCard(r);card.id='external-'+r.id;$('#jobs').append(card);}
 for(const job of current){
  if(job.status==='interview'){const r=interviews.find(r=>interviewIdentity(r)===interviewIdentity(job));const card=interviewCard(r);card.id='job-'+job.id;$('#jobs').append(card);continue;}
  const card=el('article');card.id='job-'+job.id;card.className='job';card.dataset.search=(job.title+' '+job.company).toLowerCase();card.dataset.local=String(job.status==='local_browser');for(const key of ['active','blocked','stalled','worked','confirmed'])card.dataset[key]=String(!!job.evidence?.[key]);card.dataset.state=job.evidence?.awaiting||job.local_attempt_at&&!job.evidence?.confirmed&&job.status==='local_browser'?'awaiting':job.status==='local_browser'&&job.local_phase==='blocked'?'needs_review':job.status;const heading=el('div');heading.className='job-heading';const mark=el('span',(job.company||'A').slice(0,1).toUpperCase());mark.className='company-mark';const names=el('div');if(attentionPositions.has(job.id)){const counter=el('span',attentionPositions.get(job.id)+'/'+attention.length+' · Needs your input');counter.className='attention-position';counter.style.cssText='display:inline-block;font-size:14px;font-weight:750;color:#245a3c;background:#e9f4ec;border-radius:8px;padding:4px 9px;margin-bottom:7px';counter.setAttribute('aria-label','Application '+attentionPositions.get(job.id)+' of '+attention.length+' needing your input');names.append(counter);}names.append(el('h2',job.title),paySummary(job),el('small',job.company));if(job.metadata?.checkedAt){names.append(el('small',(job.match_score||0)+'/100 role and eligibility score · '+(job.metadata.location||'Location not listed')+(job.metadata.eligibility?.eligible?'':' · Eligibility needs confirmation')));}const badge=el('span',({saved:'Found',running:'Applying',queued:'Applying · queued',paused:'Blocked',needs_review:'Blocked',local_browser:job.evidence?.stalled?'Browser check needed':job.local_phase==='blocked'?(/^Ready for your review/.test(job.last_message||'')?'Ready for your review':'Needs your input'):job.local_attempt_at?'Awaiting receipt':'Applying · local',submitted:job.evidence?.confirmed?'Receipt recorded':'Submission needs evidence',interview:'Interview',rejected:'Rejected',offer:'Offer'})[job.status]);badge.className='badge '+(job.status==='local_browser'&&job.local_phase==='blocked'?'needs_review':job.status);heading.append(mark,names,badge);card.append(heading);
  if(job.evidence?.stalled)card.append(el('p','No recent browser activity has been received. Check the helper and employer tab; this form is not counted as actively filling.'));
  const updated=Date.parse(job.updated_at),stamp=el('p');stamp.className='last-updated';stamp.style.cssText='font-size:13px;color:#626c65;margin:8px 0';
  if(Number.isFinite(updated)){const time=el('time',new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(updated)));time.dateTime=new Date(updated).toISOString();stamp.append(document.createTextNode('Last updated: '),time);}else stamp.textContent='Last updated: unavailable';card.append(stamp);
  if(!['running','queued','local_browser'].includes(job.status)&&!job.handoff_available){const remove=el('button','Delete application permanently');remove.onclick=async()=>{if(!window.confirm('Permanently delete '+job.title+' at '+job.company+' and its application history and captured answers? This cannot be undone, does not withdraw an employer application, and discovery may find the listing again.'))return;remove.disabled=true;try{await api('/jobs/'+job.id,'DELETE',{confirm:job.id});await refresh(true);}catch(e){$('#notice').textContent=e.message;remove.disabled=false;}};card.append(remove);}
  if(['submitted','interview','rejected','offer'].includes(job.status)){
   card.append(el('p',job.confirmation||'Employer outcome recorded.'));
   if(job.evidence?.unverifiedOutcome)card.append(el('p','This status has no qualifying receipt text on file. It is excluded from the receipt total.'));
   const label=el('label','Employer outcome '),select=el('select');
   for(const [value,title] of [['','Choose outcome'],['interview','Interview'],['rejected','Rejected'],['offer','Offer']]){const o=el('option',title);o.value=value;select.append(o);}
   select.value=['interview','rejected','offer'].includes(job.status)?job.status:'';
   select.onchange=async()=>{if(!select.value)return;try{await api('/jobs/'+job.id+'/outcome','PUT',{status:select.value});await refresh(true);}catch(e){$('#notice').textContent=e.message;}};
   label.append(select);card.append(label);$('#jobs').append(card);continue;
  }
  if(job.status==='saved'){
   const posting=el('a','Read employer posting ↗');posting.href=job.url;posting.target='_blank';posting.rel='noopener noreferrer';card.append(posting);
   if(job.metadata?.available===false){card.append(el('p','This posting is absent from the current employer feed or its page could not be found. Automatic applications are held pending an availability check.'));$('#jobs').append(card);continue;}
   const local=job.execution_mode==='local';
   const p=el('p',local?'This profile uses your Windows browser. Open the extension to start this application.':'ApplyPilot can fill and submit routine steps using your saved profile. It will stop for verification, unknown facts and sensitive statements.');
   card.append(p);
   if(local){const a=el('a','Browser setup');a.href='https://marvelous-vitality-production-c2d8.up.railway.app/local-browser.html';card.append(a);}
   {const start=el('button',local?'Queue for my browser':'Apply automatically'),message=el('p');message.setAttribute('role','status');start.onclick=async()=>{start.disabled=true;try{await api('/jobs/'+job.id+'/queue','POST',{});await refresh(true);$('#notice').textContent=local?'Application queued. Keep your updated browser helper and signed-in dashboard open.':'Application queued. You can close this page; the hosted worker will continue.';}catch(e){message.textContent=e.message;start.disabled=false;}};card.append(start,message);}
   $('#jobs').append(card);continue;
  }
  if(['running','queued'].includes(job.status)){card.append(el('p',job.status==='running'?'Applying with your saved answers…':job.execution_mode==='local'?'Queued for your browser. Keep the signed-in dashboard and browser helper open.':'Queued for the hosted worker.'));$('#jobs').append(card);continue}
  const blocker=el('p',job.status==='local_browser'?(job.last_message||'Continue in your employer browser tab.'):job.blocker_message||job.challenge||'This application needs your input.');blocker.className='blocker';card.append(blocker);const actions=el('details');actions.className='job-actions';actions.append(el('summary',job.status==='local_browser'?'Continue application':'Resolve next step'));card.append(actions);
  const msg=el('p');msg.className='message';msg.setAttribute('role','status');actions.append(msg);
  const human=['CAPTCHA','Sign-in','Unconfirmed submission','Submission in progress','Sensitive action'].includes(job.challenge);
  let questions=[];try{questions=JSON.parse(job.required_fields_json||'[]')}catch{}
  const upload=job.challenge==='Upload needs review'||/upload|resume.*not found/i.test(job.blocker_message||'');
  const takeover=el('button',job.handoff_available?'Take over filled application':'Prepare live application');
  takeover.onclick=async()=>{
   if(pendingHandoff){$('#notice').textContent='Another live browser is being prepared. Wait for it or cancel opening it.';return;}
   takeover.disabled=true;takeover.textContent='Preparing browser…';
   try{const r=await api('/jobs/'+job.id+'/handoff/open','POST',{});if(r.available)await openHandoff(job);else{
    pendingHandoff={id:job.id,started:Date.now()};
    let banner=$('#preparing-browser');if(!banner){banner=el('section');banner.id='preparing-browser';banner.style.cssText='padding:20px;background:#e2ede7;border:2px solid #74ad91;border-radius:12px;margin-bottom:20px';$('#workspace').insertBefore(banner,$('#jobs').closest('.list-panel')||$('#jobs'));}
    banner.replaceChildren(el('p','Preparing the live browser for '+job.company+' — '+job.title+'. It will open here automatically when ready.'));
    banner.setAttribute('role','status');const cancel=el('button','Cancel opening');cancel.onclick=()=>{pendingHandoff=null;banner.remove();$('#notice').textContent='Automatic opening cancelled. The worker may still prepare this application.';};banner.append(cancel);
    await refresh(true);
   }}catch(e){msg.textContent=e.message;$('#notice').textContent=e.message;}finally{takeover.disabled=false;takeover.textContent=job.handoff_available?'Take over filled application':'Prepare live application';}
  };
  if(job.status!=='local_browser'){
   if(!job.handoff_available&&['Unconfirmed submission','Submission in progress'].includes(job.challenge))actions.append(el('p','Live restart is unavailable because a submission may already have occurred. Check the employer receipt using the employer link below.'));
   else card.insertBefore(takeover,actions);
  }
  if(job.status==='local_browser'){
   const resume=el('button','Continue application in my browser');resume.className='primary';
   resume.onclick=async()=>{
    resume.disabled=true;msg.textContent='Opening your existing employer tab…';actions.open=true;
    try{await focusLocalApplication(job.id);msg.textContent='Your employer form is open in Chrome. Continue where ApplyPilot stopped.';}
    catch(e){msg.textContent=e.message;}finally{resume.disabled=false;}
   };card.insertBefore(resume,actions);
   if(!job.local_attempt_at){const automatic=el('button','Resume automatically');automatic.onclick=async()=>{automatic.disabled=true;actions.open=true;msg.textContent='Resuming saved answers…';try{await resumeLocalApplication(job.id);msg.textContent='Routine steps resumed. The helper will stop if employer input is still needed.';await refresh(true);}catch(e){msg.textContent=e.message;}finally{automatic.disabled=false;}};card.insertBefore(automatic,actions);}
  }
  if(job.status!=='local_browser'&&!human&&!upload&&!job.handoff_available){
   const form=el('form');form.oninput=()=>{form.dataset.dirty='true'};
   const fields=[];
   if(questions.length){for(const question of [...new Set(questions)]){const input=field(form,question);fields.push({question,input});chatQuestionTools(form,question,job,input);}}
   else{const q=field(form,'Question shown on the employer form');q.maxLength=240;const input=field(form,'Your answer');fields.push({questionInput:q,input});chatQuestionTools(form,()=>q.value,job,input)}
   const rememberLabel=el('label'),remember=el('input');remember.type='checkbox';rememberLabel.append(remember,document.createTextNode('Remember these answers for this applicant'));form.append(rememberLabel);
   const submit=el('button','Save answers and continue');form.append(submit);
   form.onsubmit=async e=>{e.preventDefault();submit.disabled=true;busy=true;try{const answers=Object.fromEntries(fields.map(f=>[f.question||f.questionInput.value.trim(),f.input.value.trim()])),applicationOnly=fields.some(f=>f.input.dataset.researchDraft==='true');await api('/jobs/'+job.id+'/continue','POST',{answers,remember:remember.checked&&!applicationOnly});busy=false;await refresh(true);$('#notice').textContent='Answers saved. The worker will retry this application and submit if all requirements are satisfied.'}catch(e){msg.textContent=e.message}finally{busy=false;submit.disabled=false}};actions.append(form);
  }
  const link=el('a','Open this application on the employer site');link.href=job.url;link.target='_blank';link.rel='noopener';actions.append(link);
  if(human||upload)actions.append(el('p',job.challenge==='Unconfirmed submission'?'Check whether the employer received this application before trying again.':'Use Take over to work in the worker’s browser. The separate employer link starts a different browser session.'));
  const done=el('details');done.append(el('summary','I submitted this application'));
  const receiptForm=el('form'),receipt=field(receiptForm,'Employer confirmation reference or message');receipt.minLength=8;receipt.maxLength=300;
  const label=el('label'),check=el('input');check.type='checkbox';check.required=true;check.style.cssText='display:inline;width:auto;margin-right:8px';label.append(check,document.createTextNode('The employer confirmed receipt.'));receiptForm.append(label);
  const confirm=el('button','Confirm submitted');receiptForm.append(confirm);receiptForm.onsubmit=async e=>{e.preventDefault();confirm.disabled=true;busy=true;try{await api('/jobs/'+job.id+'/confirm','POST',{receipt:receipt.value});busy=false;await refresh(true);$('#notice').textContent='Submission recorded. The application is now shown as Submitted.'}catch(e){msg.textContent=e.message}finally{busy=false;confirm.disabled=false}};done.append(receiptForm);actions.append(done);$('#jobs').append(card);
 }

 applyFilters();
 const linked=document.getElementById(location.hash.slice(1));
 if(linked?.classList.contains('job')){linked.hidden=false;linked.style.outline='3px solid #74ad91';const details=linked.querySelector('details');if(details)details.open=true;if(!linked.dataset.focused){linked.scrollIntoView?.({block:'center'});linked.dataset.focused='true';}}
}
function renderMissingAnswers(jobs){
 let section=$('#missing-answers');
 if(section?.dataset.dirty==='true'||section?.querySelector('details[open]'))return;
 const signature=JSON.stringify(jobs.map(j=>[j.id,j.status,j.challenge,j.required_fields_json,j.answers_json,j.handoff_available,j.application_only_questions,j.local_phase,j.local_attempt_at,j.continuation?.state]));
 if(section?.dataset.signature===signature)return;
 if(!section){section=el('section');section.id='missing-answers';section.style.cssText='padding:24px;margin:20px 0;border:2px solid #74ad91;border-radius:14px;background:#f4faf6';$('#workspace').insertBefore(section,$('#jobs').closest('.list-panel')||$('#jobs'));}
 section.dataset.signature=signature;section.replaceChildren(el('h2','Complete missing answers'));
 section.append(el('p','Answer repeated questions once, then save. Ready browser forms continue one at a time while your signed-in dashboard and helper stay open. Employers may ask more questions later.'));
 section.append(el('small','Questions shared by more applications appear first. Unknown facts and employer declarations still need your input.'));
 const form=el('form'),groups=new Map(),eligible=[];
 const groupKey=(job,question)=>JSON.stringify([job.applicant_id,question,(job.application_only_questions||[]).includes(question)?job.id:'']);
 const human=new Set(['CAPTCHA','Sign-in','Unconfirmed submission','Submission in progress','Sensitive action','Upload needs review']);
 let employerOnly=0;
 for(const job of jobs){
  if(!['paused','needs_review'].includes(job.status)&&!(job.status==='local_browser'&&job.local_phase==='blocked'))continue;
  if(job.local_attempt_at||['queued','dispatching'].includes(job.continuation?.state))continue;
  if(human.has(job.challenge)){employerOnly++;continue;}
  let questions=[];try{questions=JSON.parse(job.required_fields_json||'[]')}catch{}
  questions=[...new Set(questions)].filter(q=>typeof q==='string'&&q.trim());
  const usable=questions.filter(q=>q.length<=240&&!/^required field\s*[*?]?$/i.test(q.trim())&&!/AI policy|cards\[|field\d+|\b(certify|attest|signature|arbitration|arbitrate|waiver|acknowledge|criminal|convictions|agree that|agree to|consent|passport number|ssn|payment)\b/i.test(q));
  if(!usable.length){employerOnly++;continue;}
  let savedAnswers={};try{savedAnswers=JSON.parse(job.answers_json||'{}')||{}}catch{}
  const answered=q=>typeof savedAnswers[q]==='string'&&savedAnswers[q].trim();
  eligible.push({job,questions,usable,savedAnswers});
  for(const question of usable.filter(q=>!answered(q))){const applicationOnly=(job.application_only_questions||[]).includes(question),key=groupKey(job,question);if(!groups.has(key))groups.set(key,{question,jobs:[],applicationOnly});groups.get(key).jobs.push(job);}
 }
 const ready=eligible.filter(({job,questions,savedAnswers})=>!job.handoff_available&&questions.every(q=>typeof savedAnswers[q]==='string'&&savedAnswers[q].trim()));
 section.hidden=!groups.size&&!ready.length;
 if(section.hidden)return;
 for(const group of [...groups.values()].sort((a,b)=>b.jobs.length-a.jobs.length)){
  const label=el('label');label.style.cssText='display:block;margin:18px 0';label.append(el('strong',group.question));
  const context=el('small',group.jobs.map(j=>j.company+' - '+j.title).join('; '));context.style.display='block';label.append(context);
  const input=el('textarea');input.maxLength=4000;input.style.cssText='display:block;width:100%;min-height:75px;margin-top:6px;padding:10px;border:1px solid #baccc0;border-radius:8px';input.dataset.answerKey=groupKey(group.jobs[0],group.question);if(group.applicationOnly)input.dataset.applicationOnly='true';input.setAttribute('aria-label',group.question);label.append(input);group.input=input;form.append(label);chatQuestionTools(form,group.question,group.jobs[0],input,group.jobs);
 }
 const message=el('p');message.setAttribute('role','status');
 if(groups.size||ready.length){
  const autofill=el('button','Fill from saved profile');autofill.type='button';form.prepend(autofill);
  autofill.onclick=async()=>{autofill.disabled=true;try{const {applicants=[]}=await api('/applicants');let count=0;for(const group of groups.values()){if(group.input.value.trim())continue;const profile=applicants.find(p=>p.id===group.jobs[0].applicant_id);if(!profile)continue;const saved=group.applicationOnly?{}:profile.reusableAnswers||{};const answer=preparedProfileAnswer(group.question,profile,saved);if(typeof answer==='string'&&answer.trim()){group.input.value=answer;count++;}}if(count)section.dataset.dirty='true';message.textContent=`Filled ${count} answers from your saved facts. Review and save them below. Unknown facts remain blank.`;}catch(error){message.textContent=error.message;}finally{autofill.disabled=false}};
  const rememberLabel=el('label'),remember=el('input');remember.type='checkbox';remember.checked=true;rememberLabel.append(remember,document.createTextNode(' Remember my answers for matching questions on future applications'));form.append(rememberLabel);
  const submit=el('button','Save answers and continue ready applications');submit.style.cssText='display:block;margin-top:18px;background:#214d36;color:white';form.append(submit,message);
  form.oninput=()=>{section.dataset.dirty='true'};
  if(!groups.size)form.prepend(el('p',`${ready.length} applications have all their answers saved and are ready to continue.`));
  form.onsubmit=async e=>{e.preventDefault();const filled=[...groups.values()].filter(g=>g.input.value.trim());if(!filled.length&&!ready.length){message.textContent='Enter at least one answer. You can leave questions blank and return later.';return;}submit.disabled=true;busy=true;let saved=0,queued=0;const failures=[];
   try{for(const {job,questions,usable,savedAnswers} of eligible){const answers={};for(const q of usable){const g=groups.get(groupKey(job,q));if(g?.jobs.some(j=>j.id===job.id)&&g.input.value.trim())answers[q]=g.input.value.trim();}const combined={...savedAnswers,...answers};if(!Object.keys(answers).length&&!ready.some(r=>r.job.id===job.id))continue;
    try{for(const [question,answer] of Object.entries(answers)){const group=groups.get(groupKey(job,question)),allowReuse=remember.checked&&!group?.applicationOnly&&group?.input.dataset.researchDraft!=='true';await api('/jobs/'+job.id+'/answers','PUT',{question,answer,remember:allowReuse});saved++;}
     if(!job.handoff_available&&questions.every(q=>typeof combined[q]==='string'&&combined[q].trim())){
      if(job.status==='local_browser')await api('/jobs/'+job.id+'/continuation','POST',{});
      else await api('/jobs/'+job.id+'/continue','POST',{answers:combined,remember:false});
      queued++;
     }
    }catch(error){failures.push(job.company+': '+error.message);}
   }
   message.textContent=`Saved ${saved} answers. ${queued} applications queued to continue.`+(failures.length?' Some applications need attention: '+failures.join('; '):' Ready browser forms will resume one at a time with your connected helper. Unanswered questions and employer-only steps remain paused.');
   const pending=new Map([...groups].map(([key,g])=>[key,{value:g.input.value,researchDraft:g.input.dataset.researchDraft==='true'}]));
   section.dataset.dirty='false';section.querySelector('details')?.removeAttribute('open');delete section.dataset.signature;$('#notice').textContent=message.textContent;
   busy=false;
   try{await refresh(true);const next=$('#missing-answers');for(const input of next.querySelectorAll('textarea')){const saved=pending.get(input.dataset.answerKey);if(saved?.value){input.value=saved.value;if(saved.researchDraft)input.dataset.researchDraft='true';next.dataset.dirty='true';}}}catch(error){section.dataset.dirty='true';message.textContent+=' Refresh failed; your entered answers are retained. '+error.message;$('#notice').textContent=message.textContent;}
   }finally{busy=false;submit.disabled=false;}
  };
 }else form.append(el('p','No readable missing-answer questions are available right now.'));
 const disclosure=el('details');disclosure.append(el('summary',`Review ${groups.size} missing question${groups.size===1?'':'s'}${ready.length?' · '+ready.length+' ready to continue':''}`),form);section.append(disclosure,el('p',`${employerOnly} applications need an employer-site step, such as verification, a declaration, an upload, or a question whose label could not be read. Open Resolve next step below for those.`));
}
async function updateDiscovery(){
 let section=$('#discovery-status');if(section?.contains(document.activeElement)||section?.querySelector('details[open]'))return;if(!section){section=el('section');section.id='discovery-status';section.style.cssText='padding:16px;border:1px solid #dce6df;border-radius:12px;margin-bottom:20px';$('#workspace').prepend(section);}
 try{const data=await api('/searches'),searches=(data.searches||[]).filter(s=>s.enabled);section.replaceChildren(el('strong','Automatic job discovery'));
 const controls=el('details');controls.append(el('summary','Manage saved searches'));
 for(const saved of data.searches||[]){const row=el('div'),toggle=el('button',saved.enabled?'Pause search':'Enable search');row.append(el('p',saved.instruction),toggle);toggle.onclick=async()=>{toggle.disabled=true;try{await api('/searches/'+saved.id+'/toggle','POST');await updateDiscovery();}catch(e){$('#notice').textContent=e.message;toggle.disabled=false;}};const run=el('button','Run search now');run.onclick=async()=>{run.disabled=true;run.textContent='Checking employer postings…';try{await api('/searches/'+saved.id+'/run','POST',{});await updateDiscovery();await refresh(true);}catch(e){$('#notice').textContent=e.message;run.disabled=false;run.textContent='Run search now';}};row.append(run);controls.append(row);}section.append(controls);
 if(!searches.length){section.append(el('p','No searches enabled. Add a saved search in profile setup.'));return;}
 const latest=searches.filter(s=>s.last_run).sort((a,b)=>b.last_run.localeCompare(a.last_run))[0],result=latest?.last_result;
 section.append(el('p',`${searches.length} enabled search${searches.length===1?'':'es'} · Checks every ${Math.round((data.intervalSeconds||60)/60)} minute(s), rotating employer boards. Newly found matches appear automatically; duplicates are skipped.`));
 section.append(el('p',latest?`Last check: ${new Date(latest.last_run).toLocaleString()}${result?` · ${result.scanned} postings checked · ${result.added} new matches · ${result.queued} queued`: ' · Results pending'}`:'First check is pending.'));
 section.append(el('p','A check can find zero suitable new jobs. Posted pay and match details also refresh in the background. '+(searches.some(s=>s.auto_queue)?'Automatic applications: the highest-ranked eligible new match is queued each cycle.':'Automatic applications are off for these searches.')));
  if(latest?.last_error)section.append(el('p','Some sources could not be checked: '+latest.last_error));
 if(searches.some(s=>s.instruction.includes('priority: York Region')))section.append(el('p','Priority: York Region → Toronto → GTA → remote → Canada → worldwide. Matches are based on your role preferences; eligibility may still need your input.'));
 }catch{section.textContent='Search activity could not be loaded. Refresh to try again.';}
}
const rememberLogin=rememberOption($('#auth'));
$('#auth').onsubmit=async e=>{e.preventDefault();try{token=(await api('/login','POST',{...Object.fromEntries(new FormData(e.target)),remember:rememberLogin.checked})).token;saveSession(token,rememberLogin.checked);await refresh(true);$('#notice').textContent=''}catch(e){$('#notice').textContent=e.message}};
$('#logout').onclick=()=>{clearSession();location.reload()};
for(const a of document.querySelectorAll('[data-profile-link]'))a.href=(location.hostname.endsWith('.netlify.app')||location.hostname.endsWith('.pages.dev'))?'/setup.html':'/setup';
let activeHandoff=null,remoteBusy=false,remoteTimer=null,currentFilter='all';
function applyFilters(){const q=$('#job-search').value.toLowerCase().trim();let shown=0;for(const card of $('#jobs').children){const state=card.dataset.state;const match=currentFilter==='active'&&!['submitted','interview','rejected','offer'].includes(state)||currentFilter==='all'||currentFilter===state||currentFilter==='needs'&&(card.dataset.blocked==='true'||card.dataset.stalled==='true'||['paused','needs_review'].includes(state))||currentFilter==='applying'&&card.dataset.active==='true'||currentFilter==='blocked'&&card.dataset.blocked==='true'||currentFilter==='stalled'&&card.dataset.stalled==='true'||currentFilter==='receipt'&&card.dataset.confirmed==='true'||currentFilter==='worked'&&card.dataset.worked==='true'||currentFilter==='local'&&card.dataset.local==='true';card.hidden=!(match&&card.dataset.search.includes(q));if(!card.hidden)shown++;}$('#empty-state').hidden=shown>0;}
$('#job-search').oninput=applyFilters;
for(const b of document.querySelectorAll('[data-filter]'))b.onclick=()=>{currentFilter=b.dataset.filter;for(const other of document.querySelectorAll('[data-filter]'))other.setAttribute('aria-pressed',String(other===b));applyFilters()};
$('#refresh-jobs').onclick=async()=>{const b=$('#refresh-jobs');b.disabled=true;try{await refresh(true)}catch(e){$('#notice').textContent=e.message}finally{b.disabled=false}};
if(token)refresh(true).catch(e=>$('#notice').textContent=e.message);
setInterval(()=>{if(pendingHandoff&&!activeHandoff)refresh().catch(e=>$('#notice').textContent=e.message)},2000);
setInterval(()=>{if(token)refresh().catch(e=>$('#notice').textContent=e.message)},15000);

async function openHandoff(job){
 if(activeHandoff)return;
 activeHandoff=job.id;
 let closed=false,sending=false,pollTimer=null,frameId='',lastInput=Date.now(),failures=0,points=[],zoom=1;
 const queue=[];
 const panel=el('section');panel.id='live-browser';panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label','Live employer application');
 panel.style.cssText='position:fixed;inset:0;z-index:1000;background:#eef3f0;display:flex;flex-direction:column;overflow:hidden;color:#173426';
 const style=el('style');style.textContent='#live-browser button{border-radius:8px;padding:8px 12px;white-space:nowrap}#live-browser button:focus-visible,#live-surface:focus-visible{outline:3px solid #54b687}#live-browser .live-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 16px;background:white;border-bottom:1px solid #d9e2dc;flex-shrink:0}#live-browser .live-title{flex:1;min-width:160px}#live-browser .live-title strong{display:block}#live-browser .live-primary{background:#214d36;color:white}#live-browser .live-status{font-size:13px;margin:0;padding:6px 16px;background:#e2ede7;min-height:32px}#live-browser details{background:white;padding:8px 16px}#live-browser textarea{width:100%;box-sizing:border-box;min-height:65px}#live-browser .live-stage{flex:1;overflow:auto;min-height:0;padding:12px;overscroll-behavior:contain}#live-browser .live-surface{position:relative;margin:auto;line-height:0;background:white;box-shadow:0 4px 22px #17342622;min-height:100px}#live-browser .live-surface img{display:block;width:100%;user-select:none}#live-browser .live-footer{font-size:12px;padding:6px 16px;margin:0;background:white}';panel.append(style);
 const toolbar=el('div');toolbar.className='live-toolbar';const title=el('div');title.className='live-title';title.append(el('strong',job.title));const info=el('span','Connecting…');info.style.fontSize='12px';title.append(info);toolbar.append(title);panel.append(toolbar);
 const message=el('p','Connecting to the employer browser…');message.className='live-status';message.setAttribute('role','status');panel.append(message);
 const stage=el('div');stage.className='live-stage';const surface=el('div');surface.id='live-surface';surface.className='live-surface';surface.tabIndex=0;surface.setAttribute('role','application');surface.setAttribute('aria-label','Employer browser. Click a field, then type. Tab moves to the next employer field.');
 const image=el('img');image.alt='Live employer application';image.draggable=false;surface.append(image);stage.append(surface);panel.append(stage);
 const compose=el('details'),summary=el('summary','Text entry and upload');compose.append(summary);const input=el('textarea');input.setAttribute('aria-label','Text to enter in selected employer field');input.placeholder='For mobile or longer answers: tap the employer field, then write here.';input.autocomplete='off';input.spellcheck=false;compose.append(input);
 const extra=el('div');extra.className='live-toolbar';compose.append(extra);panel.append(compose);
 const footer=el('p','Click a field and type directly. Scroll with your mouse or trackpad. Finish verification, then choose Continue automatically.');footer.className='live-footer';panel.append(footer);
 const button=(parent,label,handler,primary=false)=>{const b=el('button',label);if(primary)b.className='live-primary';b.onclick=handler;parent.append(b);return b};
 const focus=()=>surface.focus({preventScroll:true});
 function finish(note=''){if(closed)return;closed=true;clearTimeout(pollTimer);queue.length=0;resizeObserver?.disconnect();document.removeEventListener('visibilitychange',visibility);activeHandoff=null;panel.remove();refresh(true).catch(e=>$('#notice').textContent=e.message);if(note)$('#notice').textContent=note;}
 const continueButton=button(toolbar,'Continue automatically',()=>enqueue('resume'),true);
 button(toolbar,'Close view',()=>{if(sending||queue.length){message.textContent='Wait for pending input to finish before closing.';return;}finish('Live view closed. The employer session stays open until it expires.');});
 const zoomLabel=el('label','View '),zoomSelect=el('select');zoomSelect.setAttribute('aria-label','Browser zoom');for(const [value,label] of [['1','Fit width'],['1.25','125%'],['1.5','150%'],['2','200%']]){const o=el('option',label);o.value=value;zoomSelect.append(o);}zoomLabel.append(zoomSelect);toolbar.append(zoomLabel);
 function resize(){surface.style.width=Math.max(250,Math.min(1100,stage.clientWidth-24)*zoom)+'px';}zoomSelect.onchange=()=>{zoom=Number(zoomSelect.value);resize();};const resizeObserver=typeof ResizeObserver==='undefined'?null:new ResizeObserver(resize);resizeObserver?.observe(stage);
 button(extra,'Insert text',()=>{if(input.value){enqueue('text',{text:input.value.slice(0,4000)});input.value='';focus();}});
 for(const [label,key] of [['Previous field','Shift+Tab'],['Next field','Tab'],['Select all','ControlOrMeta+A'],['Backspace','Backspace'],['Enter','Enter']])button(extra,label,()=>{enqueue('key',{key});focus();});
 button(extra,'Scroll up',()=>enqueue('scroll',{y:-500}));button(extra,'Scroll down',()=>enqueue('scroll',{y:500}));
 const file=el('input');file.type='file';file.accept='.pdf,.docx';file.setAttribute('aria-label','Upload resume after selecting employer upload control');extra.append(file);
 file.onchange=()=>{const selected=file.files[0];if(!selected)return;if(selected.size>6*1024*1024){message.textContent='Choose a PDF or DOCX smaller than 6 MB.';return;}const reader=new FileReader();reader.onload=()=>{enqueue('upload',{name:selected.name,base64:reader.result.split(',')[1]});file.value='';};reader.readAsDataURL(selected);};
 button(extra,'End browser session',()=>{if(confirm('End this employer browser session? Unsaved form changes may be lost.'))enqueue('close');});
 function schedule(delay=900){clearTimeout(pollTimer);if(!closed)pollTimer=setTimeout(()=>pump(true),delay);}
 function enqueue(action,data={}){
  if(closed)return;if(queue.length>=150){message.textContent='The connection is catching up. Please pause typing.';return;}
  clearTimeout(pollTimer);lastInput=Date.now();const tail=queue.at(-1);
  if(action==='text'&&tail?.action==='text'&&tail.data.text.length+data.text.length<=4000)tail.data.text+=data.text;
  else if(action==='scroll'&&tail?.action==='scroll'){tail.data={...data,y:Math.max(-1000,Math.min(1000,tail.data.y+data.y))};}
  else queue.push({action,data});
  message.textContent='Sending your input…';continueButton.disabled=true;pump();
 }
 async function pump(view=false){
  if(closed||sending)return;if(!queue.length&&(!view||document.visibilityState==='hidden')){schedule(1500);return;}
  const item=queue.shift()||{action:'view',data:{frameId}};sending=true;continueButton.disabled=true;const started=Date.now();
  try{
   const data=item.action==='view'?{frameId}:['text','key','scroll','click','drag'].includes(item.action)?{...item.data,render:false}:item.data;
   const r=await api('/jobs/'+job.id+'/handoff/'+item.action,'POST',data);if(closed)return;failures=0;
   if(r.submitted){finish('Employer confirmed receipt. Application marked submitted.');return;}
   if(r.resumed){finish('The worker is continuing in the same browser with your changes.');return;}
   if(r.closed){finish('Employer browser session ended.');return;}
   if(r.image)image.src='data:image/jpeg;base64,'+r.image;
   if(r.frameId)frameId=r.frameId;
   if(r.host)info.textContent=r.host+' · Session until '+new Date(r.expiresAt).toLocaleTimeString();
   if(r.uploadRequested){compose.open=true;message.textContent='The employer requested a file. Choose your PDF or DOCX below.';}
   else message.textContent=queue.length?'Sending your input…':Date.now()-started>1500?'Connected · Slow network response. Your input was received.':'Connected · Click, type, or scroll directly in the form.';
  }catch(e){
   failures++;message.textContent=e.message;
   if(item.action!=='view'){queue.length=0;message.textContent='Could not confirm your last action. Check the form before repeating it. '+e.message;}
  }finally{
   sending=false;continueButton.disabled=false;if(closed)return;
   if(queue.length)pump();else schedule(item.action==='view'?Math.min(5000,failures?1000*failures:Date.now()-lastInput<15000?800:1800):80);
  }
 }
 const point=e=>{const r=image.getBoundingClientRect();return {x:Math.max(0,Math.min(1100,Math.round((e.clientX-r.left)*1100/r.width))),y:Math.max(0,Math.min(800,Math.round((e.clientY-r.top)*800/r.height)))}};
 image.style.touchAction='none';image.onpointerdown=e=>{if(!image.src)return;focus();points=[point(e)];image.setPointerCapture(e.pointerId);};image.onpointermove=e=>{if(points.length&&points.length<39)points.push(point(e));};image.onpointerup=e=>{if(!points.length)return;const end=point(e),start=points[0];if(Math.hypot(end.x-start.x,end.y-start.y)>8){if(e.pointerType==='touch')enqueue('scroll',{y:Math.max(-1000,Math.min(1000,(start.y-end.y)*2)),pointerX:start.x,pointerY:start.y});else enqueue('drag',{points:[...points,end]});}else enqueue('click',end);points=[];};image.onpointercancel=()=>points=[];
 surface.addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey)return;e.preventDefault();const p=point(e),scale=e.deltaMode===1?20:e.deltaMode===2?600:1;enqueue('scroll',{y:Math.max(-1000,Math.min(1000,e.deltaY*scale)),x:Math.max(-1000,Math.min(1000,e.deltaX*scale)),pointerX:p.x,pointerY:p.y});},{passive:false});
 surface.onkeydown=e=>{
  if(e.isComposing)return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='v')return;
  let key=e.key==='Tab'&&e.shiftKey?'Shift+Tab':e.key;
  if((e.ctrlKey||e.metaKey)&&key.toLowerCase()==='a'){e.preventDefault();enqueue('key',{key:'ControlOrMeta+A'});return;}
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  if(['Tab','Shift+Tab','Enter','Backspace','Delete','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End','PageDown','PageUp','Escape'].includes(key)){e.preventDefault();enqueue('key',{key});}
  else if(key.length===1){e.preventDefault();enqueue('text',{text:key});}
 };
 surface.onpaste=e=>{const text=e.clipboardData?.getData('text/plain');if(text){e.preventDefault();if(text.length>4000){message.textContent='Paste up to 4,000 characters at a time.';return;}enqueue('text',{text});}};
 surface.oncompositionend=e=>{if(e.data)enqueue('text',{text:e.data});};
 function visibility(){if(document.visibilityState==='visible')pump(true);else clearTimeout(pollTimer);}document.addEventListener('visibilitychange',visibility);
 panel.onkeydown=e=>{if(e.target===surface)return;if(e.key==='Escape'&&!sending&&!queue.length){e.preventDefault();finish();}};
 document.body.append(panel);resize();focus();await pump(true);
}

function focusLocalApplication(jobId){
 return new Promise((resolve,reject)=>{
  const requestId=crypto.randomUUID();
  const finish=(error)=>{clearTimeout(timer);window.removeEventListener('message',receive);error?reject(Error(error)):resolve();};
  const receive=e=>{if(e.source===window&&e.origin===location.origin&&e.data?.type==='applypilot-focus-result'&&e.data.requestId===requestId)finish(e.data.error);};
  const timer=setTimeout(()=>finish('Open this dashboard in Chrome with the updated ApplyPilot Local extension enabled. If you just updated the extension, refresh this dashboard.'),4000);
  window.addEventListener('message',receive);window.postMessage({type:'applypilot-focus-application',requestId,jobId},location.origin);
 });
}

function renderLibraryLauncher(){
 if(document.querySelector('#answer-library'))return;
 const box=el('section');box.id='answer-library';box.style.cssText='padding:20px;margin:16px 0;border:1px solid #74ad91;border-radius:12px';
 box.append(el('h2','Answer library'),el('p','Save filled employer forms with the extension’s Save form answers to library button. Confirmed ordinary answers can fill matching questions automatically. Approve other reusable answers here; conflicts and application-specific answers need review. Matching dropdowns fill automatically. With extension 0.6.3, approved queued applications can submit routine forms and record employer receipts.'));
 const load=el('button','Open / refresh answer library'),list=el('div');box.append(load,list);$('#workspace').prepend(box);
 load.onclick=async()=>{load.disabled=true;try{const {answers}=await api('/answer-library');list.replaceChildren();if(!answers.length)list.append(el('p','No captured answers yet. Save a filled form from its employer tab.'));
 for(const entry of answers){const form=el('form');form.style.cssText='padding:12px 0;border-top:1px solid #ddd';const input=field(form,entry.question);input.value=entry.answer;form.append(el('small',entry.company+' · '+(entry.confirmed?'Employer receipt recorded':'Captured draft — not proof of submission')));
 const label=el('label'),reuse=el('input');reuse.type='checkbox';reuse.checked=!!entry.reusable;reuse.disabled=!entry.canReuse;label.append(reuse,document.createTextNode(entry.canReuse?' Reuse for matching questions on future applications':' Application-specific answer; automatic reuse disabled'));form.append(label);
 const save=el('button','Save answer'),remove=el('button','Delete answer'),status=el('p');status.setAttribute('role','status');remove.type='button';form.append(save,remove,status);
 form.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{await api('/answer-library/'+entry.id,'PUT',{answer:input.value,reuse:reuse.checked});status.textContent='Saved. Reusable answers are available when an application next fills saved answers.';}catch(e){status.textContent=e.message;}finally{save.disabled=false;}};
 remove.onclick=async()=>{if(!confirm('Delete this saved answer and stop reusing it?'))return;remove.disabled=true;try{await api('/answer-library/'+entry.id,'DELETE');form.remove();}catch(e){status.textContent=e.message;remove.disabled=false;}};list.append(form);
 }}catch(e){list.textContent=e.message;}finally{load.disabled=false;}};
}

function renderFocusControl(){if($('#work-focus'))return;const section=el('section');section.id='work-focus';section.style.cssText='padding:20px;background:#edf6ef;border-radius:12px;margin:16px 0';const message=el('p','Work through one application at a time. Other jobs stay saved in your backlog.'),start=el('button','Work on one application at a time'),next=el('button','Next application'),all=el('button','Show all saved applications');section.append(message,start,next,all);$('#workspace').prepend(section);
 const show=f=>{currentFilter=f.enabled?'active':'all';applyFilters();message.textContent=f.enabled?'One application at a time. '+f.parked+' jobs are saved in your backlog. Submitted applications stay in Submitted.':'All saved applications are visible.';start.hidden=next.hidden=all.hidden=false;start.hidden=f.enabled;next.hidden=all.hidden=!f.enabled;};
 const change=async data=>{try{show(await api('/work-focus','PUT',data));await refresh(true);}catch(e){message.textContent=e.message;}};start.onclick=()=>change({enabled:true});next.onclick=()=>change({enabled:true,next:true});all.onclick=()=>change({enabled:false});api('/work-focus').then(show).catch(e=>message.textContent=e.message);
}

function renderArchiveControl(jobs){
 let box=$('#application-archive-control');
 if(!box){
 box=el('section');box.id='application-archive-control';box.style.cssText='padding:20px;margin:16px 0;border:1px solid #74ad91;border-radius:12px';
 box.append(el('h2','Application archive'),el('p','Remove old pending applications from your workspace while retaining their answers, history, and duplicate protection. Submitted and actively running applications are protected.'));
 const review=el('button'),browse=el('button','View archived applications'),panel=el('div'),status=el('p');review.id='review-archive';status.setAttribute('role','status');box.append(review,browse,status,panel);$('#workspace').prepend(box);
 review.onclick=()=>{
 const candidates=box.archiveCandidates||[];panel.replaceChildren();
 if(!candidates.length){status.textContent='No attention-needed applications can be archived right now.';return;}
 panel.append(el('p',candidates.length+' applications will be archived. They can be restored here. This does not withdraw applications from employers.'));
 const list=el('details');list.append(el('summary','Review applications to archive'));for(const j of candidates)list.append(el('p',j.company+' — '+j.title));panel.append(list);
 const confirm=el('button','Archive listed applications'),cancel=el('button','Cancel');panel.append(confirm,cancel);
 cancel.onclick=()=>panel.replaceChildren();
 confirm.onclick=async()=>{confirm.disabled=true;review.disabled=true;try{const result=await api('/application-archive','POST',{ids:candidates.map(j=>j.id)});status.textContent=result.archived.length+' archived; '+result.skipped.length+' protected or changed since review.';panel.replaceChildren();await refresh(true);}catch(e){status.textContent=e.message;confirm.disabled=false;}finally{review.disabled=false;}};
 };
 browse.onclick=async()=>{browse.disabled=true;try{const {jobs:archived}=await api('/application-archive');panel.replaceChildren();status.textContent=archived.length+' archived applications. Their identities remain tracked to prevent rediscovery.';
 for(const j of archived){const row=el('div');row.append(el('p',j.company+' — '+j.title));const restore=el('button','Restore for review');row.append(restore);restore.onclick=async()=>{restore.disabled=true;try{await api('/application-archive/'+j.id+'/restore','POST');row.remove();status.textContent='Application restored for review; no submission was started.';await refresh(true);}catch(e){status.textContent=e.message;restore.disabled=false;}};panel.append(row);}
 }catch(e){status.textContent=e.message;}finally{browse.disabled=false;}};
 }
 box.archiveCandidates=jobs.filter(j=>!j.handoff_available&&(['paused','needs_review'].includes(j.status)||j.status==='local_browser'&&j.local_phase==='blocked'&&!j.local_attempt_at));
 $('#review-archive').textContent='Review '+box.archiveCandidates.length+' attention-needed applications for archive';
}

function interviewIdentity(r){
 const norm=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
 const company=norm(String(r.company||'').toLowerCase().replace(/\b(incorporated|inc|corporation|corp|limited|ltd|llc)\.?\s*$/,'').trim());
 return (({clutchtechnologies:'clutch',arhsdevelopments:'arhs',pricewaterhousecoopers:'pwc'})[company]||company)+'|'+norm(r.title);
}
function interviewRecords(records,jobs=[]){
 const map=new Map();for(const j of jobs.filter(j=>j.status==='interview'))map.set(interviewIdentity(j),{...j,source:'ApplyPilot',native:true});
 for(const r of records.filter(r=>r.status==='interview')){const key=interviewIdentity(r);map.set(key,{...map.get(key),...r});}
 return [...map.values()].sort((a,b)=>Number(a.interview_stage==='completed')-Number(b.interview_stage==='completed')||String(a.company).localeCompare(String(b.company)));
}
function interviewCard(r){
 const card=el('article');card.className='job interview-record';card.dataset.state='interview';card.dataset.local='false';card.dataset.search=(r.title+' '+r.company+' '+r.notes).toLowerCase();
 const label=r.interview_stage==='completed'?'Completed interview':r.interview_stage==='needs_scheduling'?'Interview · needs scheduling':'Interview';
 card.append(el('h3',r.company+' — '+r.title),el('strong',label),el('p',r.interview_at||'Date to be confirmed'),el('p',r.notes||''),el('small','Source: '+r.source));
 const edit=el('details');edit.append(el('summary','Update interview'));
 edit.append(interviewForm(r));card.append(edit);return card;
}
function interviewForm(record={}){
 const form=el('form'),fields={};
 for(const [key,label] of [['company','Company'],['title','Job title'],['source','Interview source'],['interview_at','Interview date, time and timezone'],['notes','Interview details / feedback'],['work_mode','Work arrangement (remote, hybrid, on-site or unknown)'],['country','Job country']]){
  const l=el('label',label),input=el(key==='notes'?'textarea':'input');input.setAttribute('aria-label',label);input.required=['company','title','source'].includes(key);input.value=record[key]|| (key==='work_mode'?'unknown':'');if(record.company&&['company','title'].includes(key))input.readOnly=true;l.append(input);form.append(l);fields[key]=input;
 }
 const l=el('label','Interview stage'),stage=el('select');stage.setAttribute('aria-label','Interview stage');
 for(const [value,label] of [['scheduled','Scheduled'],['completed','Completed'],['needs_scheduling','Needs scheduling']]){const o=el('option',label);o.value=value;stage.append(o);}stage.value=record.interview_stage||'scheduled';l.append(stage);form.append(l);fields.interview_stage=stage;
 const save=el('button','Save interview'),feedback=el('p');save.type='submit';feedback.setAttribute('role','status');form.append(save,feedback);
 form.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{const row=Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.value.trim()]));row.status='interview';await api('/application-history','POST',{rows:[row]});form.closest('details').open=false;document.activeElement?.blur();overviewSignature='';await refresh(true);$('#notice').textContent='Interview saved.';}catch(e){feedback.textContent=e.message;save.disabled=false;}};
 return form;
}
function renderHistoryOverview(records,jobs=[]){
 let box=$('#career-overview');if(!box){box=el('section');box.id='career-overview';box.style.cssText='padding:24px;margin:16px 0;background:#e9f5ee;border:2px solid #39765c;border-radius:16px';$('#workspace').prepend(box);}
 const signature=JSON.stringify([records,jobs.filter(j=>['submitted','interview','rejected','offer'].includes(j.status))]);
 if(signature===overviewSignature||box.contains(document.activeElement)||box.querySelector('details[open]'))return;
 overviewSignature=signature;box.replaceChildren(el('h2','Your interviews'));
 const interviews=interviewRecords(records,jobs),pending=interviews.filter(r=>r.interview_stage!=='completed'),completed=interviews.filter(r=>r.interview_stage==='completed');
 const open=el('button','Open Interview section ('+interviews.length+')');open.onclick=()=>document.querySelector('[data-filter="interview"]')?.click();box.append(open);
 if(!interviews.length)box.append(el('p','No interviews recorded yet.'));
 if(pending.length){box.append(el('h3','Upcoming and awaiting scheduling'));for(const r of pending)box.append(interviewCard(r));}
 if(completed.length){box.append(el('h3','Completed interviews'));for(const r of completed)box.append(interviewCard(r));}
 const details=el('details');details.append(el('summary','Add interview from another source'),interviewForm());box.append(details);
 box.append(el('h2','Submissions by work arrangement and country'));
 const stats=el('div');box.append(stats);
 const count=rows=>{const modes={},countries={};for(const r of rows){const mode=r.work_mode||'unknown',country=r.country||'Unknown';modes[mode]=(modes[mode]||0)+1;countries[country]=(countries[country]||0)+1;}return {modes,countries};};
 const render=(rows,label)=>{stats.append(el('h3',label+' ('+rows.length+')'));const {modes,countries}=count(rows);stats.append(el('p','Work arrangement: '+['remote','hybrid','on-site','unknown'].map(k=>k+': '+(modes[k]||0)).join(' · ')));stats.append(el('p','Countries: '+Object.entries(countries).sort((a,b)=>b[1]-a[1]).map(([k,n])=>k+': '+n).join(' · ')));};
 render(records,'Imported application history');
 stats.append(el('small','Imported records are applicant-reported applications, not newly verified employer receipts. Unknown means the source did not specify the work arrangement or country.'));
 const submitted=jobs.filter(j=>['submitted','interview','rejected','offer'].includes(j.status));
 render(submitted.map(j=>({work_mode:/\bremote\b/i.test(j.title)?'remote':/\bhybrid\b/i.test(j.title)?'hybrid':/\bon-site\b/i.test(j.title)?'on-site':'unknown',country:/\bCanada\b|Toronto area/i.test(j.title)?'Canada':/\bUnited States\b|Columbus OHIO/i.test(j.title)?'United States':''})),'ApplyPilot submission records');
 stats.append(el('small','ApplyPilot totals retain recorded statuses; external records are not added to that total.'));
}

function mountExternalHistory(){
 const host=$('#workspace');if(!host||$('#external-history'))return;
 const section=el('details');section.id='external-history';section.style.cssText='padding:20px;margin:16px 0;border:1px solid #d5ded9;border-radius:12px;background:white';
 section.append(el('summary','Import past applications for duplicate protection'));
 section.append(el('p','Import Tsenta or other application history to block repeat applications. These records are separate from employer-confirmed submissions. Matching uses the company and job title; changed titles or company names may need review.'));
 const form=el('form'),label=el('label','Application history — one per line: Company | Job title | Status | Notes | Work mode | Country | Interview date/time');
 const input=el('textarea');input.setAttribute('aria-label','Application history to import');input.rows=10;input.style.width='100%';input.required=true;input.placeholder='Company | Job title | applied | Optional notes';label.append(input);
 const submit=el('button','Import previously applied jobs');submit.type='submit';
 const refresh=el('button','Refresh imported history');refresh.type='button';
 const status=el('p');status.setAttribute('role','status');const list=el('div');
 form.append(label,submit);section.append(form,refresh,status,list);host.prepend(section);
 async function show(){const d=await api('/application-history');list.replaceChildren(el('p',d.records.length+' records stored in the background for duplicate protection'));
 externalRecords=d.records;overviewSignature='';await refresh(true);}

 refresh.onclick=()=>show().catch(e=>status.textContent=e.message);
 form.onsubmit=async e=>{e.preventDefault();submit.disabled=true;try{
 const lines=input.value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
 const rows=lines.filter(v=>!/^company\s*\|/i.test(v)&&!/^[-| :]+$/.test(v)).map(line=>{const [company,title,status='applied',notes='',work_mode='unknown',country='',interview_at='']=line.split('|').map(v=>v.trim());return {company,title,status:status.toLowerCase()||'applied',notes,work_mode,country,interview_at,source:'Tsenta / email history — applicant supplied'};});
 const r=await api('/application-history','POST',{rows});status.textContent=r.added+' added, '+r.updated+' existing records merged; '+r.total+' total. '+r.blocked+' pending duplicates blocked.'+(r.active.length?' '+r.active.length+' matching applications are already active and need review.':'');input.value='';await show();
 }catch(e){status.textContent=e.message;}finally{submit.disabled=false;}};
 show().catch(e=>status.textContent=e.message);
}
mountExternalHistory();

for(const a of document.querySelectorAll('a'))if(a.textContent.trim().includes('Home'))a.href='/';

let browserHelperStatus=null,continuationBusy=false,nextContinuationCheck=0;
function renderBrowserReadiness(jobs){
 if(!jobs.some(j=>j.execution_mode==='local'))return;
 let box=$('#browser-readiness');
 if(box){if(Date.now()-Number(box.dataset.checkedAt||0)>30000)box.querySelector('button').click();return;}
 box=el('section');box.id='browser-readiness';box.style.cssText='padding:16px;border:1px solid #74ad91;border-radius:12px;margin:16px 0';
 box.append(el('h2','Automatic applications in your browser'));
 const status=el('p','Checking your browser helper…'),check=el('button','Check browser connection'),setup=el('a','Update browser helper (0.6.3)');
 setup.href='/local-browser.html';setup.style.marginLeft='12px';status.setAttribute('role','status');
 box.append(status,check,setup);$('#workspace').prepend(box);
 check.onclick=()=>{
  if(check.disabled)return;check.disabled=true;box.dataset.checkedAt=String(Date.now());const requestId=crypto.randomUUID();
  const finish=(error,data)=>{clearTimeout(timer);window.removeEventListener('message',receive);check.disabled=false;
   browserHelperStatus=error?null:{...data,checkedAt:Date.now()};
   status.textContent=error|| (data?.version!=='0.6.3'?'Browser helper '+data?.version+' is connected. Update to 0.6.3 to recognize employer outages and safely retry new empty pages once.':data?.enabled?'Browser helper 0.6.3 connected. New queued applications run automatically; keep this browser and dashboard open.':'Browser helper connected but paused. Open its popup and start routine applications.')+(data?.error?' '+data.error:'');
  };
  const receive=e=>{if(e.source===window&&e.origin===location.origin&&e.data?.type==='applypilot-browser-status-result'&&e.data.requestId===requestId)finish(e.data.error,e.data.data);};
  const timer=setTimeout(()=>finish('Browser helper not detected here. Open this dashboard in the Chrome or Edge profile with ApplyPilot Local enabled.'),3500);
  window.addEventListener('message',receive);window.postMessage({type:'applypilot-browser-status',requestId},location.origin);
 };check.onclick();
}


function resumeLocalApplication(jobId){
 return new Promise((resolve,reject)=>{
  const requestId=crypto.randomUUID();
  const finish=(error,data)=>{clearTimeout(timer);window.removeEventListener('message',receive);error?reject(Error(error)):resolve(data);};
  const receive=e=>{if(e.source===window&&e.origin===location.origin&&e.data?.type==='applypilot-resume-result'&&e.data.requestId===requestId)finish(e.data.error,e.data.data);};
  const timer=setTimeout(()=>finish('The browser did not confirm this continuation. Check the employer tab and helper connection before resuming again. Your answers are saved.'),25000);
  window.addEventListener('message',receive);window.postMessage({type:'applypilot-resume-application',requestId,jobId},location.origin);
 });
}
function renderOperations(snapshot,activity){
 if(!snapshot?.totals)snapshot=null;
 let box=$('#operations');
 if(!box){box=el('section');box.id='operations';box.className='operations';$('#workspace').prepend(box);}
 $('#workspace').prepend(box);
 const signature=JSON.stringify([snapshot?.totals,activity?.events]);
 if(box.dataset.signature===signature)return;box.dataset.signature=signature;
 box.replaceChildren();
 const header=el('div');header.className='operations-heading';
 const title=el('div');title.append(el('span','Live application activity'),el('h2','From saved facts to employer receipts.'));
 const checked=el('small',snapshot?'Updated '+new Date(snapshot.checkedAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'Unable to refresh progress');header.append(title,checked);box.append(header);
 if(!snapshot){box.append(el('p','Progress could not be verified. Refresh to try again.'));return;}
 const metrics=el('div');metrics.className='operation-metrics';
 for(const [key,label,detail,filter] of [
  ['confirmed','Receipts recorded','Employer receipt text on file','receipt'],
  ['worked','Forms filled / attempted','Distinct applications with form evidence','worked'],
  ['awaiting','Awaiting receipt','Attempt recorded · automatic retry held','awaiting'],
  ['active','Queued / filling','Routine work in progress','applying'],
  ['blocked','Needs a step','Answers or employer verification','blocked'],
  ['stalled','Browser check needed','No recent browser activity','stalled']]){
   const button=el('button');button.className='operation-metric';button.type='button';button.append(el('span',label),el('strong',String(snapshot.totals[key]||0)),el('small',detail));
   button.onclick=()=>{currentFilter=filter;for(const b of document.querySelectorAll('[data-filter]'))b.setAttribute('aria-pressed',String(b.dataset.filter===filter));applyFilters();$('#jobs').closest('.list-panel').scrollIntoView({behavior:'smooth',block:'start'});};metrics.append(button);
 }
 box.append(metrics,el('p','Filled forms and submission attempts are not successful submissions. Imported history, placeholders and outcome changes do not add receipts.'));
 if(snapshot.totals.unverifiedOutcome)box.append(el('p',snapshot.totals.unverifiedOutcome+' recorded outcomes have no qualifying receipt text and are excluded from the receipt total.'));
 const feed=el('div');feed.className='activity-feed';feed.append(el('h3','Latest activity'));
 if(!activity)feed.append(el('p','Activity could not be refreshed.'));
 const events=(activity?.events||[]).filter(e=>e.job_id).slice(0,6);
 if(activity&&!events.length)feed.append(el('p','New application activity will appear here automatically.'));
 for(const event of events){
  const row=el('a');row.className='activity-row';row.href='#job-'+event.job_id;
  const date=Date.parse(event.at),time=el('time',Number.isFinite(date)?new Date(date).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'');if(Number.isFinite(date)){time.dateTime=new Date(date).toISOString();time.title=new Date(date).toLocaleString();}
  const text=el('div');text.append(el('strong',event.company+' · '+event.title),el('span',event.message));
  row.append(time,text);row.onclick=()=>{currentFilter='all';$('#job-search').value='';for(const b of document.querySelectorAll('[data-filter]'))b.setAttribute('aria-pressed',String(b.dataset.filter==='all'));applyFilters();};feed.append(row);
 }
 box.append(feed);$('#workspace').prepend(box);
}

function renderContinuationQueue(data){
 let box=$('#continuation-queue');
 if(!data){if(box)box.querySelector('[role=status]').textContent='Continuation status could not be refreshed.';return;}
 const requests=data.requests||[];
 if(!box){box=el('section');box.id='continuation-queue';box.style.cssText='padding:16px;border:1px solid #74ad91;border-radius:12px;margin:16px 0';$('#workspace').insertBefore(box,$('#missing-answers')||$('#jobs').closest('.list-panel'));}
 box.hidden=!requests.length;
 const signature=JSON.stringify(requests);if(box.dataset.signature===signature)return;box.dataset.signature=signature;box.replaceChildren(el('h2','Ready forms continue in order'));
 const status=el('p',requests.filter(r=>r.state==='queued').length+' waiting · '+requests.filter(r=>r.state==='dispatching').length+' starting · '+requests.filter(r=>r.state==='review').length+' need a browser check');status.setAttribute('role','status');box.append(status);
 box.append(el('p','Keep this dashboard open in the browser with ApplyPilot Local enabled. Saved answers survive refreshes. A missing browser response holds that request for review.'));
 for(const request of requests){
  const row=el('div');row.style.cssText='padding:10px 0;border-top:1px solid #dce6df';row.append(el('strong',request.company+' · '+request.title),el('p',request.message||({queued:'Waiting for the helper to continue this form.',dispatching:'The helper is starting this form.',review:'Check the employer tab before continuing.'}[request.state])));
  if(request.state!=='dispatching'){const cancel=el('button','Remove from continuation list');cancel.type='button';cancel.onclick=async()=>{cancel.disabled=true;try{await api('/jobs/'+request.job_id+'/continuation','DELETE');await refresh(true);}catch(error){status.textContent=error.message;cancel.disabled=false;}};row.append(cancel);}
  box.append(row);
 }
}
async function drainContinuations(data){
 if(continuationBusy||busy||activeHandoff||Date.now()<nextContinuationCheck||!data?.requests?.some(r=>r.state==='queued'))return;
 if(!browserHelperStatus?.enabled||!['0.6.1','0.6.2','0.6.3'].includes(browserHelperStatus.version)||Date.now()-browserHelperStatus.checkedAt>45000)return;
 continuationBusy=true;nextContinuationCheck=Date.now()+20000;
 try{
  const {request}=await api('/continuations/claim','POST',{});if(!request)return;
  let result='started';
  try{await resumeLocalApplication(request.jobId);}
  catch(error){result=/^Another application is running\./.test(error.message)?'busy':'review';}
  // Only an explicit "busy" refusal is retried. Lost or uncertain responses stay held.
  await api('/jobs/'+request.jobId+'/continuation','PUT',{claimId:request.claimId,result});
  renderContinuationQueue(await api('/continuations'));
 }catch(error){$('#notice').textContent='Continuation status needs checking. Your answers are saved. '+error.message;}
 finally{continuationBusy=false;}
}

function preparedProfileAnswer(question,profile,saved){
 const policy=globalThis.ApplyPilotPolicy;if(!policy)return null;
 const kind=policy.fieldKind(question);
 const values=kind?Object.entries(saved).filter(([q])=>policy.fieldKind(q)===kind).map(([,a])=>policy.normalize(a)):[];
 if(new Set(values).size>1)return null;
 return policy.knownAnswer(question,profile,saved);
}

async function updateAIStatus(){
 let box=$('#ai-status');if(!box){box=el('section');box.id='ai-status';box.className='ai-status';$('#workspace').insertBefore(box,$('#browser-readiness')||$('#missing-answers'));}
 try{
  const data=await api('/ai-status'),signature=JSON.stringify(data);if(box.dataset.signature===signature)return;box.dataset.signature=signature;box.replaceChildren(el('h2','AI form assistance'));
  box.append(el('p',data.googleConfigured?'Gemini key configured · checks paused browser forms for supported public company/job questions every minute. API errors appear below.':'Gemini is not configured on the server. Saved-answer autofill remains available.'));
  box.append(el('p','Gemini currently uses the employer’s public job page. Questions about your own experience, desired pay, availability or work authorization need your saved answers. Verification and employer declarations remain in your browser.'));
  for(const p of data.profiles||[])box.append(el('small',p.name+': Google public-page consent '+(p.googleConsent?'enabled':'off')+'. Personal-answer drafting '+(p.personalDraftConsent&&data.personalDraftsConfigured?'enabled':'inactive')+'. Professional background '+(p.hasBackground?'saved':'not yet saved')+'.'));
  for(const attempt of data.attempts||[])box.append(el('p',attempt.company+' · '+attempt.question+' — '+attempt.message));
  const testRow=el('div'),testButton=el('button','Test Gemini on a public job page'),testResult=el('p');testButton.type='button';testButton.disabled=!data.googleConfigured;testResult.setAttribute('role','status');testRow.append(testButton,testResult);box.append(testRow);
  testButton.onclick=async()=>{
   testButton.disabled=true;testResult.textContent='Checking Gemini with one saved public job page…';
   try{const result=await api('/ai-test','POST',{});testResult.replaceChildren(el('strong','Gemini test passed · '+result.model),el('p',result.company+' · '+result.title),el('p',result.answer),el('small','Verified '+new Date(result.checkedAt).toLocaleTimeString()+'. This test did not fill or submit an application.'));
    for(const cite of result.citations||[]){const link=el('a','Source: '+cite.title);link.href=cite.url;link.target='_blank';link.rel='noopener noreferrer';testResult.append(link);}
   }catch(error){testResult.textContent='Gemini test failed: '+error.message;}
   finally{testButton.disabled=false;}
  };
  const setup=el('a','View resume and profile facts →');setup.href='https://marvelous-vitality-production-c2d8.up.railway.app/setup';box.append(setup);
 }catch{box.replaceChildren(el('h2','AI form assistance'),el('p','AI status could not be verified. Your saved answers remain available.'));}
}
