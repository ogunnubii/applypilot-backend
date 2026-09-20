(()=>{
let packet,bar,note,started=false,initialReceipt=false,attempted=false,lastProgress='',timer;
const norm=s=>String(s||'').toLowerCase().replace(/[*✱]/g,'').replace(/\s+/g,' ').trim();
const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
const labelText=e=>{if(!e)return '';const c=e.cloneNode(true);c.querySelectorAll('input,select,textarea,button').forEach(n=>n.remove());return c.textContent};
const label=e=>{const ids=(e.getAttribute('aria-labelledby')||'').split(' ').filter(Boolean).map(id=>document.getElementById(id)?.textContent||'').join(' ');return (e.closest('fieldset')?.querySelector('legend')?.textContent||labelText(e.labels?.[0])||ids||e.getAttribute('aria-label')||e.closest('.application-question')?.querySelector('.application-label')?.textContent||e.placeholder||e.name||e.id||'Required field').trim().slice(0,240)};
async function send(action,data={}){const r=await chrome.runtime.sendMessage({action,...data});if(!r?.ok)throw Error(r?.error||'ApplyPilot connection unavailable');return r.data;}
function receipt(){return (document.body.innerText.match(/(?:your )?application (?:has been |was )?(?:successfully )?(?:submitted|received)[^\n]{0,100}|thank(?:s| you) for applying[^\n]{0,100}/i)||[])[0]||'';}
function setValue(e,value){const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}
function answer(e){const q=norm(label(e)),exact=Object.entries(packet.answers).filter(([k])=>norm(k)===q);if(exact.length===1)return String(exact[0][1]);const p=packet.profile;
 if(/^(full name|name|your name)$/.test(q))return p.name;
 if(/^(first name|given name)$/.test(q))return p.name.split(' ')[0];
 if(/^(last name|family name|surname)$/.test(q))return p.name.split(' ').slice(1).join(' ');
 if(/^(email|email address|your email)$/.test(q)||e.type==='email')return p.email;
 if(/^(phone|phone number|telephone|mobile phone)$/.test(q)||e.type==='tel')return p.phone;
 if(/^(location|current location)$/.test(q))return p.location;
 return null;
}
function mount(){bar=document.createElement('aside');bar.id='applypilot-local-controls';bar.style.cssText='position:fixed;bottom:16px;right:16px;max-width:360px;z-index:2147483647;background:#12253b;color:white;padding:16px;border-radius:12px;box-shadow:0 3px 18px #0008;font:14px system-ui';const heading=document.createElement('strong');heading.textContent='ApplyPilot · '+packet.job.title;note=document.createElement('p');note.setAttribute('role','status');const refill=document.createElement('button');refill.textContent='Fill this step';refill.onclick=()=>fill().catch(e=>note.textContent=e.message);bar.append(heading,note,refill);document.body.append(bar);}
async function fill(){
 if(!packet)packet=await send('packet');if(!bar)mount();let count=0;
 const controls=[...document.querySelectorAll('input,select,textarea')].filter(e=>!bar.contains(e)&&visible(e)&&!e.disabled&&!e.readOnly);
 for(const e of controls){if(['hidden','password','file','checkbox','submit','button','radio'].includes(e.type)||e.value?.trim())continue;const a=answer(e);if(a===null||a===undefined||a==='')continue;if(e.tagName==='SELECT'){const opts=[...e.options].filter(o=>norm(o.textContent)===norm(a)||o.value===a);if(opts.length!==1)continue;setValue(e,opts[0].value)}else setValue(e,a);count++;}
 const groups=new Map();for(const e of controls.filter(e=>e.type==='radio')){const key=e.name||label(e);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);}for(const group of groups.values()){if(group.some(e=>e.checked))continue;const a=answer(group[0]);if(!a)continue;const match=group.filter(e=>norm(e.labels?.[0]?.textContent||e.value)===norm(a));if(match.length===1){match[0].click();count++;}}
 const files=[...document.querySelectorAll('input[type=file]')].filter(e=>!e.disabled&&!/cover|portfolio/i.test(label(e)+' '+e.name+' '+e.id)&&/resume|cv|curriculum/i.test(label(e)+' '+e.name+' '+e.id));
 if(files.length===1&&!files[0].files.length){try{const r=packet.resume,bytes=Uint8Array.from(atob(r.base64),c=>c.charCodeAt(0)),dt=new DataTransfer();dt.items.add(new File([bytes],r.name,{type:r.name.endsWith('.pdf')?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));files[0].files=dt.files;files[0].dispatchEvent(new Event('change',{bubbles:true}));count++;}catch{}}
 await progress(count);
}
async function progress(count){const fields=[...document.querySelectorAll('input,select,textarea')].filter(e=>!bar?.contains(e)&&visible(e)&&!e.disabled&&(e.required||e.getAttribute('aria-required')==='true')&&!e.validity.valid).map(label);const unique=[...new Set(fields)];const message=unique.length?'Needs your input: '+unique.join('; '):'Saved details filled. Review this step, complete verification if shown, and submit on the employer page.';if(note)note.textContent=(count===undefined?'':count+' fields filled. ')+message;if(message!==lastProgress){await send('progress',{fields:unique,message});lastProgress=message;}}
async function monitor(){if(!started)return;try{const text=receipt();if(text&&!initialReceipt&&(attempted||(await send('state')).attempted)){await send('receipt',{receipt:text});note.textContent='Employer receipt detected. ApplyPilot marked this application submitted.';clearInterval(timer);return;}await progress();}catch(e){if(note)note.textContent=e.message}}
async function begin(){try{packet=await send('packet');attempted=(await send('state')).attempted;initialReceipt=!!receipt()&&!attempted;started=true;await fill();timer=setInterval(monitor,5000);}catch{/* Unlinked employer tabs are left untouched. */}}
document.addEventListener('click',e=>{const b=e.target.closest('button,input[type=submit]');if(!started||!e.isTrusted||!b||bar?.contains(b))return;if(/^(submit(?: application)?|send application|apply now)$/i.test((b.innerText||b.value||'').trim())){attempted=true;send('attempt').catch(()=>{});}},true);
document.addEventListener('submit',e=>{if(started&&e.isTrusted){attempted=true;send('attempt').catch(()=>{});}},true);
chrome.runtime.onMessage.addListener((m,sender,reply)=>{if(m.action==='fill'){fill().then(()=>reply({ok:true})).catch(e=>reply({error:e.message}));return true;}});
begin();
})();