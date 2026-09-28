(()=>{
const P=globalThis.ApplyPilotPolicy;
let packet,bar,note,started=false,initialReceipt=false,attempted=false,timer,busy=false,stopped=false,lastStep='',stepAt=0,submitAt=0;
const norm=P.normalize;
const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
const labelText=e=>{if(!e)return '';const c=e.cloneNode(true);c.querySelectorAll('input,select,textarea,button').forEach(n=>n.remove());return c.textContent};
const label=e=>{const ids=(e.getAttribute('aria-labelledby')||'').split(' ').filter(Boolean).map(id=>document.getElementById(id)?.textContent||'').join(' ');return ((e.type==='radio'?e.closest('fieldset')?.querySelector('legend')?.textContent:'')||labelText(e.labels?.[0])||ids||e.getAttribute('aria-label')||e.closest('.application-question')?.querySelector('.application-label')?.textContent||e.placeholder||e.name||e.id||'Required field').trim().slice(0,240)};
async function send(action,data={}){const r=await chrome.runtime.sendMessage({action,...data});if(!r?.ok)throw Error(r?.error||'ApplyPilot connection unavailable');return r.data;}
function bodyText(){return [...document.body.childNodes].filter(e=>e.nodeType===3||e.nodeType===1&&e!==bar&&!e.matches('script,style,noscript,template')&&visible(e)).map(e=>e.nodeType===3?e.textContent:e.innerText||'').join('\n');}
function receipt(){return P.receipt(bodyText());}
function setValue(e,value){const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}
function answer(e){
 const fromLabel=P.knownAnswer(label(e),packet.profile,packet.answers);if(fromLabel!==null)return fromLabel;
 if(P.sensitive(label(e)))return null;
 const token=(e.autocomplete||'').split(' ').pop(),kind={'given-name':'first name','family-name':'last name','name':'full name','email':'email','tel':'phone','address-level2':'city','address-level1':'province','postal-code':'postal code','country-name':'country'}[token];
 return kind?P.knownAnswer(kind,packet.profile,packet.answers):null;
}
const completedCustom=new WeakSet();
let attemptedCustom=new WeakMap();
let fieldErrors=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fillCustom(e,a){
 if(e.getAttribute('role')!=='combobox'||e.getAttribute('aria-disabled')==='true')return false;
 if(e.value?.trim()||completedCustom.has(e)||attemptedCustom.get(e)===String(a))return false;
 attemptedCustom.set(e,String(a));
 e.click();
 if(e.matches('input')&&!e.readOnly)setValue(e,a);
 for(let attempt=0;attempt<20;attempt++){
  await pause(100);
  const ids=(e.getAttribute('aria-controls')||e.getAttribute('aria-owns')||'').split(/\s+/).filter(Boolean);
  const menus=ids.length?ids.map(id=>document.getElementById(id)).filter(Boolean):[...document.querySelectorAll('[role=listbox]')].filter(visible);
  if(menus.length===1){const matches=[...menus[0].querySelectorAll('[role=option]')].filter(o=>visible(o)&&o.getAttribute('aria-disabled')!=='true'&&P.optionMatches(label(e),o.textContent,a,packet.profile));if(matches.length===1){matches[0].click();completedCustom.add(e);return true;}}
 }
 if(e.matches('input'))setValue(e,'');
 e.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));e.blur();return false;
}

function mount(){
 bar=document.createElement('aside');bar.id='applypilot-local-controls';bar.style.cssText='position:fixed;bottom:16px;right:16px;max-width:360px;z-index:2147483647;background:#12253b;color:white;padding:16px;border-radius:12px;box-shadow:0 3px 18px #0008;font:14px system-ui';
 const heading=document.createElement('strong');heading.textContent='ApplyPilot · '+packet.job.title;note=document.createElement('p');note.setAttribute('role','status');
 const refill=document.createElement('button');refill.textContent='Fill saved answers';refill.onclick=async()=>{try{packet=null;attemptedCustom=new WeakMap();await fill();await advance();}catch(e){note.textContent=e.message;}};
 const save=document.createElement('button');save.textContent='Remember an answer';save.onclick=async()=>{
  const question=prompt('Exact question to remember for this applicant:');if(!question)return;
  if(P.sensitive(question)){note.textContent='Complete sensitive statements directly with the employer.';return;}
  const value=prompt('Your truthful answer (reused only for this exact question):');if(value===null||!value.trim())return;
  try{await send('remember',{question,answer:value});packet=null;await fill();note.textContent='Answer saved for this applicant.';}catch(e){note.textContent=e.message;}
 };
 bar.append(heading,note,refill,save);document.body.append(bar);
}
function controls(){return [...document.querySelectorAll('input,select,textarea,[role=combobox],[role=checkbox],[role=radio]')].filter(e=>!bar?.contains(e)&&visible(e)&&!e.disabled&&!e.readOnly);}
function review(){
 const fields=controls(),missing=fields.filter(e=>{
  if(!(e.required||e.getAttribute('aria-required')==='true'))return false;
  if(completedCustom.has(e))return false;
  if(e.type==='radio')return !fields.some(o=>o.type==='radio'&&o.name===e.name&&o.form===e.form&&o.checked);
  if(e.type==='checkbox')return !e.checked;
  if(e.type==='file')return !e.files?.length;
  return !e.value||e.validity&&!e.validity.valid;
 }).map(label);
 const captcha=[...document.querySelectorAll('iframe[src*="captcha"],iframe[title*="challenge" i],.g-recaptcha,.h-captcha,[data-sitekey]')].some(visible);
 const login=fields.some(e=>e.type==='password'||e.autocomplete==='one-time-code'||/\b(verification code|authentication code|one.time code)\b/i.test(label(e)));
 const sensitive=P.sensitive(bodyText())||fields.some(e=>P.sensitive(label(e)));
 const custom=fields.some(e=>e.matches('[role=combobox],[role=checkbox],[role=radio]')&&!completedCustom.has(e)&&!e.matches('select')&&(e.required||e.getAttribute('aria-required')==='true'||!e.matches('input')));
 const errors=[...document.querySelectorAll('[aria-invalid=true],[role=alert]')].filter(visible).filter(e=>e.getAttribute('aria-invalid')==='true'||/required|invalid|error/i.test(e.innerText||''));
 const embedded=[...document.querySelectorAll('iframe')].filter(visible).some(e=>!/captcha|challenge/i.test(e.src)&&e.getBoundingClientRect().height>150);
 return {fields:[...new Set(missing)],reason:fieldErrors.length?'Could not fill: '+fieldErrors.join('; '):captcha?'CAPTCHA requires you':login?'Sign-in or MFA requires you':sensitive?'Sensitive statement, payment or legal attestation requires you':custom?'Custom form control requires review':embedded?'Embedded form requires review':missing.length?'Needs your input: '+[...new Set(missing)].join('; '):errors.length?'Employer validation needs review':''};
}
async function fill(){
 if(!packet)packet=await send('packet');if(!bar)mount();let count=0;fieldErrors=[];
 const fields=controls();
 for(const e of fields){
  try{
  if(e.getAttribute('role')==='combobox'){const a=answer(e);if(a!==null&&await fillCustom(e,a))count++;continue;}
  if(!e.matches('input,select,textarea')||['hidden','password','file','checkbox','submit','button','radio'].includes(e.type)||(e.value?.trim()&&!(e.tagName==='SELECT'&&(e.selectedOptions[0]?.disabled||/^(select|choose)(\b|\.\.\.)/i.test(e.selectedOptions[0]?.textContent.trim()||'')))))continue;
  const a=answer(e);if(a===null||a===undefined||a==='')continue;
  if(e.tagName==='SELECT'){const opts=[...e.options].filter(o=>!o.disabled&&(norm(o.textContent)===norm(a)||o.value===a));if(opts.length!==1)continue;setValue(e,opts[0].value);}else setValue(e,a);count++;
  }catch(error){fieldErrors.push(label(e)+' (field could not accept the saved value)');}
 }
 for(const e of fields.filter(e=>e.type==='checkbox'&&!e.checked)){
  const a=answer(e);if(a!==null&&/^(yes|true)$/i.test(String(a))&&!P.sensitive(label(e))){e.click();count++;}
 }
 const forms=[...document.forms],groups=new Map();
 for(const e of fields.filter(e=>e.type==='radio')){const key=forms.indexOf(e.form)+':'+e.name;if(!e.name)continue;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);}
 for(const group of groups.values()){if(group.some(e=>e.checked))continue;const a=answer(group[0]);if(a===null)continue;const match=group.filter(e=>norm(labelText(e.labels?.[0])||e.value)===norm(a));if(match.length===1){match[0].click();count++;}}
 const files=[...document.querySelectorAll('input[type=file]')].filter(e=>!e.disabled&&!/cover|portfolio/i.test(label(e)+' '+e.name+' '+e.id)&&/resume|cv|curriculum/i.test(label(e)+' '+e.name+' '+e.id));
 if(files.length===1&&!files[0].files.length){const r=packet.resume,bytes=Uint8Array.from(atob(r.base64),c=>c.charCodeAt(0)),dt=new DataTransfer();dt.items.add(new File([bytes],r.name,{type:r.name.endsWith('.pdf')?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));files[0].files=dt.files;files[0].dispatchEvent(new Event('input',{bubbles:true}));files[0].dispatchEvent(new Event('change',{bubbles:true}));count++;}
 note.textContent=count+' saved fields filled.';return count;
}
async function report(reason,fields=[],blocked=true){note.textContent=reason;if(blocked&&!attempted){stopped=true;clearInterval(timer);}await send('progress',{fields,message:reason,blocked});}
function signature(){return location.href+'|'+controls().map(e=>label(e)+':'+e.type).join('|')+'|'+buttons().map(e=>e.innerText||e.value).join('|');}
function buttons(){return [...document.querySelectorAll('button,input[type=submit],[role=button]')].filter(e=>!bar?.contains(e)&&visible(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true');}
const buttonName=e=>(e.innerText||e.value||e.getAttribute('aria-label')||'').trim();
async function advance(){
 const state=await send('state');attempted=attempted||state.attempted;
 const text=receipt();
 if(text&&!initialReceipt&&attempted){await send('receipt',{receipt:text});note.textContent='Employer receipt verified. Application submitted.';stopped=true;clearInterval(timer);return;}
 if(attempted){if(!submitAt)submitAt=Date.now();if(Date.now()-submitAt>30000)await report('Submission uncertain. Check the employer receipt before retrying.');return;}
 const check=review();
 if(!state.automatic){note.textContent=check.reason||'Saved details filled. Review and submit on the employer page.';await report(note.textContent,check.fields,!!check.reason);if(!attempted){stopped=true;clearInterval(timer);}return;}
 if(check.reason)return report(check.reason,check.fields);
 if(initialReceipt)return report('An existing receipt is visible. Verify this application manually.');
 const signatureNow=signature();
 if(lastStep===signatureNow){if(Date.now()-stepAt>15000)await report('This step did not advance. Check employer validation.');return;}
 const bs=buttons(),submit=bs.filter(e=>/^(submit(?: application)?|send application|send my application)$/i.test(buttonName(e))),next=bs.filter(e=>/^(next|continue|save and continue|review application)$/i.test(buttonName(e)));
 if(submit.length===1&&next.length===0){
  if(!controls().length&&!document.querySelector('form'))return report('Cannot identify the final application form.');
  // Fetch fresh consent/profile and save intent on both server and PC before clicking.
  await send('packet');const before=bodyText();await send('attempt',{before});attempted=true;submitAt=Date.now();const finalCheck=review();if(finalCheck.reason)return report('Form changed before submission. '+finalCheck.reason,finalCheck.fields);submit[0].click();return;
 }
 if(next.length===1&&submit.length===0){
  if(!controls().length)return report('Cannot identify fields for this step.');
  await send('step');lastStep=signatureNow;stepAt=Date.now();next[0].click();return;
 }
 const apply=bs.filter(e=>/^(apply|apply now|apply for this job)$/i.test(buttonName(e)));
 if(!controls().length&&apply.length===1&&lastStep===''){await send('step');lastStep=signatureNow;stepAt=Date.now();apply[0].click();return;}
 await report('Application action is unfamiliar or ambiguous. Continue manually.');
}
async function monitor(){if(!started||busy||stopped)return;busy=true;try{if(!attempted)await fill();await advance();}catch(e){stopped=true;clearInterval(timer);if(note)note.textContent='Connection or form error: '+e.message;await send('progress',{fields:[],message:e.message,blocked:true}).catch(()=>{});}finally{busy=false;}}
async function begin(){try{packet=await send('packet');attempted=!!packet.job.attempted||(await send('state')).attempted;initialReceipt=!!receipt()&&!attempted;started=true;await fill();await advance();timer=setInterval(monitor,2500);}catch(e){if(packet){if(!bar)mount();note.textContent=e.message;await send('progress',{fields:[],message:e.message,blocked:true}).catch(()=>{});}/* Unlinked tabs remain untouched. */}}
document.addEventListener('click',e=>{
 const b=e.target.closest('button,input[type=submit],[role=button]');if(!started||!e.isTrusted||!b||bar?.contains(b))return;
 if(/^(submit(?: application)?|send application|send my application)$/i.test(buttonName(b))&&!attempted){attempted=true;submitAt=Date.now();stopped=false;clearInterval(timer);timer=setInterval(monitor,2500);send('attempt',{before:bodyText(),human:true}).catch(err=>{note.textContent='Sync unavailable: '+err.message+'. Record the employer receipt in the dashboard.';});}
},true);
document.addEventListener('submit',e=>{if(started&&e.isTrusted&&!attempted&&buttons().some(b=>/^(submit(?: application)?|send application)$/i.test(buttonName(b)))){attempted=true;submitAt=Date.now();send('attempt',{before:bodyText(),human:true}).catch(()=>{});}},true);
chrome.runtime.onMessage.addListener((m,sender,reply)=>{if(m.action==='fill'){fill().then(()=>reply({ok:true})).catch(e=>reply({error:e.message}));return true;}});
begin();
})();
