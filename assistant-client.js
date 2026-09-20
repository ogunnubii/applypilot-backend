const $=s=>document.querySelector(s);let token=sessionStorage.getItem('applypilot-token')||'',people=[];
const notice=s=>$('#notice').textContent=s;
async function api(path,method='GET',data){const r=await fetch((location.hostname.endsWith('netlify.app')?'https://marvelous-vitality-production-c2d8.up.railway.app':'')+'/api'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d;}
function voice(id){const R=window.SpeechRecognition||window.webkitSpeechRecognition;if(!R){notice('Use your phone keyboard microphone to dictate into this field.');$('#'+id).focus();return;}const r=new R();r.lang='en-CA';r.onresult=e=>{$('#'+id).value=e.results[0][0].transcript;notice('Review the dictated text before saving or sending.');};r.onerror=e=>notice('Microphone: '+e.error);r.start();notice('Listening…');}
document.addEventListener('click',e=>{if(e.target.dataset.voice)voice(e.target.dataset.voice)});
function profile(){const p=people.find(p=>p.id===$('#applicant').value);$('#profile').replaceChildren();if(!p)return;for(const key of ['name','email','phone','location','focus']){const label=document.createElement('label');label.textContent=key;const input=document.createElement('input');input.id='p-'+key;input.name=key;input.value=p[key]||'';label.append(input);const button=document.createElement('button');button.type='button';button.textContent='Speak '+key;button.dataset.voice=input.id;$('#profile').append(label,button);}const b=document.createElement('button');b.textContent='Save profile';$('#profile').append(b);}
async function status(){
 const [s,j,r,a]=await Promise.all([api('/status'),api('/jobs'),api('/searches'),api('/activity')]);
 $('#status').textContent=(s.workerOnline?'Worker online':'Worker not reporting')+' · Updated '+new Date().toLocaleTimeString()+' · '+s.queue.map(x=>`${x.count} ${x.status}`).join(', ');
 const selected=$('#applicant').value;
 if(!$('#jobs').querySelector('details[open]'))renderJobs(j.jobs.filter(x=>x.applicant_id===selected));
 $('#runs').replaceChildren();
 for(const run of r.searches.filter(x=>x.applicant_id===selected)){
  const row=document.createElement('p'),v=run.last_result;
  row.textContent=run.instruction+' · '+(run.enabled?'Scheduled':'Disabled')+' · '+(run.auto_queue?'Automatic queue ON':'Save for review')+' · '+(v?`${v.scanned} scanned, ${v.matched} matched, ${v.added} added, ${v.queued} queued`:'No completed scan recorded')+(run.last_error?' · '+run.last_error:'');
  $('#runs').append(row);
 }
 $('#activity').replaceChildren();for(const event of a.events.filter(x=>x.applicant_id===selected)){
  const row=document.createElement('p');row.textContent=new Date(event.at).toLocaleString()+' · '+event.title+' · '+event.message;$('#activity').append(row);
 }
}
async function load(){people=(await api('/applicants')).applicants;$('#login').hidden=true;$('#workspace').hidden=false;$('#applicant').replaceChildren();for(const p of people){const o=document.createElement('option');o.value=p.id;o.textContent=p.name;$('#applicant').append(o);}profile();await status();}
$('#applicant').onchange=()=>{profile();status().catch(e=>notice(e.message))};
$('#auth').onsubmit=async e=>{e.preventDefault();try{token=(await api('/login','POST',Object.fromEntries(new FormData(e.target)))).token;sessionStorage.setItem('applypilot-token',token);await load();notice('Signed in');}catch(e){notice(e.message)}};
$('#logout').onclick=()=>{sessionStorage.removeItem('applypilot-token');location.reload()};
$('#search').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{notice('Searching employer boards and feeds… The results will appear here when the scan completes.');const s=await api('/searches','POST',{applicant_id:$('#applicant').value,instruction:$('#instruction').value,boards:$('#boards').value,auto_queue:$('#auto').checked});const r=await api('/searches/'+s.id+'/run','POST',{});notice(`Scanned ${r.scanned}; matched ${r.matched}; saved ${r.added}; queued ${r.queued}. ${r.errors.join('; ')}`);await status();}catch(e){notice(e.message)}finally{b.disabled=false}};
$('#chat').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{$('#reply').textContent=(await api('/chat','POST',{applicant_id:$('#applicant').value,message:$('#message').value})).reply;}catch(e){notice(e.message)}finally{b.disabled=false}};
$('#profile').onsubmit=async e=>{e.preventDefault();try{const p=people.find(p=>p.id===$('#applicant').value),fields=Object.fromEntries(new FormData(e.target));await api('/applicants/'+p.id,'PUT',{...p,...fields,consent:!!p.consent,ai_consent:!!p.ai_consent});Object.assign(p,fields);notice('Profile saved');}catch(e){notice(e.message)}};
if(token)load().catch(e=>notice(e.message));setInterval(()=>{if(token)status().catch(e=>notice(e.message))},15000);

function element(tag,text){const e=document.createElement(tag);if(text)e.textContent=text;return e;}
function inputLabel(form,label,type='text'){const l=element('label',label),i=document.createElement(type==='textarea'?'textarea':'input');if(type!=='textarea')i.type=type;i.required=true;l.append(i);form.append(l);return i;}
function renderJobs(jobs){
 $('#jobs').replaceChildren();
 const submitted=jobs.filter(j=>j.status==='submitted').length;
 $('#jobs').append(element('p',`${submitted} confirmed submitted · ${jobs.length-submitted} remaining records`));
 for(const job of jobs){
  const card=element('article');card.style.cssText='border:1px solid #54647d;border-radius:10px;padding:16px;margin:16px 0';
  card.append(element('h3',job.title+' — '+job.company),element('p','Status: '+job.status+' · Updated '+new Date(job.updated_at).toLocaleString()));
  const blocked=['paused','needs_review'].includes(job.status);
  card.append(element('p',job.confirmation?'Receipt: '+job.confirmation:blocked?(job.blocker_message||job.challenge||job.last_message||'Review required'):(job.last_message||'Saved for review')));
  if(job.challenge==='CAPTCHA'||job.challenge==='Sign-in')card.append(element('p','Open the employer form to complete verification and the application there. Your browser does not share the worker’s session. Afterwards, record the employer confirmation below.'));
  else if(blocked)card.append(element('p','Supply missing text or native dropdown answers below, then retry. Uploads and unfamiliar controls may need completion on the employer form.'));
  const link=element('a','Open employer form');link.href=job.url;link.target='_blank';link.rel='noopener';card.append(link);
  if(['saved','paused','needs_review'].includes(job.status)){
   const details=element('details'),summary=element('summary','Resolve / record submission');details.append(summary);
   const msg=element('p');msg.setAttribute('role','status');details.append(msg);
   const answersForm=element('form');answersForm.append(element('h4','Answer for this application'));
   const q=inputLabel(answersForm,'Exact question label'),a=inputLabel(answersForm,'Your answer','textarea');
   let questions=[];try{questions=JSON.parse(job.required_fields_json||'[]')}catch{}
   if(questions.length){const choices=element('div');choices.append(element('p','Detected required fields — select a question to answer:'));for(const question of questions){const pick=element('button',question);pick.type='button';pick.onclick=()=>{q.value=question;a.focus()};choices.append(pick)}answersForm.prepend(choices);}
   const save=element('button','Save answer');answersForm.append(save);
   answersForm.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{await api('/jobs/'+job.id+'/answers','PUT',{question:q.value,answer:a.value});msg.textContent='Answer saved for this application. Retry when ready.';}catch(e){msg.textContent=e.message}finally{save.disabled=false}};
   details.append(answersForm);const saved=element('div');details.append(saved);details.ontoggle=async()=>{if(!details.open)return;try{const d=await api('/jobs/'+job.id+'/answers');saved.replaceChildren(...Object.entries(d.answers).map(([q,a])=>element('p',q+': '+a)));}catch(e){msg.textContent=e.message}};
   const uncertain=['Unconfirmed submission','Submission in progress'].includes(job.challenge);
   if(!uncertain&&!['CAPTCHA','Sign-in'].includes(job.challenge)){
    const retry=element('button','Queue / retry application');retry.type='button';retry.onclick=async()=>{retry.disabled=true;try{await api('/jobs/'+job.id+'/queue','POST',{});details.open=false;await status();notice('Application queued. Progress refreshes every 15 seconds.');}catch(e){msg.textContent=e.message;retry.disabled=false}};details.append(retry);
   }
   if(job.status==='saved'){
    const lf=element('form'),url=inputLabel(lf,'Direct employer application link','url');lf.append(element('button','Save employer link'));
    lf.onsubmit=async e=>{e.preventDefault();try{await api('/jobs/'+job.id+'/application-link','PUT',{url:url.value});details.open=false;await status();notice('Employer link saved. You can now queue this application.');}catch(e){msg.textContent=e.message}};details.append(lf);
   }
   const receiptForm=element('form');receiptForm.append(element('h4','Already submitted on the employer site?'),element('p','Only record this after seeing an employer confirmation page or email. Opening a form or solving CAPTCHA does not mean submitted.'));
   const receipt=inputLabel(receiptForm,'Confirmation reference or receipt details','textarea');receipt.minLength=8;receipt.maxLength=300;
   const label=element('label'),check=element('input');check.type='checkbox';check.required=true;check.style.width='auto';label.append(check,document.createTextNode(' I received confirmation from the employer.'));receiptForm.append(label,element('button','Record as submitted'));
   receiptForm.onsubmit=async e=>{e.preventDefault();try{await api('/jobs/'+job.id+'/confirm','POST',{receipt:receipt.value});details.open=false;await status();notice('Recorded as submitted with your employer confirmation.');}catch(e){msg.textContent=e.message}};details.append(receiptForm);
   details.append(element('p','Close this panel to resume automatic card refresh. Your typed answers stay in place while it is open.'));card.append(details);
  }
  const history=element('details');history.append(element('summary','Application history'));const log=element('div');history.append(log);
  history.ontoggle=async()=>{if(!history.open)return;try{const d=await api('/jobs/'+job.id+'/events');log.replaceChildren(...d.events.map(e=>element('p',new Date(e.at).toLocaleString()+' · '+e.message)));}catch(e){log.textContent=e.message}};card.append(history);$('#jobs').append(card);
 }
}
