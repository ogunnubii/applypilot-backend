
// Persist only an explicitly remembered session, never the password.
function restoreSession(){const remembered=localStorage.getItem('applypilot-remembered-token');if(remembered)sessionStorage.setItem('applypilot-token',remembered);return remembered||sessionStorage.getItem('applypilot-token')||'';}
function saveSession(value,remember){sessionStorage.setItem('applypilot-token',value);if(remember)localStorage.setItem('applypilot-remembered-token',value);else localStorage.removeItem('applypilot-remembered-token');}
function clearSession(){sessionStorage.removeItem('applypilot-token');localStorage.removeItem('applypilot-remembered-token');localStorage.setItem('applypilot-signout',String(Date.now()));}
window.addEventListener('storage',e=>{if(e.key==='applypilot-signout'){sessionStorage.removeItem('applypilot-token');location.reload();}});
function rememberOption(form){const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.name='remember';box.style.cssText='width:auto;display:inline;margin-right:8px';label.style.cssText='display:block;margin:12px 0';label.append(box,document.createTextNode('Keep me signed in on this computer for up to 30 days'));form.insertBefore(label,form.querySelector('button'));return box;}
const $=s=>document.querySelector(s);let token=restoreSession(),busy=false,lastSignature='',pendingHandoff=null;
const el=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e};
async function api(path,method='GET',data){const r=await fetch(((location.hostname.endsWith('.netlify.app')||location.hostname.endsWith('.pages.dev'))?'https://marvelous-vitality-production-c2d8.up.railway.app':'')+'/api'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d}
function field(form,label){const l=el('label',label),i=el('textarea');i.required=true;i.maxLength=4000;l.append(i);form.append(l);return i}
function chatQuestionTools(parent,question){
 const tools=el('div');tools.className='chat-question-tools';tools.style.cssText='margin:8px 0 16px';
 const copy=el('button','Copy question for ChatGPT');copy.type='button';
 const open=el('a','Open ChatGPT');open.href='https://chatgpt.com/';open.target='_blank';open.rel='noopener noreferrer';open.style.marginLeft='12px';
 const status=el('p');status.setAttribute('role','status');
 const help=el('small','Copy the question, ask in your own ChatGPT chat, then paste and check the answer here before saving. ChatGPT plan limits apply; ApplyPilot makes no AI calls. Do not guess personal facts.');help.style.display='block';
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
 const [{jobs},health]=await Promise.all([api('/jobs'),api('/status')]);
 $('#login').hidden=true;$('#workspace').hidden=false;$('#logout').hidden=false;
 notificationSettings();
 updateDiscovery();
 const current=jobs.filter(j=>j.status!=='duplicate');
 if(pendingHandoff){
  const target=current.find(j=>j.id===pendingHandoff.id);
  if(target?.handoff_available){pendingHandoff=null;document.querySelector('#preparing-browser')?.remove();await openHandoff(target);return;}
  if(!target||['submitted','interview','rejected','offer'].includes(target.status)||['Unconfirmed submission','Submission in progress'].includes(target.challenge)){
   const message=target?.challenge?.includes('submission')?'A submission may already have occurred. Check the employer receipt before restarting.':'Application preparation ended. Check its current status below.';
   pendingHandoff=null;document.querySelector('#preparing-browser')?.remove();$('#notice').textContent=message;force=true;
  }else if(Date.now()-pendingHandoff.started>180000){pendingHandoff=null;const banner=$('#preparing-browser');if(banner)banner.textContent='The live browser is taking longer than expected. Check the application below or try again when the worker is available.';force=true;}
 }
 renderMissingAnswers(current);renderLibraryLauncher();
 $('#status').textContent=current.length?`${current.length} tracked applications${health.workerOnline?'':' · Worker unavailable; saved answers are retained'}`:'No applications currently need completion.';
 $('#needs-count').textContent=current.filter(j=>['paused','needs_review'].includes(j.status)||j.status==='local_browser'&&j.local_phase==='blocked').length;
 $('#applying-count').textContent=current.filter(j=>['queued','running'].includes(j.status)||j.status==='local_browser'&&j.local_phase!=='blocked').length;
 $('#local-count').textContent=current.filter(j=>j.status==='local_browser').length;
 $('#worker-state').textContent=health.workerOnline?'● Worker connected · Progress updates automatically':'○ Worker offline · Saved information is retained';
 const signature=JSON.stringify(current);
 if(!force&&(signature===lastSignature||$('#jobs').contains(document.activeElement)||$('#jobs').querySelector('[data-dirty="true"],details[open]')))return;
 lastSignature=signature;$('#jobs').replaceChildren();
 const blocked=j=>['needs_review','paused'].includes(j.status)||j.status==='local_browser'&&j.local_phase==='blocked';
 const rank=j=>blocked(j)?0:1+['local_browser','running','queued','saved','submitted','interview','rejected','offer'].indexOf(j.status);
 const updated=j=>Number.isFinite(Date.parse(j.updated_at))?Date.parse(j.updated_at):0;
 current.sort((a,b)=>rank(a)-rank(b)||updated(b)-updated(a)||String(a.id).localeCompare(String(b.id)));
 for(const job of current){
  const card=el('article');card.className='job';card.dataset.search=(job.title+' '+job.company).toLowerCase();card.dataset.local=String(job.status==='local_browser');card.dataset.state=job.status==='local_browser'&&job.local_phase==='blocked'?'needs_review':job.status;const heading=el('div');heading.className='job-heading';const mark=el('span',(job.company||'A').slice(0,1).toUpperCase());mark.className='company-mark';const names=el('div');names.append(el('h2',job.title),el('small',job.company));const badge=el('span',({saved:'Found',running:'Applying',queued:'Applying · queued',paused:'Blocked',needs_review:'Blocked',local_browser:job.local_phase==='blocked'?'Blocked':job.local_attempt_at?'Applying · verifying':'Applying · local',submitted:'Submitted',interview:'Interview',rejected:'Rejected',offer:'Offer'})[job.status]);badge.className='badge '+(job.status==='local_browser'&&job.local_phase==='blocked'?'needs_review':job.status);heading.append(mark,names,badge);card.append(heading);
  const updated=Date.parse(job.updated_at),stamp=el('p');stamp.className='last-updated';stamp.style.cssText='font-size:13px;color:#626c65;margin:8px 0';
  if(Number.isFinite(updated)){const time=el('time',new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(updated)));time.dateTime=new Date(updated).toISOString();stamp.append(document.createTextNode('Last updated: '),time);}else stamp.textContent='Last updated: unavailable';card.append(stamp);
  if(['submitted','interview','rejected','offer'].includes(job.status)){
   card.append(el('p',job.confirmation||'Employer outcome recorded.'));
   const label=el('label','Employer outcome '),select=el('select');
   for(const [value,title] of [['','Choose outcome'],['interview','Interview'],['rejected','Rejected'],['offer','Offer']]){const o=el('option',title);o.value=value;select.append(o);}
   select.value=['interview','rejected','offer'].includes(job.status)?job.status:'';
   select.onchange=async()=>{if(!select.value)return;try{await api('/jobs/'+job.id+'/outcome','PUT',{status:select.value});await refresh(true);}catch(e){$('#notice').textContent=e.message;}};
   label.append(select);card.append(label);$('#jobs').append(card);continue;
  }
  if(job.status==='saved'){
   const local=job.execution_mode==='local';
   const p=el('p',local?'This profile uses your Windows browser. Open the extension to start this application.':'ApplyPilot can fill and submit routine steps using your saved profile. It will stop for verification, unknown facts and sensitive statements.');
   card.append(p);
   if(local){const a=el('a','Browser setup');a.href=(location.hostname.endsWith('.pages.dev')?location.origin:'https://applypilot-jobs.netlify.app')+'/local-browser.html';card.append(a);}
   else{const start=el('button','Apply automatically'),message=el('p');message.setAttribute('role','status');start.onclick=async()=>{start.disabled=true;try{await api('/jobs/'+job.id+'/queue','POST',{});await refresh(true);$('#notice').textContent='Application queued. You can close this page; the hosted worker will continue.';}catch(e){message.textContent=e.message;start.disabled=false;}};card.append(start,message);}
   $('#jobs').append(card);continue;
  }
  if(['running','queued'].includes(job.status)){card.append(el('p',job.status==='running'?'Applying with your saved answers…':'Waiting for the worker. No action needed.'));$('#jobs').append(card);continue}
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
  }
  if(job.status!=='local_browser'&&!human&&!upload&&!job.handoff_available){
   const form=el('form');form.oninput=()=>{form.dataset.dirty='true'};
   const fields=[];
   if(questions.length){for(const question of [...new Set(questions)]){fields.push({question,input:field(form,question)});chatQuestionTools(form,question);}}
   else{const q=field(form,'Question shown on the employer form');q.maxLength=240;fields.push({questionInput:q,input:field(form,'Your answer')});chatQuestionTools(form,()=>q.value)}
   const rememberLabel=el('label'),remember=el('input');remember.type='checkbox';rememberLabel.append(remember,document.createTextNode('Remember these answers for this applicant'));form.append(rememberLabel);
   const submit=el('button','Save answers and continue');form.append(submit);
   form.onsubmit=async e=>{e.preventDefault();submit.disabled=true;busy=true;try{const answers=Object.fromEntries(fields.map(f=>[f.question||f.questionInput.value.trim(),f.input.value.trim()]));await api('/jobs/'+job.id+'/continue','POST',{answers,remember:remember.checked});busy=false;await refresh(true);$('#notice').textContent='Answers saved. The worker will retry this application and submit if all requirements are satisfied.'}catch(e){msg.textContent=e.message}finally{busy=false;submit.disabled=false}};actions.append(form);
  }
  const link=el('a','Open this application on the employer site');link.href=job.url;link.target='_blank';link.rel='noopener';actions.append(link);
  if(human||upload)actions.append(el('p',job.challenge==='Unconfirmed submission'?'Check whether the employer received this application before trying again.':'Use Take over to work in the worker’s browser. The separate employer link starts a different browser session.'));
  const done=el('details');done.append(el('summary','I submitted this application'));
  const receiptForm=el('form'),receipt=field(receiptForm,'Employer confirmation reference or message');receipt.minLength=8;receipt.maxLength=300;
  const label=el('label'),check=el('input');check.type='checkbox';check.required=true;check.style.cssText='display:inline;width:auto;margin-right:8px';label.append(check,document.createTextNode('The employer confirmed receipt.'));receiptForm.append(label);
  const confirm=el('button','Confirm submitted');receiptForm.append(confirm);receiptForm.onsubmit=async e=>{e.preventDefault();confirm.disabled=true;busy=true;try{await api('/jobs/'+job.id+'/confirm','POST',{receipt:receipt.value});busy=false;await refresh(true);$('#notice').textContent='Submission recorded. The application is now shown as Submitted.'}catch(e){msg.textContent=e.message}finally{busy=false;confirm.disabled=false}};done.append(receiptForm);actions.append(done);$('#jobs').append(card);
 }
 for(let i=0;i<current.length;i++)$('#jobs').children[i].id='job-'+current[i].id;
 applyFilters();
 const linked=document.getElementById(location.hash.slice(1));
 if(linked?.classList.contains('job')){linked.hidden=false;linked.style.outline='3px solid #74ad91';const details=linked.querySelector('details');if(details)details.open=true;if(!linked.dataset.focused){linked.scrollIntoView?.({block:'center'});linked.dataset.focused='true';}}
}
function renderMissingAnswers(jobs){
 let section=$('#missing-answers');
 if(section?.dataset.dirty==='true')return;
 const signature=JSON.stringify(jobs.map(j=>[j.id,j.status,j.challenge,j.required_fields_json,j.answers_json,j.handoff_available]));
 if(section?.dataset.signature===signature)return;
 if(!section){section=el('section');section.id='missing-answers';section.style.cssText='padding:24px;margin:20px 0;border:2px solid #74ad91;border-radius:14px;background:#f4faf6';$('#workspace').insertBefore(section,$('#jobs').closest('.list-panel')||$('#jobs'));}
 section.dataset.signature=signature;section.replaceChildren(el('h2','Complete missing answers'));
 section.append(el('p','Answer repeated questions once. These are questions already detected on your applications; employers may ask more later. Only enter facts you know are accurate.'));
 const form=el('form'),groups=new Map(),eligible=[];
 const human=new Set(['CAPTCHA','Sign-in','Unconfirmed submission','Submission in progress','Sensitive action','Upload needs review']);
 let employerOnly=0;
 for(const job of jobs){
  if(!['paused','needs_review'].includes(job.status))continue;
  if(human.has(job.challenge)){employerOnly++;continue;}
  let questions=[];try{questions=JSON.parse(job.required_fields_json||'[]')}catch{}
  questions=[...new Set(questions)].filter(q=>typeof q==='string'&&q.trim());
  const usable=questions.filter(q=>q.length<=240&&!/cards\[|field\d+|\b(certify|attest|signature|agree to|consent to|passport number|ssn|payment)\b/i.test(q));
  if(!usable.length){employerOnly++;continue;}
  let savedAnswers={};try{savedAnswers=JSON.parse(job.answers_json||'{}')||{}}catch{}
  const answered=q=>typeof savedAnswers[q]==='string'&&savedAnswers[q].trim();
  eligible.push({job,questions,usable,savedAnswers});
  for(const question of usable.filter(q=>!answered(q))){const key=JSON.stringify([job.applicant_id,question]);if(!groups.has(key))groups.set(key,{question,jobs:[]});groups.get(key).jobs.push(job);}
 }
 const ready=eligible.filter(({job,questions,savedAnswers})=>!job.handoff_available&&questions.every(q=>typeof savedAnswers[q]==='string'&&savedAnswers[q].trim()));
 section.hidden=!groups.size&&!ready.length;
 if(section.hidden)return;
 for(const group of groups.values()){
  const label=el('label');label.style.cssText='display:block;margin:18px 0';label.append(el('strong',group.question));
  const context=el('small',group.jobs.map(j=>j.company+' - '+j.title).join('; '));context.style.display='block';label.append(context);
  const input=el('textarea');input.maxLength=4000;input.style.cssText='display:block;width:100%;min-height:75px;margin-top:6px;padding:10px;border:1px solid #baccc0;border-radius:8px';input.dataset.answerKey=JSON.stringify([group.jobs[0].applicant_id,group.question]);input.setAttribute('aria-label',group.question);label.append(input);group.input=input;form.append(label);chatQuestionTools(form,group.question);
 }
 const message=el('p');message.setAttribute('role','status');
 if(groups.size||ready.length){
  const autofill=el('button','Fill from saved profile');autofill.type='button';form.prepend(autofill);
  autofill.onclick=async()=>{autofill.disabled=true;try{const {applicants=[]}=await api('/applicants');let count=0;for(const group of groups.values()){if(group.input.value.trim())continue;const profile=applicants.find(p=>p.id===group.jobs[0].applicant_id);if(!profile)continue;const normalize=q=>q.toLowerCase().replace(/[*:]/g,'').replace(/\s+/g,' ').trim();const key=normalize(group.question);const keys=Object.keys(profile.answers||{}).filter(q=>normalize(q)===key);const basic={'name':'name','full name':'name','email':'email','email address':'email','phone':'phone','phone number':'phone','location':'location'};const answer=keys.length===1?profile.answers[keys[0]]:basic[key]?profile[basic[key]]:null;if(typeof answer==='string'&&answer.trim()){group.input.value=answer;count++;}}if(count)section.dataset.dirty='true';message.textContent=`Filled ${count} answers from your saved facts. Review and save them below. Unknown facts remain blank.`;}catch(error){message.textContent=error.message;}finally{autofill.disabled=false}};
  const rememberLabel=el('label'),remember=el('input');remember.type='checkbox';remember.checked=true;rememberLabel.append(remember,document.createTextNode(' Remember my answers for matching questions on future applications'));form.append(rememberLabel);
  const submit=el('button','Save answers and continue ready applications');submit.style.cssText='display:block;margin-top:18px;background:#214d36;color:white';form.append(submit,message);
  form.oninput=()=>{section.dataset.dirty='true'};
  if(!groups.size)form.prepend(el('p',`${ready.length} applications have all their answers saved and are ready to continue.`));
  form.onsubmit=async e=>{e.preventDefault();const filled=[...groups.values()].filter(g=>g.input.value.trim());if(!filled.length&&!ready.length){message.textContent='Enter at least one answer. You can leave questions blank and return later.';return;}submit.disabled=true;busy=true;let saved=0,queued=0;const failures=[];
   try{for(const {job,questions,usable,savedAnswers} of eligible){const answers={};for(const q of usable){const g=groups.get(JSON.stringify([job.applicant_id,q]));if(g?.jobs.some(j=>j.id===job.id)&&g.input.value.trim())answers[q]=g.input.value.trim();}const combined={...savedAnswers,...answers};if(!Object.keys(answers).length&&!ready.some(r=>r.job.id===job.id))continue;
    try{for(const [question,answer] of Object.entries(answers)){await api('/jobs/'+job.id+'/answers','PUT',{question,answer,remember:remember.checked});saved++;}
     if(!job.handoff_available&&questions.every(q=>typeof combined[q]==='string'&&combined[q].trim())){await api('/jobs/'+job.id+'/continue','POST',{answers:combined,remember:remember.checked});queued++;}
    }catch(error){failures.push(job.company+': '+error.message);}
   }
   message.textContent=`Saved ${saved} answers. ${queued} applications queued to continue.`+(failures.length?' Some applications need attention: '+failures.join('; '):' Any unanswered questions and employer-site steps still need your input.');
   const pending=new Map([...groups].map(([key,g])=>[key,g.input.value]));
   section.dataset.dirty='false';delete section.dataset.signature;$('#notice').textContent=message.textContent;
   busy=false;
   try{await refresh(true);const next=$('#missing-answers');for(const input of next.querySelectorAll('textarea')){const value=pending.get(input.dataset.answerKey);if(value){input.value=value;next.dataset.dirty='true';}}}catch(error){section.dataset.dirty='true';message.textContent+=' Refresh failed; your entered answers are retained. '+error.message;$('#notice').textContent=message.textContent;}
   }finally{busy=false;submit.disabled=false;}
  };
 }else form.append(el('p','No readable missing-answer questions are available right now.'));
 section.append(form,el('p',`${employerOnly} applications need an employer-site step, such as verification, a declaration, an upload, or a question whose label could not be read. Open Resolve next step below for those.`));
}
async function updateDiscovery(){
 let section=$('#discovery-status');if(!section){section=el('section');section.id='discovery-status';section.style.cssText='padding:16px;border:1px solid #dce6df;border-radius:12px;margin-bottom:20px';$('#workspace').prepend(section);}
 try{const data=await api('/searches'),searches=(data.searches||[]).filter(s=>s.enabled);section.replaceChildren(el('strong','Automatic job discovery'));
 if(!searches.length){section.append(el('p','No searches enabled. Add a saved search in profile setup.'));return;}
 const latest=searches.filter(s=>s.last_run).sort((a,b)=>b.last_run.localeCompare(a.last_run))[0],result=latest?.last_result;
 section.append(el('p',`${searches.length} enabled search${searches.length===1?'':'es'} · Checks every ${data.intervalHours||1} hour(s). New matches appear automatically; duplicates are skipped.`));
 section.append(el('p',latest?`Last check: ${new Date(latest.last_run).toLocaleString()}${result?` · ${result.scanned} postings checked · ${result.added} new matches · ${result.queued} queued`: ' · Results pending'}`:'First check is pending.'));
 if(latest?.last_error)section.append(el('p','Some sources could not be checked. Available sources continue to run.'));
 if(searches.some(s=>s.instruction.includes('priority: York Region')))section.append(el('p','Priority: York Region → Toronto → GTA → remote → Canada → worldwide. Matches are based on your role preferences; eligibility may still need your input.'));
 }catch{section.textContent='Search activity could not be loaded. Refresh to try again.';}
}
const rememberLogin=rememberOption($('#auth'));
$('#auth').onsubmit=async e=>{e.preventDefault();try{token=(await api('/login','POST',{...Object.fromEntries(new FormData(e.target)),remember:rememberLogin.checked})).token;saveSession(token,rememberLogin.checked);await refresh(true);$('#notice').textContent=''}catch(e){$('#notice').textContent=e.message}};
$('#logout').onclick=()=>{clearSession();location.reload()};
for(const a of document.querySelectorAll('[data-profile-link]'))a.href=(location.hostname.endsWith('.netlify.app')||location.hostname.endsWith('.pages.dev'))?'/setup.html':'/setup';
let activeHandoff=null,remoteBusy=false,remoteTimer=null,currentFilter='all';
function applyFilters(){const q=$('#job-search').value.toLowerCase().trim();let shown=0;for(const card of $('#jobs').children){const state=card.dataset.state;const match=currentFilter==='all'||currentFilter===state||currentFilter==='needs'&&['paused','needs_review'].includes(state)||currentFilter==='applying'&&['queued','running','local_browser'].includes(state)||currentFilter==='local'&&card.dataset.local==='true';card.hidden=!(match&&card.dataset.search.includes(q));if(!card.hidden)shown++;}$('#empty-state').hidden=shown>0;}
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
 box.append(el('h2','Answer library'),el('p','Save filled employer forms with the extension’s Save form answers to library button. Review captured answers here before reusing them. Sensitive fields are excluded; dropdown choices remain manual.'));
 const load=el('button','Open / refresh answer library'),list=el('div');box.append(load,list);$('#workspace').prepend(box);
 load.onclick=async()=>{load.disabled=true;try{const {answers}=await api('/answer-library');list.replaceChildren();if(!answers.length)list.append(el('p','No captured answers yet. Save a filled form from its employer tab.'));
 for(const entry of answers){const form=el('form');form.style.cssText='padding:12px 0;border-top:1px solid #ddd';const input=field(form,entry.question);input.value=entry.answer;form.append(el('small',entry.company+' · '+(entry.confirmed?'Employer receipt recorded':'Captured draft — not proof of submission')));
 const label=el('label'),reuse=el('input');reuse.type='checkbox';reuse.checked=!!entry.reusable;reuse.disabled=!entry.canReuse;label.append(reuse,document.createTextNode(entry.canReuse?' Reuse for matching questions on future applications':' Application-specific answer; automatic reuse disabled'));form.append(label);
 const save=el('button','Save answer'),remove=el('button','Delete answer'),status=el('p');status.setAttribute('role','status');remove.type='button';form.append(save,remove,status);
 form.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{await api('/answer-library/'+entry.id,'PUT',{answer:input.value,reuse:reuse.checked});status.textContent='Saved. Reusable answers are available when an application next fills saved answers.';}catch(e){status.textContent=e.message;}finally{save.disabled=false;}};
 remove.onclick=async()=>{if(!confirm('Delete this saved answer and stop reusing it?'))return;remove.disabled=true;try{await api('/answer-library/'+entry.id,'DELETE');form.remove();}catch(e){status.textContent=e.message;remove.disabled=false;}};list.append(form);
 }}catch(e){list.textContent=e.message;}finally{load.disabled=false;}};
}
