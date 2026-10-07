
function paySummary(job){
 const wrap=el('div');wrap.className='job-pay';const rows=job.metadata?.pay||[];
 if(job.metadata?.available===false){wrap.append(el('strong','Posting availability needs review'));return wrap;}
 if(!rows.length){wrap.append(el('strong',job.metadata?.manualReview?'Pay needs confirmation':job.metadata?.checkedAt?'Annual pay not disclosed':'Annual pay · checking employer posting'));return wrap;}
 for(const pay of rows){
  const number=n=>Number(n).toLocaleString('en-US',{maximumFractionDigits:0}),range=(lo,hi)=>number(lo)+(lo===hi?'':'–'+number(hi));
  wrap.append(el('strong',pay.currency+' '+range(pay.annualMin,pay.annualMax)+' / year'+(pay.estimated?' · estimate':'')));
  if(pay.estimated)wrap.append(el('small','Posted '+pay.currency+' '+range(pay.min,pay.max)+' / '+pay.period+'; assumes '+pay.assumption+' per year. Actual paid time may differ.'));
  if(pay.label)wrap.append(el('small',pay.label));
 }
 wrap.append(el('small','Employer-posted ranges; location and level may affect your offer.'));return wrap;
}
function nextMatchCandidate(job){
 const m=job.metadata||{};if(job.employer_hold||!['saved','queued'].includes(job.status)||job.local_attempt_at||Number(job.attempts||0)||job.challenge||job.handoff_available||m.available===false)return false;
 if(job.status==='queued')return true;
 return m.available===true&&(m.strong===true||m.matched===true)&&m.eligibility?.eligible===true&&Date.now()-Date.parse(m.checkedAt||'')<86400000;
}
function renderNextMatch(jobs){
 let box=$('#next-match');if(!box){box=el('section');box.id='next-match';box.className='next-match';placeWorkspacePanel(box);}
 placeWorkspacePanel(box);box.hidden=!!activeFocus.enabled;if(activeFocus.enabled)return;
 if(box.contains(document.activeElement))return;
 const job=[...jobs].filter(nextMatchCandidate).sort((a,b)=>Number(b.status==='queued')-Number(a.status==='queued')||(Number(a.queue_position)||Infinity)-(Number(b.queue_position)||Infinity)||(Number(b.match_score)||0)-(Number(a.match_score)||0)||String(b.created_at||'').localeCompare(String(a.created_at||''))||String(a.id).localeCompare(String(b.id)))[0];
 const signature=JSON.stringify(job||null);if(box.dataset.signature===signature)return;box.dataset.signature=signature;
 box.replaceChildren(el('span','YOUR NEXT APPLICATION'));
 if(!job){box.append(el('h2','Checking for your next eligible match'),el('p','New recommendations appear after profile fit, employer availability and work eligibility are checked. Applications already attempted stay out of this list.'));return;}
 const heading=el('div');heading.className='next-match-heading';heading.append(el('h2',job.title),paySummary(job));box.append(heading,el('p',job.company+' · '+(job.metadata?.location||'Location not listed')));
 if(job.status==='queued'&&job.metadata?.eligibility?.eligible!==true)box.append(el('p','Queued by your all-found setting. Work eligibility still needs confirmation from the posting.'));
 else if(!job.metadata?.strong)box.append(el('p','Related role match — review the required seniority and skills before applying.'));
 box.append(el('p','Next in your company/platform rotation · '+job.match_score+'/100 role and eligibility score'),el('p',(job.metadata?.reasons||[]).join(' · ')),el('small','This score compares saved role preferences and posting evidence; it is not a hiring probability.'));
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
const $=s=>document.querySelector(s);let activeBatch={},activeFocus={},token=restoreSession(),busy=false,lastSignature='',pendingHandoff=null,externalRecords=[],overviewSignature='',readyAutoOpened=new Set();
const el=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e};
async function api(path,method='GET',data){const r=await fetch(((location.hostname.endsWith('.netlify.app')||location.hostname.endsWith('.pages.dev'))?'https://marvelous-vitality-production-c2d8.up.railway.app':'')+'/api'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d}
function field(form,label){const l=el('label',label),i=el('textarea');i.required=true;i.maxLength=4000;l.append(i);form.append(l);return i}
function chatQuestionTools(parent,question,job,input,researchJobs=[job]){
 const disclosure=el('details');disclosure.className='answer-tools';disclosure.append(el('summary','Help draft an answer'));const tools=el('div');tools.className='chat-question-tools';tools.style.cssText='margin:8px 0 16px';
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
  const draft=el('button','Draft with my saved facts');draft.type='button';draft.onclick=async()=>{const q=String(typeof question==='function'?question():question).trim();if(!q){status.textContent='Enter the question first.';return;}if(input.value.trim()){status.textContent='Your answer is preserved. Clear it first if you want a new draft.';return;}draft.disabled=true;const original=input.value;status.textContent='Drafting from approved facts…';try{const result=await api('/jobs/'+job.id+'/draft-answer','POST',{question:q});if(input.value!==original){status.textContent='Your edits are preserved. Request a draft again if needed.';return;}if(result.answer){input.value=result.answer;input.dispatchEvent(new Event('input',{bubbles:true}));const holder=parent.closest('section');if(holder)holder.dataset.dirty='true';status.textContent='AI draft saved for this application. Review it before submission. Based on: '+result.sources.join('; ');}else status.textContent=result.reason||'More facts are needed.';}catch(e){status.textContent=e.message;}finally{draft.disabled=false;}};tools.append(draft);const memory=el('a','Add supporting experience');memory.href='/setup#experience-library';memory.target='_blank';memory.rel='noopener';memory.style.marginLeft='12px';tools.append(memory);
  const contexts=(researchJobs||[]).filter(Boolean);
  if(contexts.length===1){const sources=el('div'),research=el('button','Draft from public job page');research.type='button';research.onclick=async()=>{const q=String(typeof question==='function'?question():question).trim();if(!q){status.textContent='Enter the question first.';return;}if(input.value.trim()){status.textContent='Your answer is preserved. Clear it first if you want a cited public-page draft.';return;}research.disabled=true;sources.replaceChildren();const original=input.value;status.textContent='Drafting from the public job page…';try{const result=await api('/jobs/'+job.id+'/research-answer','POST',{question:q});if(input.value!==original){status.textContent='Your edits are preserved. Request the public-page draft again if needed.';return;}if(!result.answer){status.textContent=result.reason||'The cited public page could not answer this question.';return;}input.value=result.answer;input.dataset.researchDraft='true';input.dispatchEvent(new Event('input',{bubbles:true}));const holder=parent.closest('section');if(holder)holder.dataset.dirty='true';status.textContent='Cited public-page draft — check the sources and review before submission. It stays with this application.';const valid=[];for(const source of result.citations||[]){try{const u=new URL(source.url);if(u.protocol!=='https:')continue;const a=el('a',source.title||u.hostname);a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';valid.push(a);}catch{}}if(valid.length){sources.append(el('small','Sources: '));for(const [i,a] of valid.entries()){if(i)sources.append(document.createTextNode(' · '));sources.append(a);}}input.addEventListener('input',()=>{sources.replaceChildren();status.textContent='Edited application-only draft — review before submission.';},{once:true});}catch(e){status.textContent=e.message;}finally{research.disabled=false;}};tools.append(research,sources);}
 }
 tools.append(copy,open,help,status);disclosure.append(tools);parent.append(disclosure);
}
async function notificationSettings(){
 if($('#blocker-notifications'))return;
 const section=el('section');section.id='blocker-notifications';section.style.marginBottom='20px';
 const label=el('label'),toggle=el('input');toggle.type='checkbox';label.append(toggle,document.createTextNode(' Email me when an application needs my input'));
 const status=el('p');status.setAttribute('role','status');section.append(label,status);placeWorkspacePanel(section);
 const display=d=>{toggle.checked=!!d.enabled;status.textContent=!d.configured?'Email delivery is not connected yet. Your preference is saved; a verified sender must be configured.':d.failed?'Email delivery needs attention. Check the dashboard for all blockers.':d.enabled?'Blocker emails are enabled. Emails link directly to the paused application.':'Blocker emails are off.';};
 try{display(await api('/notifications'));}catch{status.textContent='Notification settings could not be loaded.';}
 toggle.onchange=async()=>{toggle.disabled=true;try{display(await api('/notifications','PUT',{enabled:toggle.checked}));}catch(e){status.textContent=e.message;toggle.checked=!toggle.checked;}finally{toggle.disabled=false}};
}
async function refresh(force=false){
 if(busy||activeHandoff)return;
 const [{jobs,deferred=[],focus={},batch={}},health,history,operations,activity,continuations,pipeline,employerLimits]=await Promise.all([api('/jobs'),api('/status'),api('/application-history'),api('/operations').catch(()=>null),api('/activity').catch(()=>null),api('/continuations').catch(()=>null),api('/pipeline').catch(()=>null),api('/employer-limits').catch(()=>null)]);
 const waiting=new Map((continuations?.requests||[]).map(r=>[r.job_id,r]));
 for(const job of jobs)job.continuation=waiting.get(job.id);
 const evidence=new Map((operations?.applications||[]).map(j=>[j.id,j]));
 for(const job of jobs)job.evidence=evidence.get(job.id);
 externalRecords=history.records;
 $('#login').hidden=true;$('#workspace').hidden=false;$('#logout').hidden=false;
 notificationSettings();
 refreshFunnel();updateDiscovery();updateAIStatus();
 activeBatch=batch||{};activeFocus=focus;document.body.dataset.singleApplication=String(!!focus.enabled);
 const current=jobs.filter(j=>j.status!=='duplicate'&&(!focus.enabled||j.id===focus.job_id));
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
 renderBrowserReadiness(current);renderMissingAnswers(current);renderContinuationQueue(continuations);drainContinuations(continuations);renderLibraryLauncher();renderBatchControl(activeBatch);renderFocusControl(focus);renderArchiveControl(current);if($('#career-overview'))placeWorkspacePanel($('#career-overview'));renderOperations(operations,activity,current);renderNextMatch(current);renderPipeline(pipeline);renderEmployerLimits(employerLimits,current);renderCooldownHistory(deferred);renderHomeSummary(operations,current,interviews);
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
 const attention=globalThis.ApplyPilotPolicy.attentionOrder(current.filter(needsMyAttention)),attentionPositions=new Map(attention.map((j,i)=>[j.id,i+1]));
 const blocked=j=>globalThis.ApplyPilotPolicy.needsInput(j);
 const rank=j=>preparationStage(j)==='ready'?-1:blocked(j)?0:1+['local_browser','running','queued','saved','submitted','interview','rejected','offer'].indexOf(j.status);
 const updated=j=>Number.isFinite(Date.parse(j.updated_at))?Date.parse(j.updated_at):0;
 current.sort((a,b)=>rank(a)-rank(b)||(attentionPositions.has(a.id)&&attentionPositions.has(b.id)?attentionPositions.get(a.id)-attentionPositions.get(b.id):0)||(Number(a.queue_position)||Infinity)-(Number(b.queue_position)||Infinity)||(['saved','queued'].includes(a.status)&&a.status===b.status?(Number(b.match_score)||0)-(Number(a.match_score)||0):0)||updated(b)-updated(a)||String(a.id).localeCompare(String(b.id)));
 for(const r of focus.enabled?[]:externalInterviews){const card=interviewCard(r);card.id='external-'+r.id;$('#jobs').append(card);}
 for(const job of current){
  if(job.status==='interview'){const r=interviews.find(r=>interviewIdentity(r)===interviewIdentity(job));const card=interviewCard(r);card.id='job-'+job.id;card.dataset.completion=job.evidence?.completion||'';card.dataset.confirmed=String(!!job.evidence?.confirmed);card.dataset.worked=String(!!job.evidence?.worked);$('#jobs').append(card);continue;}
  const card=el('article');card.id='job-'+job.id;card.className='job';card.dataset.preparation=preparationStage(job)||'';card.dataset.pending=String(pendingSubmission(job));card.dataset.actionable=String(pendingSubmission(job)&&!['running','queued'].includes(job.status));card.dataset.completion=job.evidence?.completion||'';card.dataset.search=(job.title+' '+job.company).toLowerCase();card.dataset.local=String(job.status==='local_browser');for(const key of ['active','blocked','stalled','worked','confirmed'])card.dataset[key]=String(!!job.evidence?.[key]);card.dataset.state=job.evidence?.awaiting||job.local_attempt_at&&!job.evidence?.confirmed&&job.status==='local_browser'?'awaiting':job.status==='local_browser'&&job.local_phase==='blocked'?'needs_review':job.status;const heading=el('div');heading.className='job-heading';const mark=el('span',(job.company||'A').slice(0,1).toUpperCase());mark.className='company-mark';const names=el('div');if(attentionPositions.has(job.id)){const counter=el('span',attentionPositions.get(job.id)+'/'+attention.length+' · Needs your input');counter.className='attention-position';counter.style.cssText='display:inline-block;font-size:14px;font-weight:750;color:#245a3c;background:#e9f4ec;border-radius:8px;padding:4px 9px;margin-bottom:7px';counter.setAttribute('aria-label','Application '+attentionPositions.get(job.id)+' of '+attention.length+' needing your input');names.append(counter);}names.append(el('h2',job.title),paySummary(job),el('small',job.company));if(job.metadata?.supportCareer?.demands?.length)names.append(el('small',job.metadata.supportCareer.demands.join('; ')));if(job.metadata?.checkedAt){names.append(el('small',(job.match_score||0)+'/100 role and eligibility score · '+(job.metadata.location||'Location not listed')+(job.metadata.eligibility?.eligible?'':' · Eligibility needs confirmation')));}const badge=el('span',({saved:'Found',running:'Preparing',queued:'Preparing · queued',paused:'Blocked',needs_review:job.challenge==='Ready to submit'?'Ready to submit':'Blocked',local_browser:job.evidence?.stalled?'Browser check needed':job.local_phase==='blocked'?(/^Ready (?:for your review|to submit)/.test(job.last_message||'')?'Ready to submit':'Needs your input'):job.local_attempt_at?'Awaiting receipt':'Preparing · local',submitted:job.evidence?.confirmed?'Receipt recorded':'Submission needs evidence',interview:'Interview',rejected:'Rejected',offer:'Offer'})[job.status]);badge.className='badge '+(job.status==='local_browser'&&job.local_phase==='blocked'?'needs_review':job.status);if(job.employer_hold&&!job.evidence?.confirmed)badge.textContent='Employer application limit';heading.append(mark,names,badge);card.append(heading);if(job.manual_submit_clicks)card.append(el('small',job.manual_submit_clicks+' manual Submit clicks recorded · application counted once · confirmation requires an employer receipt'));if(job.employer_hold&&!job.evidence?.confirmed)card.append(el('p',job.employer_hold.message+' Applications to this employer are paused. Other employers can continue.'));
  if(job.evidence?.stalled)card.append(el('p','No recent browser activity has been received. Check the helper and employer tab; this form is not counted as actively filling.'));
  if(job.metadata?.eligibility?.kind==='canada-employment-fallback')heading.append(el('strong','Employee / T4 fallback'));
  if(job.metadata?.manualReview){badge.textContent='Review & apply';if(job.notes)card.append(el('p',job.notes));}
  const updated=Date.parse(job.updated_at),stamp=el('p');stamp.className='last-updated';stamp.style.cssText='font-size:13px;color:#626c65;margin:8px 0';
  if(Number.isFinite(updated)){const time=el('time',new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(updated)));time.dateTime=new Date(updated).toISOString();stamp.append(document.createTextNode('Last updated: '),time);}else stamp.textContent='Last updated: unavailable';card.append(stamp);renderCompanyCareers(card,job);
  if(!['running','queued','local_browser'].includes(job.status)&&!job.handoff_available){const remove=el('button','Delete application permanently');remove.onclick=async()=>{if(!window.confirm('Permanently delete the visible record and captured answers for '+job.title+' at '+job.company+'? This cannot be undone and does not withdraw an employer application. Minimal requisition and company activity is retained to prevent duplicate or excess applications.'))return;remove.disabled=true;try{await api('/jobs/'+job.id,'DELETE',{confirm:job.id});await refresh(true);}catch(e){$('#notice').textContent=e.message;remove.disabled=false;}};card.append(remove);}
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
   const p=el('p',local?'This profile uses your Windows browser. Open the extension to prepare this application.':'ApplyPilot fills supported routine steps using your saved profile, then leaves the completed form open for you to review and click Submit.');
   card.append(p);
   if(local){const a=el('a','Browser setup');a.href='https://marvelous-vitality-production-c2d8.up.railway.app/local-browser.html';card.append(a);}
   {const start=el('button',local?'Queue for my browser':'Prepare application'),message=el('p');message.setAttribute('role','status');start.onclick=async()=>{start.disabled=true;try{await api('/jobs/'+job.id+'/queue','POST',{});await refresh(true);$('#notice').textContent=local?'Application queued. Keep your updated browser helper and signed-in dashboard open.':'Application queued. ApplyPilot will fill supported steps and stop before final submission.';}catch(e){message.textContent=e.message;start.disabled=false;}};card.append(start,message);}
   $('#jobs').append(card);continue;
  }
  if(['running','queued'].includes(job.status)){card.append(el('p',job.status==='running'?'Preparing the application with your saved answers…':job.execution_mode==='local'?'Queued for your browser. Keep the signed-in dashboard and browser helper open.':'Queued for the hosted worker to prepare.'));$('#jobs').append(card);continue}
  const blocker=el('p',job.status==='local_browser'?(job.last_message||'Continue in your employer browser tab.'):job.blocker_message||job.challenge||'This application needs your input.');blocker.className='blocker';card.append(blocker);const actions=el('details');actions.className='job-actions';actions.append(el('summary',job.challenge==='Ready to submit'?'Review and submit':job.status==='local_browser'?'Continue application':'Resolve next step'));card.append(actions);
  const msg=el('p');msg.className='message';msg.setAttribute('role','status');actions.append(msg);
  const human=['CAPTCHA','Sign-in','Unconfirmed submission','Submission in progress','Sensitive action','Ready to submit'].includes(job.challenge);
  let questions=[];try{questions=JSON.parse(job.required_fields_json||'[]')}catch{}
  const upload=job.challenge==='Upload needs review'||/upload|resume.*not found/i.test(job.blocker_message||'');
  const takeover=el('button',job.handoff_available?(job.challenge==='Ready to submit'?'Review filled form and submit':'Take over filled application'):'Prepare live application');
  takeover.onclick=async()=>{
   if(pendingHandoff){$('#notice').textContent='Another live browser is being prepared. Wait for it or cancel opening it.';return;}
   takeover.disabled=true;takeover.textContent='Preparing browser…';
   try{const r=await api('/jobs/'+job.id+'/handoff/open','POST',{});if(r.available)await openHandoff(job);else{
    pendingHandoff={id:job.id,started:Date.now()};
    let banner=$('#preparing-browser');if(!banner){banner=el('section');banner.id='preparing-browser';banner.style.cssText='padding:20px;background:#e2ede7;border:2px solid #74ad91;border-radius:12px;margin-bottom:20px';$('#workspace').insertBefore(banner,$('#jobs').closest('.list-panel')||$('#jobs'));}
    banner.replaceChildren(el('p','Preparing the live browser for '+job.company+' — '+job.title+'. It will open here automatically when ready.'));
    banner.setAttribute('role','status');const cancel=el('button','Cancel opening');cancel.onclick=()=>{pendingHandoff=null;banner.remove();$('#notice').textContent='Automatic opening cancelled. The worker may still prepare this application.';};banner.append(cancel);
    await refresh(true);
   }}catch(e){msg.textContent=e.message;$('#notice').textContent=e.message;}finally{takeover.disabled=false;takeover.textContent=job.handoff_available?(job.challenge==='Ready to submit'?'Review filled form and submit':'Take over filled application'):'Prepare live application';}
  };
  if(job.status!=='local_browser'&&!job.metadata?.manualReview){
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
   if(!job.local_attempt_at){const automatic=el('button','Continue autofill');automatic.className='continue-autofill';automatic.onclick=async()=>{automatic.disabled=true;actions.open=true;msg.textContent='Resuming saved answers…';try{await resumeLocalApplication(job.id);msg.textContent=activeFocus.auto_submit?'Selected application resumed with automatic submission enabled.':'Autofill resumed. Final Submit stays with you.';await refresh(true);}catch(e){msg.textContent=e.message;}finally{automatic.disabled=false;}};card.insertBefore(automatic,actions);}
  }
  if(job.status!=='local_browser'&&!human&&!upload&&!job.handoff_available&&!job.metadata?.manualReview){
   const form=el('form');form.oninput=()=>{form.dataset.dirty='true'};
   const fields=[];
   if(questions.length){for(const question of [...new Set(questions)]){const input=field(form,question);fields.push({question,input});chatQuestionTools(form,question,job,input);}}
   else{const q=field(form,'Question shown on the employer form');q.maxLength=4000;const input=field(form,'Your answer');fields.push({questionInput:q,input});chatQuestionTools(form,()=>q.value,job,input)}
   for(const f of fields)autoSaveField(f.input,()=>f.question||f.questionInput.value,[job],form);
   form.onsubmit=e=>e.preventDefault();actions.append(form);
  }
  const link=el('a',job.metadata?.manualReview?'Open application':'Open this application on the employer site');link.href=job.url;link.target='_blank';link.rel='noopener noreferrer';if(job.metadata?.manualReview){link.className='primary manual-application-link';card.insertBefore(link,actions);}else actions.append(link);
  if(human||upload)actions.append(el('p',job.challenge==='Unconfirmed submission'?'Check whether the employer received this application before trying again.':job.challenge==='Ready to submit'?'Review the filled application in the live browser, then click the employer’s Submit button yourself.':'Use Take over to work in the worker’s browser. The separate employer link starts a different browser session.'));
  const done=el('details');done.append(el('summary','I submitted this application'));
  const reported=el('button','Mark completed');reported.type='button';reported.className='mark-completed';reported.title='Use after you submit the application. Adds it to Completed and stops repeat applications; employer confirmation stays separate.';card.insertBefore(reported,actions);done.append(el('p','An employer receipt upgrades a completed application to employer-confirmed.'));
  let recording=false;reported.onclick=async()=>{if(recording)return;recording=true;reported.hidden=true;busy=true;try{await api('/jobs/'+job.id+'/report-submitted','POST',{reported:true});busy=false;await refresh(true);$('#notice').textContent='Marked completed and removed from your to-do list. Employer receipt is still unverified.';}catch(e){$('#notice').textContent=e.message;reported.hidden=false;}finally{busy=false;recording=false;}};
  const receiptForm=el('form'),receipt=field(receiptForm,'Employer confirmation reference or message');receipt.minLength=8;receipt.maxLength=300;
  const label=el('label'),check=el('input');check.type='checkbox';check.required=true;check.style.cssText='display:inline;width:auto;margin-right:8px';label.append(check,document.createTextNode('The employer confirmed receipt.'));receiptForm.append(label);
  const confirm=el('button','Confirm submitted');receiptForm.append(confirm);receiptForm.onsubmit=async e=>{e.preventDefault();confirm.disabled=true;busy=true;try{await api('/jobs/'+job.id+'/confirm','POST',{receipt:receipt.value});busy=false;await refresh(true);$('#notice').textContent='Submission recorded. The application is now shown as Submitted.'}catch(e){msg.textContent=e.message}finally{busy=false;confirm.disabled=false}};done.append(receiptForm);actions.append(done);$('#jobs').append(card);
 }

 compactJobCards();applyFilters();
 const linked=document.getElementById(location.hash.slice(1));
 if(linked?.classList.contains('job')&&(location.search.includes('view=settings')||linked.dataset.pending==='true'&&['ready','answers','employer','review'].includes(linked.dataset.preparation))){linked.hidden=false;linked.style.outline='3px solid #74ad91';const details=linked.querySelector('details');if(details)details.open=true;if(!linked.dataset.focused){linked.scrollIntoView?.({block:'center'});linked.dataset.focused='true';}}
}

// One serialized writer per field; newer edits cannot be overwritten by a slow save.
function autoSaveField(input,question,jobs,holder){
 const status=el('small'),retry=el('button','Retry saving');status.setAttribute('role','status');retry.type='button';retry.hidden=true;input.after(status,retry);
 let timer,writing=false,revision=0,savedValue=null,savedCommitted=false,commitPending=false;
 const dirty=()=>{input.dataset.unsaved='true';holder.dataset.dirty='true';};
 async function flush(commit=false){
  commitPending=commitPending||commit===true;clearTimeout(timer);if(writing)return;const value=input.value.trim(),q=String(typeof question==='function'?question():question).trim();if(!value||!q){status.textContent='Empty answer is not saved.';return;}
  if(value===savedValue&&(!commitPending||savedCommitted)){commitPending=false;input.dataset.unsaved=String(!savedCommitted);holder.dataset.dirty=String(!!holder.querySelector('[data-unsaved="true"]'));return;}writing=true;const version=revision,resume=commitPending;commitPending=false;status.textContent='Saving...';retry.hidden=true;
  try{for(const job of jobs)await api('/jobs/'+job.id+'/answers','PUT',{question:q,answer:value,remember:input.dataset.applicationOnly!=='true'&&input.dataset.researchDraft!=='true',autosave:true,resume});
   savedValue=value;savedCommitted=resume;status.textContent=resume?'Saved automatically':'Draft saved - finish this question to reuse it';if(revision===version){input.dataset.unsaved=String(!resume);holder.dataset.dirty=String(!!holder.querySelector('[data-unsaved="true"]'));}
  }catch(e){status.textContent='Not saved: '+e.message;retry.hidden=false;dirty();}
  finally{writing=false;if(revision>version||commitPending)void flush();}
 }
 const changed=()=>{revision++;dirty();status.textContent='Waiting to save...';clearTimeout(timer);timer=setTimeout(flush,800);};
 input.addEventListener('input',changed);input.addEventListener('change',()=>{changed();void flush(true);});input.addEventListener('blur',()=>flush(true));retry.onclick=()=>flush(true);
 return {flush,changed};
}

function renderMissingAnswers(jobs){
 if(!location.search.includes('view=settings'))jobs=jobs.filter(needsMyAttention);
 let section=$('#missing-answers');
 if(section?.dataset.dirty==='true')return;
 const signature=JSON.stringify(jobs.map(j=>[j.id,j.status,j.challenge,j.required_fields_json,j.answers_json,j.editing_questions,j.draft_needs,j.handoff_available,j.application_only_questions,j.local_phase,j.local_attempt_at,j.continuation?.state]));
 if(section?.dataset.signature===signature)return;
 if(!section){section=el('section');section.id='missing-answers';section.style.cssText='padding:24px;margin:20px 0;border:2px solid #74ad91;border-radius:14px;background:#f4faf6';$('#workspace').insertBefore(section,$('#jobs').closest('.list-panel')||$('#jobs'));}
 section.dataset.signature=signature;section.replaceChildren(el('h2','Questions for you'));
 section.append(el('p',activeFocus.auto_submit?'Answer the selected form questions to resume automatic preparation. Verification and declarations need you.':'Answers save automatically as you finish each question. Matching future forms reuse saved facts. You review the application and click Submit.'));
 const form=el('form'),groups=new Map(),eligible=[];
 const groupKey=(job,question)=>JSON.stringify([job.applicant_id,question,(job.application_only_questions||[]).includes(question)||(job.editing_questions||[]).includes(question)?job.id:'']);
 const human=new Set(['CAPTCHA','Sign-in','Unconfirmed submission','Submission in progress','Sensitive action','Ready to submit','Upload needs review']);
 let employerOnly=0;
 for(const job of jobs){
  if(!['paused','needs_review'].includes(job.status)&&!(job.status==='local_browser'&&job.local_phase==='blocked'))continue;
  if(preparationStage(job)==='awaiting'||(!job.editing_questions?.length&&['queued','dispatching'].includes(job.continuation?.state)))continue;
  if(human.has(job.challenge)){employerOnly++;continue;}
  let questions=[];try{questions=JSON.parse(job.required_fields_json||'[]')}catch{}
  questions=[...new Set(questions)].filter(q=>typeof q==='string'&&q.trim());
  const usable=questions.filter(q=>q.length<=4000&&!/^required field\s*[*?]?$/i.test(q.trim())&&!/AI policy|cards\[|field\d+|\b(certify|attest|signature|arbitration|arbitrate|waiver|acknowledge|criminal|convictions|agree that|agree to|consent|passport number|ssn|payment)\b/i.test(q));
  if(!usable.length){employerOnly++;continue;}
  let savedAnswers={};try{savedAnswers=JSON.parse(job.answers_json||'{}')||{}}catch{}
  const answered=q=>!job.editing_questions?.includes(q)&&typeof savedAnswers[q]==='string'&&savedAnswers[q].trim();
  eligible.push({job,questions,usable,savedAnswers});
  for(const question of usable.filter(q=>!answered(q))){const applicationOnly=(job.application_only_questions||[]).includes(question),key=groupKey(job,question);if(!groups.has(key))groups.set(key,{question,jobs:[],applicationOnly,draft:job.editing_questions?.includes(question)?savedAnswers[question]:''});groups.get(key).jobs.push(job);}
 }
 const ready=eligible.filter(({job,questions,savedAnswers})=>!job.handoff_available&&questions.every(q=>typeof savedAnswers[q]==='string'&&savedAnswers[q].trim()));
 section.hidden=false;
 if(!groups.size&&!ready.length){section.hidden=true;return;}
 for(const group of [...groups.values()].sort((a,b)=>b.jobs.length-a.jobs.length)){
  const label=el('label');label.style.cssText='display:block;margin:18px 0';label.append(el('strong',group.question));
  const context=el('small',group.jobs.map(j=>j.company+' - '+j.title).join('; '));context.style.display='block';label.append(context);
  const input=el('textarea');input.value=group.draft||'';input.maxLength=4000;input.style.cssText='display:block;width:100%;min-height:75px;margin-top:6px;padding:10px;border:1px solid #baccc0;border-radius:8px';const reason=group.jobs.map(j=>j.draft_needs?.[group.question]).find(Boolean);if(reason){const detail=el('small',reason);detail.className='missing-fact-reason';detail.style.display='block';label.append(detail);}input.dataset.answerKey=groupKey(group.jobs[0],group.question);if(group.applicationOnly)input.dataset.applicationOnly='true';input.setAttribute('aria-label',group.question);label.append(input);group.input=input;form.append(label);chatQuestionTools(form,group.question,group.jobs[0],input,group.jobs);
 }

 form.onsubmit=e=>e.preventDefault();
 for(const group of groups.values())group.autosave=autoSaveField(group.input,group.question,group.jobs,section);
 api('/applicants').then(async({applicants=[]})=>{for(const group of groups.values()){
  if(!group.input.isConnected||group.input.value.trim())continue;const profile=applicants.find(p=>p.id===group.jobs[0].applicant_id);if(!profile)continue;
  const value=preparedProfileAnswer(group.question,profile,group.applicationOnly?{}:profile.reusableAnswers||{});
  if(typeof value==='string'&&value.trim()){group.input.value=value;group.autosave.changed();await group.autosave.flush(true);}
 }}).catch(()=>{});
 // Saved-answer recovery and the browser helper resume preparation automatically.
 if(!groups.size){section.hidden=true;return;}
 
 section.append(form);
}
async function updateDiscovery(force=false){
 let section=$('#discovery-status');if(!force&&(section?.contains(document.activeElement)||section?.querySelector('details[open]')))return;if(!section){section=el('section');section.id='discovery-status';section.style.cssText='padding:16px;border:1px solid #dce6df;border-radius:12px;margin-bottom:20px';placeWorkspacePanel(section);}
 try{const data=await api('/searches'),searches=(data.searches||[]).filter(s=>s.enabled);section.replaceChildren(el('strong','Automatic job discovery'));
 const controls=el('details');controls.append(el('summary','Manage saved searches'));
 for(const saved of data.searches||[]){const row=el('div'),toggle=el('button',saved.enabled?'Pause search':'Enable search');row.append(el('p',saved.instruction),toggle);toggle.onclick=async()=>{toggle.disabled=true;try{await api('/searches/'+saved.id+'/toggle','POST');await updateDiscovery(true);}catch(e){$('#notice').textContent=e.message;toggle.disabled=false;}};const run=el('button','Run search now');run.onclick=async()=>{run.disabled=true;run.textContent='Checking employer postings…';try{await api('/searches/'+saved.id+'/run','POST',{});await updateDiscovery(true);await refresh(true);}catch(e){$('#notice').textContent=e.message;run.disabled=false;run.textContent='Run search now';}};row.append(run);controls.append(row);}section.append(controls);
 if(!searches.length){section.append(el('p','No searches enabled. Add a saved search in profile setup.'));return;}
 const latest=searches.filter(s=>s.last_run).sort((a,b)=>b.last_run.localeCompare(a.last_run))[0],result=latest?.last_result;
 section.append(el('p',`${searches.length} enabled search${searches.length===1?'':'es'} · Checks every ${Math.round((data.intervalSeconds||60)/60)} minute(s), rotating employer boards. Newly found matches appear automatically; duplicates are skipped.`));
 section.append(el('p',latest?`Last check: ${new Date(latest.last_run).toLocaleString()}${result?` · ${result.scanned} postings checked · ${result.added} new matches · ${result.queued} queued`: ' · Results pending'}`:'First check is pending.'));
 section.append(el('p','A check can find zero suitable new jobs. Posted pay and match details also refresh in the background. '+(searches.some(s=>s.auto_queue)?'Automatic searches queue all verified matches. The pipeline setting can also queue every found job.':'Automatic applications are off for these searches.')));
  if(latest?.last_error)section.append(el('p','Some sources could not be checked: '+latest.last_error));
 if(searches.some(s=>s.instruction.includes('priority: York Region')))section.append(el('p','Priority: York Region → Toronto → GTA → remote → Canada → worldwide. Matches are based on your role preferences; eligibility may still need your input.'));
 }catch{section.textContent='Search activity could not be loaded. Refresh to try again.';}
}
const rememberLogin=rememberOption($('#auth'));
$('#auth').onsubmit=async e=>{e.preventDefault();try{token=(await api('/login','POST',{...Object.fromEntries(new FormData(e.target)),remember:rememberLogin.checked})).token;saveSession(token,rememberLogin.checked);await refresh(true);$('#notice').textContent=''}catch(e){$('#notice').textContent=e.message}};
$('#logout').onclick=()=>{clearSession();location.reload()};
for(const a of document.querySelectorAll('[data-profile-link]'))a.href=(location.hostname.endsWith('.netlify.app')||location.hostname.endsWith('.pages.dev'))?'/setup.html':'/setup';
let activeHandoff=null,remoteBusy=false,remoteTimer=null,currentFilter='pending';
function applyFilters(){const q=$('#job-search').value.toLowerCase().trim();let shown=0;for(const card of $('#jobs').children){const state=card.dataset.state;const focusAllowed=location.search.includes('view=settings')||card.dataset.pending==='true'&&['ready','answers','employer','review'].includes(card.dataset.preparation);const match=currentFilter==='pending'&&card.dataset.pending==='true'||currentFilter==='active'&&!['submitted','interview','rejected','offer'].includes(state)||currentFilter==='all'||currentFilter===state||currentFilter==='needs'&&(card.dataset.blocked==='true'||card.dataset.stalled==='true'||['paused','needs_review'].includes(state))||currentFilter==='applying'&&card.dataset.active==='true'||currentFilter==='blocked'&&card.dataset.blocked==='true'||currentFilter==='stalled'&&card.dataset.stalled==='true'||currentFilter==='receipt'&&card.dataset.confirmed==='true'||currentFilter==='worked'&&card.dataset.worked==='true'||currentFilter==='local'&&card.dataset.local==='true'||currentFilter.startsWith('completion-')&&card.dataset.completion===currentFilter.slice(11)||currentFilter.startsWith('prep-')&&card.dataset.preparation===currentFilter.slice(5);card.hidden=activeBatch.enabled?!activeBatch.job_ids.includes(card.id.replace('job-',''))||['submitted','interview','rejected','offer','archived','duplicate'].includes(state):activeFocus.enabled?card.id!=='job-'+activeFocus.job_id:!(focusAllowed&&match&&card.dataset.search.includes(q));if(!card.hidden)shown++;}$('#empty-state').hidden=shown>0;const count=$('#visible-job-count');if(count)count.textContent=shown+' shown';const title=$('#application-list-title');if(title)title.textContent=activeBatch.enabled?'Current batch - up to 20 jobs':activeFocus.enabled?'Current application':({pending:location.search.includes('view=settings')?'Jobs yet to be submitted':'Jobs needing your attention','prep-ready':'Ready for your Submit click',awaiting:'Attempted — check employer receipt',receipt:'Employer-confirmed submissions',interview:'Interviews',worked:'Forms filled or attempted',all:'All application records'})[currentFilter]||'Applications';for(const button of document.querySelectorAll('[data-home-filter]'))button.setAttribute('aria-pressed',String(button.dataset.homeFilter===currentFilter));}
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
 const footer=el('p',job.challenge==='Ready to submit'?'Review the filled application, then click the employer’s Submit button.':'Click a field and type directly. Scroll with your mouse or trackpad. Finish verification, then choose Continue automatically.');footer.className='live-footer';panel.append(footer);
 const button=(parent,label,handler,primary=false)=>{const b=el('button',label);if(primary)b.className='live-primary';b.onclick=handler;parent.append(b);return b};
 const focus=()=>surface.focus({preventScroll:true});
 function finish(note=''){if(closed)return;closed=true;clearTimeout(pollTimer);queue.length=0;resizeObserver?.disconnect();document.removeEventListener('visibilitychange',visibility);activeHandoff=null;panel.remove();refresh(true).catch(e=>$('#notice').textContent=e.message);if(note)$('#notice').textContent=note;}
 const continueButton=button(toolbar,'Continue automatically',()=>enqueue('resume'),true);continueButton.hidden=job.challenge==='Ready to submit';
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
 box.append(el('h2','Answer library'),el('p','Answers you enter save automatically as you finish each question. Reusable facts fill matching future forms; company-specific answers stay with their application. Review or correct stored answers here. Extension 0.6.27 prepares supported forms and waits for your final Submit click.'));
 const load=el('button','Open / refresh answer library'),list=el('div');box.append(load,list);placeWorkspacePanel(box);
 load.onclick=async()=>{load.disabled=true;try{const {answers}=await api('/answer-library');list.replaceChildren();if(!answers.length)list.append(el('p','No captured answers yet. Save a filled form from its employer tab.'));
 for(const entry of answers){const form=el('form');form.style.cssText='padding:12px 0;border-top:1px solid #ddd';const input=field(form,entry.question);input.value=entry.answer;form.append(el('small',entry.company+' · '+(entry.confirmed?'Employer receipt recorded':'Captured draft — not proof of submission')));
 const label=el('label'),reuse=el('input');reuse.type='checkbox';reuse.checked=!!entry.reusable;reuse.disabled=!entry.canReuse;label.append(reuse,document.createTextNode(entry.canReuse?' Reuse for matching questions on future applications':' Application-specific answer; automatic reuse disabled'));form.append(label);
 const save=el('button','Save answer'),remove=el('button','Delete answer'),status=el('p');status.setAttribute('role','status');remove.type='button';form.append(save,remove,status);
 form.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{await api('/answer-library/'+entry.id,'PUT',{answer:input.value,reuse:reuse.checked});status.textContent='Saved. Reusable answers are available when an application next fills saved answers.';}catch(e){status.textContent=e.message;}finally{save.disabled=false;}};
 remove.onclick=async()=>{if(!confirm('Delete this saved answer and stop reusing it?'))return;remove.disabled=true;try{await api('/answer-library/'+entry.id,'DELETE');form.remove();}catch(e){status.textContent=e.message;remove.disabled=false;}};list.append(form);
 }}catch(e){list.textContent=e.message;}finally{load.disabled=false;}};
}

function renderBatchControl(batch={}){
 let box=$('#application-batch');if(!box){box=el('section');box.id='application-batch';box.style.cssText='padding:20px;background:#edf6ef;border-radius:12px;margin:16px 0';$('#home-summary').after(box);}
 if(box.contains(document.activeElement))return;
 box.hidden=!batch.enabled&&!location.search.includes('view=settings');if(box.hidden)return;
 box.replaceChildren(el('h2',batch.enabled?'Your batch of 20':'Support-career batches'));
 if(batch.enabled){box.append(el('strong',batch.selected+'/20 selected - '+batch.completed+' completed in this batch'),el('p','AI / cloud / technical support. Target CAD '+Number(batch.minimum_cad).toLocaleString()+' per year. '+(batch.t4Fallback?'Canada: fully remote incorporated contracts first; employee / T4 roles only as a fallback.':'Canada: incorporated contracts only.')));
  if(batch.selected<20)box.append(el('p','Searching for '+(20-batch.selected)+' more verified matches. Automatic matches need verified pay and work-arrangement evidence. Manually added leads remain marked for review.'));
  if(batch.selected&&batch.completed===batch.selected){const next=el('button','Start next batch of 20');next.onclick=async()=>{next.disabled=true;try{await api('/application-batch','POST',{action:'next'});await refresh(true);}catch(e){$('#notice').textContent=e.message;next.disabled=false;}};box.append(next);}
 }
 if(!location.search.includes('view=settings'))return;
 const details=el('details'),form=el('form'),message=el('p');message.setAttribute('role','status');details.append(el('summary','Replace queue and start a fresh batch'));
 const label=el('label','Applicant profile '),select=el('select');select.setAttribute('aria-label','Batch applicant profile');label.append(select);form.append(label);
 const minimum=field(form,'Minimum annual pay target (CAD)');minimum.type='number';minimum.value=batch.minimum_cad||120000;minimum.required=true;
 const degree=field(form,"Master's field of study");degree.value=batch.degree||'';
 form.append(el('p','This archives pending jobs and replaces searches. Completed applications, interviews, answers and duplicate history are retained. The helper fills supported answers; final Submit stays with you.'));
 const reset=el('button','Clear queue and start support batch');form.append(reset,message);details.append(form);box.append(details);
 api('/applicants').then(data=>{for(const p of data.applicants||[]){const o=el('option',p.name);o.value=p.id;select.append(o);}}).catch(e=>message.textContent=e.message);
 form.onsubmit=async e=>{e.preventDefault();reset.disabled=true;try{const result=await api('/application-batch','POST',{action:'reset',applicant_id:select.value,minimum_cad:Number(minimum.value),degree:degree.value});$('#notice').textContent=result.archived+' old pending jobs archived. Application history preserved. New support-career batch started.';await refresh(true);}catch(e){message.textContent=e.message;reset.disabled=false;}};
}
function renderFocusControl(f={}){
 if(activeBatch.enabled){$('#work-focus')?.remove();return;}
 let box=$('#work-focus');if(!box){box=el('section');box.id='work-focus';box.style.cssText='padding:20px;background:#edf6ef;border-radius:12px;margin:16px 0';$('#home-summary').after(box);}
 if(box.contains(document.activeElement))return;box.replaceChildren(el('h2',f.enabled?'One application at a time':'Single-application worker'));
 const message=el('p'),action=el('button',f.enabled&&f.auto_submit?'Pause automatic submission':'Start autonomous application');
 if(f.enabled){const p=f.progress;const progress=el('progress');progress.max=100;if(p?.percent!==null&&p?.percent!==undefined)progress.value=p.percent;progress.style.cssText='width:100%;height:16px';box.append(el('strong',p?.percent!==null&&p?.percent!==undefined?p.percent+'% of current-step required fields filled':'Waiting to measure the employer form'),progress);box.append(el('p',p?p.filled+' / '+p.required+' required fields filled on the current step. '+(f.awaiting?'Submit attempted; waiting for employer confirmation.':'A filled form is not yet a confirmed submission.'):'Progress appears when the worker opens the form.'));message.textContent=f.job_id?f.parked+' other jobs stay in the backlog. The next job starts only after employer confirmation.':'Waiting for an eligible application. New jobs will join automatically.';}
 else message.textContent='Fill and submit one selected application using saved answers and approved facts. Missing facts or verification pause the same application.';
 box.append(message,action);if(f.enabled)box.append(el('small',f.auto_submit?'Automatic submission enabled. The hosted worker prepares new forms while your PC is off; browser takeover may still need you.':'Automatic submission paused. You can continue manually.'));
 action.onclick=async()=>{action.disabled=true;try{await api('/work-focus','PUT',{enabled:true,auto_submit:!(f.enabled&&f.auto_submit)});await refresh(true);}catch(e){message.textContent=e.message;}finally{action.disabled=false;}};
}

function renderArchiveControl(jobs){
 let box=$('#application-archive-control');
 if(!box){
 box=el('section');box.id='application-archive-control';box.style.cssText='padding:20px;margin:16px 0;border:1px solid #74ad91;border-radius:12px';
 box.append(el('h2','Application archive'),el('p','Remove old pending applications from your workspace while retaining their answers, history, and duplicate protection. Submitted and actively running applications are protected.'));
 const review=el('button'),browse=el('button','View archived applications'),panel=el('div'),status=el('p');review.id='review-archive';status.setAttribute('role','status');box.append(review,browse,status,panel);placeWorkspacePanel(box);
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
 let box=$('#career-overview');if(!box){box=el('section');box.id='career-overview';box.style.cssText='padding:24px;margin:16px 0;background:#e9f5ee;border:2px solid #39765c;border-radius:16px';placeWorkspacePanel(box);}
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
 form.append(label,submit);section.append(form,refresh,status,list);placeWorkspacePanel(section);
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
 box.append(el('h2','Application preparation in your browser'));
 const status=el('p','Checking your browser helper…'),check=el('button','Check browser connection'),setup=el('a','Update browser helper (0.6.27)');
 setup.href='/local-browser.html';setup.style.marginLeft='12px';status.setAttribute('role','status');
 box.append(status,check,setup);placeWorkspacePanel(box);
 check.onclick=()=>{
  if(check.disabled)return;check.disabled=true;box.dataset.checkedAt=String(Date.now());const requestId=crypto.randomUUID();
  const finish=(error,data)=>{clearTimeout(timer);window.removeEventListener('message',receive);check.disabled=false;
   browserHelperStatus=error?null:{...data,checkedAt:Date.now()};
   status.textContent=error|| (data?.version!=='0.6.27'?'Browser helper '+data?.version+' is connected. Update to 0.6.27 so supported forms stop at final Submit.':data?.enabled?'Browser helper 0.6.27 connected. New queued applications are prepared automatically; keep this browser and dashboard open.':'Browser helper connected but paused. Open its popup and start routine preparation.')+(data?.error?' '+data.error:'');
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

function preparationStage(job){
 if(!job||['archived','duplicate','submitted','interview','rejected','offer'].includes(job.status)||job.evidence?.confirmed)return null;
 if(job.local_attempt_at||job.evidence?.awaiting||job.evidence?.attempted||['Unconfirmed submission','Submission in progress'].includes(job.challenge))return 'awaiting';
 if(job.employer_hold||!Object.hasOwn(job,'employer_hold')&&job.challenge==='Employer application limit')return 'held';
 if(job.evidence?.active||['running','queued'].includes(job.status))return 'preparing';
 const waiting=['needs_review','paused'].includes(job.status)||job.status==='local_browser'&&job.local_phase==='blocked';
 if(!waiting)return job.evidence?.stalled?'review':null;
 let questions=[];try{questions=JSON.parse(job.required_fields_json||'[]')}catch{}
 const message=job.status==='local_browser'?job.last_message||'':job.blocker_message||'';
 if((job.challenge==='Ready to submit'||/^Ready (?:to submit|for your review)\b/i.test(message))&&Array.isArray(questions)&&!questions.length)return 'ready';
 if(/CAPTCHA|Sign-in|Sensitive action|Upload needs review/i.test(job.challenge||'')||/CAPTCHA|sign.in|verification|MFA|declaration|attest|arbitrat|sensitive|legal|upload/i.test(message))return 'employer';
 if(Array.isArray(questions)&&questions.length)return 'answers';
 return 'review';
}
function renderPreparationSummary(jobs){
 const section=el('section');section.id='preparation-summary';section.setAttribute('aria-label','Application preparation stages');
 section.append(el('h3','Your next steps'),el('p','Prepared forms still need your final Submit click. Only employer receipts count as completed applications.'));
 const metrics=el('div');metrics.className='operation-metrics';
 const stages=[['ready','Ready for Submit','Review the filled employer form and click Submit.'],['answers','Missing answers','Save your truthful answers once; eligible forms can resume.'],['employer','Employer-site step','Complete verification, declarations or an upload in the existing form.'],['held','Employer limit','Wait for the employer limit to clear. Other employers can continue.'],['review','Browser or form check','Review the saved employer tab before continuing.']];
 const seen=new Set(),unique=jobs.filter(j=>j.id&&!seen.has(j.id)&&seen.add(j.id));
 for(const [stage,label,detail]of stages){
  const matches=unique.filter(j=>preparationStage(j)===stage),metric=el('button');metric.type='button';metric.className='operation-metric';metric.dataset.preparation=stage;
  metric.append(el('span',label),el('strong',String(matches.length)),el('small',detail));
  metric.onclick=()=>{currentFilter='prep-'+stage;$('#job-search').value='';for(const b of document.querySelectorAll('[data-filter]'))b.setAttribute('aria-pressed','false');applyFilters();$('#jobs').closest('.list-panel').scrollIntoView?.({behavior:'smooth',block:'start'});};metrics.append(metric);
 }
 section.append(metrics);
 return section;
}

function renderOperations(snapshot,activity,jobs=[]){
 if(!snapshot?.totals)snapshot=null;
 let box=$('#operations');
 if(!box){box=el('section');box.id='operations';box.className='operations';placeWorkspacePanel(box);}
 placeWorkspacePanel(box);
 const signature=JSON.stringify([snapshot?.totals,snapshot?.applications,activity?.events,jobs.map(j=>[j.id,preparationStage(j)])]);
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
 const completed=el('section');completed.id='completion-breakdown';completed.setAttribute('aria-label','Confirmed completions by assistance');
 completed.append(el('h3','Who completed your applications?'),el('p','Only applications with employer receipt evidence count. Preparing your reusable profile does not count as help on each application.'));
 const counts=el('div');counts.className='operation-metrics';
 const groups=[['automatic','Completed automatically','ApplyPilot completed the tracked form without a recorded human step.'],['assisted','Completed with your help','You supplied an application answer, interacted with the form, or recorded its receipt.'],['unknown','Completion method unknown','The receipt is recorded, but the available history cannot establish how the form was completed.']];
 for(const [key,label,detail] of groups){
  const metric=el('button');metric.type='button';metric.className='operation-metric';metric.dataset.completion=key;metric.append(el('span',label),el('strong',String(snapshot.totals[key]||0)),el('small',detail));
  metric.onclick=()=>{currentFilter='completion-'+key;for(const b of document.querySelectorAll('[data-filter]'))b.setAttribute('aria-pressed','false');applyFilters();$('#jobs').closest('.list-panel').scrollIntoView({behavior:'smooth',block:'start'});};counts.append(metric);
 }
 completed.append(counts);
 const grouped=el('details');grouped.append(el('summary','See completed applications in each group'));
 const byId=new Map(jobs.map(j=>[j.id,j]));
 for(const [key,label] of groups){
  const list=el('ul');grouped.append(el('h4',label));
  for(const entry of snapshot.applications||[]){if(entry.completion!==key)continue;const job=byId.get(entry.id);if(!job)continue;const item=el('li'),link=el('a',job.company+' — '+job.title);link.href='#job-'+job.id;link.onclick=()=>{currentFilter='all';$('#job-search').value='';applyFilters();};item.append(link);list.append(item);}
  if(!list.children.length)grouped.append(el('p','No confirmed applications in this group.'));else grouped.append(list);
 }
 completed.append(grouped);box.append(renderPreparationSummary(jobs),completed);
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
 box.append(feed);placeWorkspacePanel(box);
}

function renderContinuationQueue(data){
 let box=$('#continuation-queue');
 if(!data){if(box)box.querySelector('[role=status]').textContent='Continuation status could not be refreshed.';return;}
 const requests=data.requests||[];
 if(!box){box=el('section');box.id='continuation-queue';box.style.cssText='padding:16px;border:1px solid #74ad91;border-radius:12px;margin:16px 0';placeWorkspacePanel(box);}
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
 if(!browserHelperStatus?.enabled||browserHelperStatus.version!=='0.6.27'||Date.now()-browserHelperStatus.checkedAt>45000)return;
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
 let box=$('#ai-status');if(!box){box=el('section');box.id='ai-status';box.className='ai-status';placeWorkspacePanel(box);}
 try{
  const [data,recovery]=await Promise.all([api('/ai-status'),api('/saved-answer-recovery').catch(()=>null)]),signature=JSON.stringify([data,recovery]);if(box.dataset.signature===signature)return;box.dataset.signature=signature;box.replaceChildren(el('h2','AI form assistance'));box.dataset.configured=String(!!data.googleConfigured);box.dataset.facts=String(!!data.geminiFactsConfigured&&(data.profiles||[]).some(p=>p.geminiFactsConsent));
  box.append(el('p',data.googleConfigured?'Gemini key configured · fills supported public questions and approved professional-fact answers; checks paused forms every minute. API errors appear below.':'Gemini is not configured on the server. Saved-answer autofill remains available.'));
  box.append(el('p','Saved profile facts now cover common question wording, including LinkedIn-link prompts. The server prepares supported answers every minute. Connected paused forms pick up newly saved answers every 30 seconds, even when other questions remain unanswered.'));
  if(recovery)box.append(el('p','Saved-answer recovery '+(recovery.enabled?'on':'paused with automatic queueing')+' · '+(recovery.filled||0)+' answers recovered across '+(recovery.applications||0)+' applications. These are preparation counts, not submissions.'));
  box.append(el('p','Gemini can use your approved professional facts and the public employer page. Unknown experience, desired pay, availability and work authorization need your saved answers. You handle verification, declarations and the final Submit click.'));
  for(const p of data.profiles||[])box.append(el('small',p.name+': Google public-page consent '+(p.googleConsent?'enabled':'off')+'. Personal-answer drafting '+(p.geminiFactsConsent&&data.geminiFactsConfigured?'Gemini enabled':p.personalDraftConsent&&data.personalDraftsConfigured?'OpenAI enabled':'inactive')+'. Professional background '+(p.hasBackground?'saved':'not yet saved')+'.'));
  for(const attempt of data.attempts||[])box.append(el('p',attempt.company+' · '+attempt.question+' — '+attempt.message));
  const testRow=el('div'),testButton=el('button','Test Gemini on a public job page'),testResult=el('p');testRow.className='ai-test';testResult.setAttribute('role','status');testButton.type='button';testButton.disabled=!data.googleConfigured;testResult.setAttribute('role','status');testRow.append(testButton,testResult);box.append(testRow);
  testButton.onclick=async()=>{
   testButton.disabled=true;testResult.textContent='Checking Gemini with one saved public job page…';
   try{const result=await api('/ai-test','POST',{});testResult.replaceChildren(el('strong','Gemini test passed · '+result.model),el('p',result.company+' · '+result.title),el('p',result.answer),el('small','Verified '+new Date(result.checkedAt).toLocaleTimeString()+'. This test did not fill or submit an application.'));
    for(const cite of result.citations||[]){const link=el('a','Source: '+cite.title);link.href=cite.url;link.target='_blank';link.rel='noopener noreferrer';testResult.append(link);}
   }catch(error){testResult.textContent='Gemini test failed: '+error.message;}
   finally{testButton.disabled=false;}
  };
  const factsRow=el('div'),factsButton=el('button','Test Gemini with my saved professional facts'),factsResult=el('p');factsRow.className='ai-test';factsButton.type='button';factsButton.disabled=box.dataset.facts!=='true';factsResult.setAttribute('role','status');factsRow.append(factsButton,factsResult);box.append(factsRow);
  factsButton.onclick=async()=>{factsButton.disabled=true;factsResult.textContent='Checking a professional answer against your saved facts…';try{const result=await api('/ai-facts-test','POST',{});factsResult.textContent=(result.answer?'Gemini professional-answer test passed: '+result.answer:result.reason)+' This test did not fill or submit an application.';}catch(error){factsResult.textContent='Gemini test failed: '+error.message;}finally{factsButton.disabled=false;}};
  const setup=el('a','View resume and profile facts →');setup.href='https://marvelous-vitality-production-c2d8.up.railway.app/setup';box.append(setup);
 }catch{box.dataset.configured='unknown';box.replaceChildren(el('h2','AI form assistance'),el('p','AI status could not be verified. Your saved answers remain available.'));}finally{compactAIStatus(box);}
}

function renderPipeline(data){
 let section=$('#application-pipeline');
 if(!section){section=el('section');section.id='application-pipeline';section.className='operations';placeWorkspacePanel(section);}
 if(!data){section.replaceChildren(el('h2','Application pipeline'),el('p','Pipeline status could not be refreshed.'));return;}
 if(section.dataset.busy==='true')return;
 const signature=JSON.stringify(data);if(section.dataset.signature===signature)return;section.dataset.signature=signature;
 section.replaceChildren(el('h2','Application pipeline'),el('p',data.enabled?'Automatic queueing is on. Every found job enters the ranked pipeline; higher-ranked jobs are processed first.':'Automatic queueing of all found jobs is off.'),el('p',data.found+' found jobs waiting to enter the pipeline.'));
 const status=el('p');status.setAttribute('role','status');
 const primary=el('button',data.enabled?'Queue found jobs now':'Queue all found and enable automatic queueing');primary.className='primary';primary.type='button';
 const report=r=>r.queued+' queued · '+r.held+' need attention · '+r.duplicates+' duplicates excluded.';
 primary.onclick=async()=>{primary.disabled=true;section.dataset.busy='true';try{const response=await api(data.enabled?'/pipeline/queue-found':'/pipeline',data.enabled?'POST':'PUT',data.enabled?{}:{enabled:true});const result=response.result||response;$('#notice').textContent=report(result);section.dataset.signature='';section.dataset.busy='false';await refresh(true);}catch(e){status.textContent=e.message;}finally{primary.disabled=false;section.dataset.busy='false';}};
 section.append(primary);
 const language=el('button',data.excludeFrench?'French applications excluded':'Exclude French applications');language.type='button';language.disabled=!!data.excludeFrench;language.onclick=async()=>{language.disabled=true;try{const r=await api('/language-preference','PUT',{excludeFrench:true});$('#notice').textContent='French applications excluded. '+r.archived.length+' active applications archived; history retained.';section.dataset.signature='';await refresh(true);}catch(e){status.textContent=e.message;language.disabled=false;}};section.append(language);
 if(data.enabled){const pause=el('button','Pause automatic queueing');pause.type='button';pause.onclick=async()=>{pause.disabled=true;try{await api('/pipeline','PUT',{enabled:false});section.dataset.signature='';await refresh(true);}catch(e){status.textContent=e.message;pause.disabled=false;}};section.append(pause);}
 section.append(status,el('small','Previously attempted or duplicated applications are never started again automatically. Closed postings and missing details appear under Needs you. Pause affects new queue entries; use the browser helper to stop work already in progress.'));
 placeWorkspacePanel(section);
}

function renderCooldownHistory(jobs=[]){
 let box=$('#cooldown-history');
 if(!box){box=el('details');box.id='cooldown-history';box.className='operations';placeWorkspacePanel(box);}
 const signature=JSON.stringify(jobs);if(box.dataset.signature===signature)return;box.dataset.signature=signature;
 box.replaceChildren(el('summary','Done for now — time limits ('+jobs.length+')'));
 box.append(el('p','These applications are hidden from active work and the extension. Previous attempts and duplicate protection are retained. A time limit is not a successful submission.'));
 for(const job of jobs){
  const row=el('div'),hold=job.cooldown;
  row.append(el('h3',job.company+' — '+job.title),el('p',hold.reason));
  row.append(el('small',hold.until?(hold.estimated?'Estimated review date: ':'Next slot: ')+new Date(hold.until).toLocaleString()+(hold.estimated?'. The employer decides when eligibility resets.':''): 'No reset date is known. Kept on hold until eligibility can be confirmed.'));
  box.append(row);
 }
 box.append(el('small','Applications return to the active list for review when their hold expires. No application is submitted by this change.'));
}

function renderCompanyCareers(card,job){
 if(!job.official_careers||job.employer_hold||['submitted','interview','rejected','offer'].includes(job.status))return;
 let url;try{url=new URL(job.official_careers.url);if(url.protocol!=='https:')return;}catch{return;}
 const wrap=el('div'),link=el('a','Company careers ↗');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';
 wrap.className='company-careers';wrap.append(link,el('small',job.official_careers.note));card.append(wrap);
}

function renderEmployerLimits(data,jobs=[]){
 let box=$('#employer-limits');
 if(!box){box=el('section');box.id='employer-limits';box.className='operations';placeWorkspacePanel(box);}
 if(box.contains(document.activeElement))return;
 const signature=JSON.stringify([data,jobs.map(j=>[j.id,j.company,j.title,j.status])]);if(box.dataset.signature===signature)return;box.dataset.signature=signature;
 box.replaceChildren(el('h2','Employer application limits'));
 if(!data){box.append(el('p','Employer limit status could not be refreshed.'));return;}
 const limits=data.limits||[];
 if(!limits.length)box.append(el('p','No employer application limits reported.'));
 for(const limit of limits){
  box.append(el('h3',limit.company),el('p',limit.message),el('p',limit.hold_until?'Paused through '+new Date(limit.hold_until).toLocaleDateString()+'. This is a conservative hold from when the limit was reported; the employer’s exact reset date is not known.':'Paused until the employer’s application window can be confirmed.'));
 }
 box.append(el('small','Limits apply to the employer and applicant, not every company using the same hiring software. Receipts and previous attempts are preserved; other employers can continue.'));
 const details=el('details');details.append(el('summary','Report an employer application limit'));
 const form=el('form'),label=el('label','Application that showed the employer limit'),select=el('select');select.required=true;select.setAttribute('aria-label','Application that showed the employer limit');
 const placeholder=el('option','Choose an application');placeholder.value='';select.append(placeholder);
 for(const job of jobs.filter(j=>!['submitted','interview','rejected','offer','duplicate','archived'].includes(j.status))){const option=el('option',job.company+' — '+job.title);option.value=job.id;select.append(option);}
 label.append(select);form.append(label);
 const messageLabel=el('label','Employer limit message'),message=el('textarea');message.required=true;message.maxLength=4000;message.setAttribute('aria-label','Employer limit message');messageLabel.append(message);form.append(messageLabel);
 const save=el('button','Pause this employer for its application limit');save.type='submit';const status=el('p');status.setAttribute('role','status');form.append(save,status);
 form.onsubmit=async event=>{event.preventDefault();save.disabled=true;try{const result=await api('/employer-limits','POST',{jobId:select.value,message:message.value});$('#notice').textContent=result.company+': application limit saved. '+result.held+' pending applications paused; other employers can continue.';document.activeElement?.blur();box.dataset.signature='';await refresh(true);}catch(error){status.textContent=error.message;}finally{save.disabled=false;}};
 details.append(form);box.append(details);
}


function placeWorkspacePanel(node){
 if(!node)return;
 const target=$(node.id==='career-overview'?'#interview-panel-body':node.id==='ai-status'?'#ai-status-slot':'#workspace-tools-body')||$('#workspace');
 if(node.parentElement!==target)target.append(node);
}
function needsMyAttention(job){return pendingSubmission(job)&&['ready','answers','employer','review'].includes(preparationStage(job));}
function pendingSubmission(job){
 return !!job&&!job.employer_hold&&job.metadata?.available!==false&&!['archived','duplicate','submitted','interview','rejected','offer'].includes(job.status)&&!job.evidence?.confirmed&&preparationStage(job)!=='awaiting';
}
function selectHomeFilter(filter){
 currentFilter=filter;$('#job-search').value='';
 for(const button of document.querySelectorAll('[data-filter]'))button.setAttribute('aria-pressed',String(button.dataset.filter===filter));
 applyFilters();$('#jobs').closest('.list-panel')?.scrollIntoView?.({behavior:'smooth',block:'start'});
}
function renderHomeSummary(snapshot,jobs,interviews){
 const box=$('#home-summary');if(!box)return;
 const unique=[...new Map(jobs.map(job=>[job.id,job])).values()],totals=snapshot?.totals;
 const rows=[
  ['Completed',totals?totals.completed??totals.confirmed??0:'-','completed','Employer-confirmed applications plus applications you marked completed, counted once'],
  ['Confirmed submissions',totals?totals.confirmed||0:'—','receipt','Employer receipt evidence only'],
  ['Forms filled / attempted',totals?totals.worked||0:'—','worked','Filled forms and attempts are not confirmed submissions'],
  [location.search.includes('view=settings')?'Yet to submit':'Need your attention',unique.filter(location.search.includes('view=settings')?pendingSubmission:needsMyAttention).length,'pending','Forms waiting for your answer, review or final Submit'],
  ['Ready for my Submit',unique.filter(j=>pendingSubmission(j)&&preparationStage(j)==='ready').length,'prep-ready','Filled forms waiting for your final click'],
  ['Awaiting receipt',totals?totals.awaiting||0:'—','awaiting','An attempt was recorded; check the employer receipt before retrying'],
  ['Preparing',unique.filter(j=>!j.local_attempt_at&&(['queued','running'].includes(j.status)||j.status==='local_browser'&&j.local_phase==='ready')).length,'preparing','Queued or currently preparing in the browser'],
  ['Interviews',interviews.length,'interview','Includes interviews from other sources']
 ];
 const signature=JSON.stringify(rows);if(box.dataset.signature!==signature){
  box.dataset.signature=signature;box.replaceChildren();const metrics=el('div');metrics.className='home-metrics';
  for(const [label,value,filter,detail]of rows){
   const button=el(['pending','prep-ready'].includes(filter)?'button':'div');if(button.tagName==='BUTTON')button.type='button';button.className='home-metric';button.dataset.homeFilter=filter;button.title=detail;button.setAttribute('aria-pressed',String(filter===currentFilter));button.append(el('span',label),el('strong',String(value)));
   if(button.tagName==='BUTTON')button.onclick=()=>selectHomeFilter(filter);metrics.append(button);
  }
  const policy=el('p',activeFocus.auto_submit?'The selected application can submit automatically; employer confirmation is required before the next.':'Autofill prepares your application. You review it and click Submit.');policy.className='submit-policy';box.append(metrics,policy);
 }
 $('#home-interview-count').textContent=String(interviews.length);
}
function compactJobCards(){
 for(const card of $('#jobs').children){
  if(card.dataset.compact==='true'||!card.classList.contains('job'))continue;card.dataset.compact='true';
  const heading=card.querySelector('.job-heading');if(!heading)continue;
  const detail=el('details');detail.className='job-details';detail.append(el('summary','Application details'));
  const score=[...heading.querySelectorAll('small')].find(el=>/\/100/.test(el.textContent));
  if(score?.tagName==='SMALL')detail.append(score);
  // Keep salary figures by the title; tuck tier labels and evidence into details.
  const pay=heading.querySelector('.job-pay');if(pay&&pay.querySelector('small'))detail.append(pay.cloneNode(true));
  for(const child of [...card.children]){
   if(child===heading||child.classList.contains('job-actions'))continue;
   if(child.tagName==='P'||child.tagName==='LABEL'||child.tagName==='BUTTON'&&child.textContent==='Delete application permanently')detail.append(child);
  }
  const notes={ready:'Filled — review the employer form and click Submit.',answers:'Your answer is needed above.',employer:activeFocus.auto_submit?'Verification or an employer declaration needs your attention.':'Complete the remaining employer-site step.',held:'Paused by the employer application limit.',awaiting:'Submission attempted. Check for a receipt before retrying.',review:'Open the saved form to check the next step.',preparing:activeFocus.auto_submit?'The worker is preparing this application for automatic submission.':'Autofill in progress - final Submit stays with you.'};
  const note=card.querySelector('.manual-application-link')?'Review the posting and apply on its website. Pay and eligibility still need checking.':notes[card.dataset.preparation];if(note){const p=el('p',note);p.className='job-next-step';heading.after(p);}
  if(detail.children.length>1)card.append(detail);
 }
}
for(const link of document.querySelectorAll('[data-open-panel]'))link.onclick=()=>{const panel=document.getElementById(link.dataset.openPanel);if(panel)panel.open=true;};

function compactAIStatus(box){
 if(box.querySelector(':scope > .ai-details'))return;
 const details=el('details');details.className='ai-details';details.append(el('summary','AI details, recovery & errors'));
 for(const child of [...box.children])if(child.tagName!=='H2'&&!child.classList.contains('ai-test'))details.append(child);
 const brief=el('p',box.dataset.configured==='true'?(box.dataset.facts==='true'?'Gemini active · Saved professional facts + public job answers · You click Submit':'Gemini key configured · Public company and job-page answers'):box.dataset.configured==='unknown'?'AI status unavailable · Saved-answer autofill remains available':'Gemini not configured · Saved-answer autofill remains available');brief.className='ai-brief';
 box.querySelector('h2')?.after(brief);box.append(details);
}

function focusView(){
 const settings=new URLSearchParams(location.search).get('view')==='settings';document.body.dataset.view=settings?'settings':'focus';
 const tools=$('#workspace-tools'),interviews=$('#interview-panel');if(settings){tools.open=true;interviews.open=true;}
 for(const metric of document.querySelectorAll('.home-metric'))if(metric.tagName!=='BUTTON')metric.removeAttribute('aria-pressed');
}
focusView();

// This browser source is appended to the existing authenticated dashboard bundle.
let funnelProfilesLoaded=false,funnelRefreshing=false;
async function refreshFunnel(){
 if(new URLSearchParams(location.search).get('view')!=='funnel')return;
 document.body.dataset.funnel='true';
 const box=$('#job-funnel');box.hidden=false;
 if(funnelRefreshing)return;funnelRefreshing=true;
 try{
  if(!funnelProfilesLoaded){const {applicants}=await api('/applicants');const select=$('#funnel-profile');select.replaceChildren();for(const p of applicants){const option=el('option',p.name);option.value=p.id;select.append(option);}funnelProfilesLoaded=true;}
  const [data,searches,pipeline]=await Promise.all([api('/funnel'),api('/searches'),api('/pipeline')]);
  const counts=$('#funnel-numbers');counts.replaceChildren();
  for(const [name,key] of [['Waiting','pending'],['Checking','checking'],['Sent to preparation','queued'],['Needs link review','review'],['Duplicates skipped','duplicate'],['Excluded / closed','excluded']]){const tile=el('div'),n=(data.totals?.[key]||0)+(key==='excluded'?(data.totals?.closed||0):0);tile.className='home-metric';tile.append(el('span',name),el('strong',String(n)));counts.append(tile);}
  const active=(searches.searches||[]).filter(s=>s.enabled),latest=active.filter(s=>s.last_run).sort((a,b)=>b.last_run.localeCompare(a.last_run))[0],worldwide=active.some(s=>s.instruction.startsWith('Worldwide technology roles:'));
  $('#funnel-discovery-status').textContent=(worldwide?'Worldwide technology discovery is on. ':active.length+' existing search(es) are active. ')+(pipeline.enabled?'Automatic queueing is on. ':'Automatic queueing is off. ')+(latest?'Last checked '+new Date(latest.last_run).toLocaleTimeString()+': '+(latest.last_result?.scanned||0)+' postings, '+(latest.last_result?.added||0)+' new, '+(latest.last_result?.queued||0)+' queued.':'First search is pending.');
  const support=active.some(s=>s.instruction.startsWith('Support career pathway:'));
  $('#funnel-enable-discovery').textContent=support?'Refresh support-career search':worldwide?'Refresh worldwide search':'Enable worldwide technology search';
  if(support){const details=$('#funnel-enable-discovery').closest('details');details.querySelector('summary').textContent='Automatic support-career search';details.querySelector('p').textContent='AI, cloud and technical support, technical account management and implementation consulting. Published pay must reach your CAD target. Fully remote Canadian incorporated / C2C / B2B contracts come first. Employee / T4 roles are used only when your saved search allows fallback and no suitable contracts are available. Workload signals affect ranking.';}
  const errors=active.filter(s=>s.last_error);$('#funnel-source-errors').textContent=errors.length?'Some sources need another check: '+errors.map(s=>s.last_error).join('; '):'';
  const progress=$('#funnel-batches');progress.replaceChildren();for(const batch of data.batches||[]){const checked=batch.counts.filter(c=>!['pending','checking'].includes(c.status)).reduce((n,c)=>n+c.count,0);progress.append(el('p',new Date(batch.created_at).toLocaleString()+' · '+checked+'/'+batch.received+' links checked'+(batch.repeated?' · '+batch.repeated+' repeat links skipped':'')));}
  const list=$('#funnel-items');if(list.querySelector('form[data-editing="true"]'))return;list.replaceChildren();
  for(const item of data.items||[]){const row=el('article'),link=el('a',item.title?item.company+' — '+item.title:item.url);link.href=item.url;link.target='_blank';link.rel='noopener noreferrer';row.append(link,el('small',item.application_status?'Application: '+item.application_status:'Link: '+item.status),el('p',item.message||'Waiting for a background check.'));
   if(['review','closed'].includes(item.status)&&!item.job_id){const retry=el('button','Check link again');retry.onclick=async()=>{retry.hidden=true;try{await api('/funnel/'+item.id+'/retry','POST',{});await refreshFunnel();}catch(error){$('#funnel-notice').textContent=error.message;retry.hidden=false;}};row.append(retry);}
   if(item.status==='review'&&!item.job_id){
    const details=el('details');details.append(el('summary','Load on Applications for manual review'));
    const form=el('form'),title=field(form,'Job title'),company=field(form,'Company'),notes=field(form,'Review notes');title.required=true;company.required=true;title.maxLength=company.maxLength=200;notes.maxLength=2000;title.value=item.title||'';company.value=item.company||'';
    form.oninput=()=>{form.dataset.editing='true';};notes.required=false;
    const add=el('button','Load application');form.append(el('p','Adds this lead to your current batch for manual review. It does not confirm eligibility or enable automatic preparation.'),add);
    form.onsubmit=async event=>{event.preventDefault();add.disabled=true;form.dataset.editing='true';try{const result=await api('/funnel/'+item.id+'/manual','POST',{title:title.value,company:company.value,notes:notes.value});$('#funnel-notice').textContent=result.duplicate?'Previously tracked application retained; no duplicate created.':'Loaded on Applications for manual review.';form.dataset.editing='false';await refreshFunnel();}catch(error){$('#funnel-notice').textContent=error.message;add.disabled=false;}};details.append(form);row.append(details);
   }
   list.append(row);
  }
  $('#funnel-updated').textContent='Updated '+new Date(data.checkedAt).toLocaleTimeString()+' · Checks groups of '+data.batchSize+' every '+data.intervalSeconds+' seconds. Updates automatically.';
 }catch(error){$('#funnel-notice').textContent=error.message;}finally{funnelRefreshing=false;}
}
if($('#funnel-form'))$('#funnel-form').onsubmit=async event=>{
 event.preventDefault();const button=event.submitter||$('#funnel-add'),input=$('#funnel-links'),original=input.value;button.hidden=true;
 try{const result=await api('/funnel','POST',{applicant_id:$('#funnel-profile').value,links:original});if(input.value===original)input.value='';$('#funnel-notice').textContent=result.added+' links saved. '+result.repeated+' duplicates skipped. '+result.rejected+' invalid links excluded.'+(result.reasons?.length?' '+result.reasons.join(' '):'')+' Processing continues on the server.';await refreshFunnel();}
 catch(error){$('#funnel-notice').textContent=error.message;}finally{button.hidden=false;}
};
if($('#funnel-enable-discovery'))$('#funnel-enable-discovery').onclick=async()=>{
 const button=$('#funnel-enable-discovery');button.hidden=true;
 try{await api('/funnel/discovery','POST',{applicant_id:$('#funnel-profile').value});$('#funnel-notice').textContent='Worldwide technology search enabled. Suitable open roles will enter the preparation queue automatically.';await refreshFunnel();}
 catch(error){$('#funnel-notice').textContent=error.message;}finally{button.hidden=false;}
};
