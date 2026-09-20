const $=s=>document.querySelector(s);let token=sessionStorage.getItem('applypilot-token')||'',busy=false,lastSignature='';
const el=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e};
async function api(path,method='GET',data){const r=await fetch((location.hostname.endsWith('netlify.app')?'https://marvelous-vitality-production-c2d8.up.railway.app':'')+'/api'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d}
function field(form,label){const l=el('label',label),i=el('textarea');i.required=true;i.maxLength=4000;l.append(i);form.append(l);return i}
async function refresh(force=false){
 if(busy||activeHandoff)return;
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
  const takeover=el('button',job.handoff_available?'Take over filled application':'Prepare live application');
  takeover.onclick=async()=>{takeover.disabled=true;try{const r=await api('/jobs/'+job.id+'/handoff/open','POST',{});if(r.available)await openHandoff(job);else{$('#notice').textContent='The worker is preparing your live form. It will show Take over when ready. Up to three sessions can stay open.';await refresh(true)}}catch(e){msg.textContent=e.message}finally{takeover.disabled=false}};card.append(takeover);
  if(!human&&!upload&&!job.handoff_available){
   const form=el('form');form.oninput=()=>{form.dataset.dirty='true'};
   const fields=[];
   if(questions.length){for(const question of [...new Set(questions)])fields.push({question,input:field(form,question)})}
   else{const q=field(form,'Question shown on the employer form');q.maxLength=240;fields.push({questionInput:q,input:field(form,'Your answer')})}
   const submit=el('button','Save answers and continue');form.append(submit);
   form.onsubmit=async e=>{e.preventDefault();submit.disabled=true;busy=true;try{const answers=Object.fromEntries(fields.map(f=>[f.question||f.questionInput.value.trim(),f.input.value.trim()]));await api('/jobs/'+job.id+'/continue','POST',{answers});busy=false;await refresh(true);$('#notice').textContent='Answers saved. The worker will retry this application and submit if all requirements are satisfied.'}catch(e){msg.textContent=e.message}finally{busy=false;submit.disabled=false}};card.append(form);
  }
  const link=el('a','Open this application on the employer site');link.href=job.url;link.target='_blank';link.rel='noopener';card.append(link);
  if(human||upload)card.append(el('p',job.challenge==='Unconfirmed submission'?'Check whether the employer received this application before trying again.':'Use Take over to work in the worker’s browser. The separate employer link starts a different browser session.'));
  const done=el('details');done.append(el('summary','I submitted this application'));
  const receiptForm=el('form'),receipt=field(receiptForm,'Employer confirmation reference or message');receipt.minLength=8;receipt.maxLength=300;
  const label=el('label'),check=el('input');check.type='checkbox';check.required=true;check.style.cssText='display:inline;width:auto;margin-right:8px';label.append(check,document.createTextNode('The employer confirmed receipt.'));receiptForm.append(label);
  const confirm=el('button','Confirm submitted');receiptForm.append(confirm);receiptForm.onsubmit=async e=>{e.preventDefault();confirm.disabled=true;busy=true;try{await api('/jobs/'+job.id+'/confirm','POST',{receipt:receipt.value});busy=false;await refresh(true);$('#notice').textContent='Submission recorded. The completed application has left this list.'}catch(e){msg.textContent=e.message}finally{busy=false;confirm.disabled=false}};done.append(receiptForm);card.append(done);$('#jobs').append(card);
 }
}
$('#auth').onsubmit=async e=>{e.preventDefault();try{token=(await api('/login','POST',Object.fromEntries(new FormData(e.target)))).token;sessionStorage.setItem('applypilot-token',token);await refresh(true);$('#notice').textContent=''}catch(e){$('#notice').textContent=e.message}};
$('#logout').onclick=()=>{sessionStorage.removeItem('applypilot-token');location.reload()};
let activeHandoff=null,remoteBusy=false,remoteTimer=null;
if(token)refresh(true).catch(e=>$('#notice').textContent=e.message);
setInterval(()=>{if(token)refresh().catch(e=>$('#notice').textContent=e.message)},15000);

async function openHandoff(job){
 activeHandoff=job.id;
 const panel=el('section');panel.id='live-browser';panel.style.cssText='position:fixed;inset:0;z-index:1000;overflow:auto;margin:0;border-radius:0;padding:12px';
 const info=el('p','Connecting to your application…'),message=el('p');message.setAttribute('role','status');
 panel.append(el('h2',job.title),info,message);
 const image=el('img');image.alt='Live employer application. Tap a field or button to interact.';image.style.cssText='width:100%;max-width:1100px;display:block;border:1px solid #71819a;cursor:crosshair';panel.append(image);
 const controls=el('div');panel.append(controls);
 const textLabel=el('label','Tap a field above, then enter text here');const input=el('input');input.type='password';input.autocomplete='off';input.placeholder='Text is sent directly to the selected field';textLabel.append(input);controls.append(textLabel);
 const send=el('button','Type into selected field');controls.append(send);
 const localButton=(label,handler)=>{const b=el('button',label);b.style.marginRight='8px';b.onclick=handler;controls.append(b);return b};
 function finish(){clearInterval(remoteTimer);remoteTimer=null;activeHandoff=null;panel.remove();refresh(true).catch(e=>$('#notice').textContent=e.message)}
 async function act(action,data={}){
  if(remoteBusy&&action==='view')return;while(remoteBusy)await new Promise(r=>setTimeout(r,100));if(activeHandoff!==job.id)return;remoteBusy=true;
  try{const r=await api('/jobs/'+job.id+'/handoff/'+action,'POST',data);
   if(r.submitted){finish();$('#notice').textContent='Employer confirmed receipt. Application marked submitted.';return}
   if(r.resumed){finish();$('#notice').textContent='The worker is continuing in the same browser with your changes.';return}
   if(r.closed){finish();return}
   if(r.image){image.src='data:image/jpeg;base64,'+r.image;info.textContent=r.host+' · Live session expires '+new Date(r.expiresAt).toLocaleTimeString();message.textContent=''}
  }catch(e){message.textContent=e.message}finally{remoteBusy=false}
 }
 let points=[];const point=e=>{const r=image.getBoundingClientRect();return {x:Math.max(0,Math.min(1100,Math.round((e.clientX-r.left)*1100/r.width))),y:Math.max(0,Math.min(800,Math.round((e.clientY-r.top)*800/r.height)))}};
 image.style.touchAction='none';image.onpointerdown=e=>{points=[point(e)];image.setPointerCapture(e.pointerId)};image.onpointermove=e=>{if(points.length&&points.length<39)points.push(point(e))};image.onpointerup=e=>{if(!points.length)return;const end=point(e),start=points[0];if(Math.hypot(end.x-start.x,end.y-start.y)>8)act('drag',{points:[...points,end]});else act('click',end);points=[]};image.onpointercancel=()=>points=[];
 const fileLabel=el('label','Upload a PDF or DOCX after tapping the employer upload control'),file=el('input');file.type='file';file.accept='.pdf,.docx';fileLabel.append(file);controls.append(fileLabel);
 file.onchange=async()=>{const selected=file.files[0];if(!selected)return;if(selected.size>6*1024*1024){message.textContent='File must be smaller than 6 MB';return}const reader=new FileReader();reader.onload=async()=>{await act('upload',{name:selected.name,base64:reader.result.split(',')[1]});file.value=''};reader.readAsDataURL(selected)};

 send.onclick=async()=>{if(!input.value)return;const value=input.value;input.value='';await act('text',{text:value})};
 for(const [label,key] of [['Next field','Tab'],['Select all','ControlOrMeta+A'],['Backspace','Backspace'],['Enter','Enter'],['Down','ArrowDown'],['Up','ArrowUp'],['Escape','Escape']])localButton(label,()=>act('key',{key}));
 localButton('Scroll down',()=>act('scroll',{y:550}));localButton('Scroll up',()=>act('scroll',{y:-550}));
 localButton('Resume worker',()=>act('resume'));localButton('Close view',finish);localButton('End browser session',()=>act('close'));
 controls.append(el('p','Tap the live image to complete verification or fill fields. Resume worker returns this same form to automation. Close view keeps it open until expiry. Ending the session closes the employer form.'));
 document.body.append(panel);await act('view');if(activeHandoff)remoteTimer=setInterval(()=>{if(document.visibilityState==='visible'&&activeHandoff)act('view')},2500);
}
