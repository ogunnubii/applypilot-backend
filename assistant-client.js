const $=s=>document.querySelector(s);let token=sessionStorage.getItem('applypilot-token')||'',busy=false,lastSignature='';
const el=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e};
async function api(path,method='GET',data){const r=await fetch((location.hostname.endsWith('netlify.app')?'https://marvelous-vitality-production-c2d8.up.railway.app':'')+'/api'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d}
function field(form,label){const l=el('label',label),i=el('textarea');i.required=true;i.maxLength=4000;l.append(i);form.append(l);return i}
async function refresh(force=false){
 if(busy)return;
 const [{jobs},health]=await Promise.all([api('/jobs'),api('/status')]);
 $('#login').hidden=true;$('#workspace').hidden=false;$('#logout').hidden=false;
 const current=jobs.filter(j=>['queued','running','paused','needs_review'].includes(j.status));
 $('#status').textContent=current.length?`${current.length} unfinished applications${health.workerOnline?'':' · Worker unavailable; saved answers are retained'}`:'No applications currently need completion.';
 const signature=JSON.stringify(current);
 if(!force&&(signature===lastSignature||$('#jobs').contains(document.activeElement)||$('#jobs').querySelector('[data-dirty="true"],details[open]')))return;
 lastSignature=signature;$('#jobs').replaceChildren();
 current.sort((a,b)=>(['needs_review','paused','running','queued'].indexOf(a.status)-['needs_review','paused','running','queued'].indexOf(b.status)));
 for(const job of current){
  const card=el('article');card.append(el('h2',job.title),el('small',job.company));
  if(['running','queued'].includes(job.status)){card.append(el('p',job.status==='running'?'Applying with your saved answers…':'Waiting for the worker. No action needed.'));$('#jobs').append(card);continue}
  card.append(el('p',job.blocker_message||job.challenge||'This application needs your input.'));
  const msg=el('p');msg.className='message';msg.setAttribute('role','status');card.append(msg);
  const human=['CAPTCHA','Sign-in','Unconfirmed submission','Submission in progress'].includes(job.challenge);
  let questions=[];try{questions=JSON.parse(job.required_fields_json||'[]')}catch{}
  const upload=job.challenge==='Upload needs review'||/upload|resume.*not found/i.test(job.blocker_message||'');
  if(!human&&!upload){
   const form=el('form');form.oninput=()=>{form.dataset.dirty='true'};
   const fields=[];
   if(questions.length){for(const question of [...new Set(questions)])fields.push({question,input:field(form,question)})}
   else{const q=field(form,'Question shown on the employer form');q.maxLength=240;fields.push({questionInput:q,input:field(form,'Your answer')})}
   const submit=el('button','Save answers and continue');form.append(submit);
   form.onsubmit=async e=>{e.preventDefault();submit.disabled=true;busy=true;try{const answers=Object.fromEntries(fields.map(f=>[f.question||f.questionInput.value.trim(),f.input.value.trim()]));await api('/jobs/'+job.id+'/continue','POST',{answers});busy=false;await refresh(true);$('#notice').textContent='Answers saved. The worker will retry this application and submit if all requirements are satisfied.'}catch(e){msg.textContent=e.message}finally{busy=false;submit.disabled=false}};card.append(form);
  }
  const link=el('a','Open this application on the employer site');link.href=job.url;link.target='_blank';link.rel='noopener';card.append(link);
  if(human||upload)card.append(el('p',job.challenge==='Unconfirmed submission'?'Check whether the employer received this application before trying again.':'Complete this step and submit on the employer site. Verification in your browser does not carry over to the worker.'));
  const done=el('details');done.append(el('summary','I submitted this application'));
  const receiptForm=el('form'),receipt=field(receiptForm,'Employer confirmation reference or message');receipt.minLength=8;receipt.maxLength=300;
  const label=el('label'),check=el('input');check.type='checkbox';check.required=true;check.style.cssText='display:inline;width:auto;margin-right:8px';label.append(check,document.createTextNode('The employer confirmed receipt.'));receiptForm.append(label);
  const confirm=el('button','Confirm submitted');receiptForm.append(confirm);receiptForm.onsubmit=async e=>{e.preventDefault();confirm.disabled=true;busy=true;try{await api('/jobs/'+job.id+'/confirm','POST',{receipt:receipt.value});busy=false;await refresh(true);$('#notice').textContent='Submission recorded. The completed application has left this list.'}catch(e){msg.textContent=e.message}finally{busy=false;confirm.disabled=false}};done.append(receiptForm);card.append(done);$('#jobs').append(card);
 }
}
$('#auth').onsubmit=async e=>{e.preventDefault();try{token=(await api('/login','POST',Object.fromEntries(new FormData(e.target)))).token;sessionStorage.setItem('applypilot-token',token);await refresh(true);$('#notice').textContent=''}catch(e){$('#notice').textContent=e.message}};
$('#logout').onclick=()=>{sessionStorage.removeItem('applypilot-token');location.reload()};
if(token)refresh(true).catch(e=>$('#notice').textContent=e.message);
setInterval(()=>{if(token)refresh().catch(e=>$('#notice').textContent=e.message)},15000);
