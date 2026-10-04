(()=>{
const P=globalThis.ApplyPilotPolicy;
if(globalThis.__applypilotAgentLoaded)return;globalThis.__applypilotAgentLoaded=true;
let packet,bar,note,started=false,initialReceipt=false,attempted=false,timer,busy=false,stopped=false,lastStep='',stepAt=0,submitAt=0,pageWaitAt=Date.now();
const aiTried=new Map(),aiIssues=new Map();
let assistanceSent=false,submissionRecording=false,replayingSubmission=false;
const norm=P.normalize;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const visible=e=>!!e?.isConnected&&!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
const compact=value=>String(value||'').replace(/\s+/g,' ').trim();
const protectedQuestion=value=>P.sensitive(value)||/\b(?:date of birth|birth date|dob|age|race|ethnic(?:ity| origin)?|gender|sex(?:ual)?|sexual orientation|disabilit(?:y|ies)|veteran|religion|marital status|nationality|medical|health condition)\b/i.test(String(value));
const isRequired=e=>!!(e?.required||e?.getAttribute?.('aria-required')==='true'||e?.closest?.('[role="radiogroup"][aria-required="true"],[role="group"][aria-required="true"]'));
const isChecked=e=>e?.checked===true||e?.getAttribute?.('aria-checked')==='true'||e?.getAttribute?.('aria-selected')==='true';
const controlRole=e=>e?.getAttribute?.('role')||'';
const labelText=e=>{if(!e)return '';const c=e.cloneNode(true);c.querySelectorAll('input,select,textarea,button,script,style,[role="option"],[role="radio"],[role="checkbox"],[role="combobox"],[role="button"]').forEach(n=>n.remove());return compact(c.textContent);};
function referencedText(e,attribute){return compact((e.getAttribute(attribute)||'').split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)?.textContent||'').join(' '));}
function questionContainer(e){return e.closest?.('[data-automation-id*="formField"],[data-automation-id*="question"],.application-question,[class*="application-question"],[class*="form-field"],[class*="formField"],[role="radiogroup"],[role="group"],fieldset');}
function normalizeDescriptor(value){return norm(value).replace(/\b(?:optional|required)\b/g,'').replace(/\s+/g,' ').trim();}
function descriptors(e,metadata=true){
 const values=[],add=value=>{value=compact(value);if(value&&normalizeDescriptor(value)!=='required field'&&!values.some(v=>normalizeDescriptor(v)===normalizeDescriptor(value)))values.push(value);};
 const group=e.closest?.('fieldset,[role="radiogroup"],[role="group"]');
 if(e.type==='radio'||controlRole(e)==='radio'){add(group?.querySelector?.(':scope > legend')?.textContent);add(group&&referencedText(group,'aria-labelledby'));add(group?.getAttribute?.('aria-label'));}
 add(labelText(e.labels?.[0]||e.closest?.('label')));add(referencedText(e,'aria-labelledby'));add(e.getAttribute?.('aria-label'));
 const container=questionContainer(e);add(container?.querySelector?.('.application-label,[data-automation-id*="label"],[class*="question-label"],[class*="field-label"]')?.textContent);
 if(!values.length)add(labelText(container));if(!values.length)add(referencedText(e,'aria-describedby'));if(metadata){add(e.placeholder);add(e.name);add(e.id);}
 return values.length?values:['Required field'];
}
const label=e=>descriptors(e)[0].slice(0,240);
async function send(action,data={}){const r=await chrome.runtime.sendMessage({action,...data});if(!r?.ok)throw Error(r?.error||'ApplyPilot connection unavailable');return r.data;}
async function recordAssistance(){if(!started||assistanceSent)return;try{await send('assistance');assistanceSent=true;}catch{/* The boundary remains unknown if tracking cannot sync. */}}
function bodyText(){return [...document.body.childNodes].filter(e=>e.nodeType===3||e.nodeType===1&&e!==bar&&!e.matches('script,style,noscript,template')&&visible(e)).map(e=>e.nodeType===3?e.textContent:e.innerText||'').join('\n');}
function siteIssue(){return P.employerPageIssue({title:document.title,text:bodyText(),hasForm:controls().length>0||!!document.querySelector('form')});}
function receipt(){return P.receipt(bodyText());}
function setValue(e,value){
 if(e.matches?.('[contenteditable="true"]')){e.textContent=String(value);e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:String(value)}));e.dispatchEvent(new Event('change',{bubbles:true}));return;}
 const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;
 Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));
}
function answer(e){
 const allQuestions=descriptors(e);if(allQuestions.some(protectedQuestion))return null;
 const visibleQuestions=descriptors(e,false).filter(q=>q!=='Required field');
 // Prefer the employer's actual question. Generic ids such as "name" must
 // not turn First name into a conflicting Full name answer.
 const questions=visibleQuestions.length?visibleQuestions:allQuestions;
 // A generic id/name must not override conflicting saved aliases from the
 // visible question (for example, City=Toronto and Current city=Ottawa).
 const kinds=[...new Set(questions.map(P.fieldKind).filter(Boolean))];
 for(const kind of kinds){const values=[...new Set(Object.keys(packet.answers||{}).filter(q=>P.fieldKind(q)===kind&&!protectedQuestion(q)).map(q=>String(packet.answers[q]).trim()).filter(Boolean))];if(values.length>1)return null;}
 const answers=[...new Set(questions.map(q=>P.knownAnswer(q,packet.profile,packet.answers)).filter(v=>v!==null&&v!==undefined&&String(v)!=='').map(String))];
 if(answers.length===1)return answers[0];if(answers.length>1)return null;
 const token=(e.autocomplete||'').split(' ').pop(),kind={'given-name':'first name','family-name':'last name','name':'full name','email':'email','tel':'phone','address-level2':'city','address-level1':'province','postal-code':'postal code','country-name':'country'}[token];
 return kind?P.knownAnswer(kind,packet.profile,packet.answers):null;
}

const completedCustom=new WeakMap();
let attemptedCustom=new WeakMap(),fieldErrors=[];
function customValue(e){
 const container=e.closest('[class*="select__control"]')||e.closest('[role="combobox"]')||e.parentElement?.parentElement;
 const selected=container?.querySelector('[class*="single-value"],[class*="singleValue"],[data-value],[aria-selected="true"]');
 const text=compact(selected?.textContent||e.getAttribute('aria-valuetext')||((e.getAttribute('aria-expanded')!=='true'&&e.matches('input'))?e.value:'')||(!e.matches('input')?labelText(e):''));
 return /^(select|choose)(\b|\.\.\.)/i.test(text)?'':text;
}
function customComplete(e){
 if(controlRole(e)!=='combobox')return false;const selected=customValue(e),saved=completedCustom.get(e);
 if(saved!==undefined)return !!selected&&P.optionMatches(label(e),selected,saved,packet.profile);return !!selected;
}
function optionNodes(e){
 const ids=(e.getAttribute('aria-controls')||e.getAttribute('aria-owns')||'').split(/\s+/).filter(Boolean);
 const controlled=ids.flatMap(id=>[...(document.getElementById(id)?.querySelectorAll('[role="option"]')||[])]);
 const candidates=controlled.length?controlled:[...document.querySelectorAll('[role="listbox"] [role="option"],body > [role="option"],[role="option"]')];
 return [...new Set(candidates)].filter(o=>!bar?.contains(o)&&visible(o)&&o.getAttribute('aria-disabled')!=='true');
}
async function fillCombobox(e,a){
 if(customComplete(e))return false;if(e.matches('input')&&e.value?.trim()&&e.getAttribute('aria-expanded')!=='true')return false;
 if(attemptedCustom.get(e)===String(a))return false;attemptedCustom.set(e,String(a));e.focus();e.click();
 for(let retry=0;retry<12;retry++){
  const matches=optionNodes(e).filter(o=>P.optionMatches(label(e),o.textContent||o.getAttribute('aria-label'),a,packet.profile));if(matches.length>1)return false;
  if(matches.length===1){matches[0].click();for(let verify=0;verify<10;verify++){if(P.optionMatches(label(e),customValue(e),a,packet.profile)){completedCustom.set(e,String(a));return true;}await pause(50);}return false;}
  if(retry===1&&e.matches('input')&&!e.readOnly)setValue(e,a);await pause(75);
 }
 return false;
}
async function fillRoleCheckbox(e,a){
 if(isChecked(e)||protectedQuestion(label(e))||!/^(yes|true)$/i.test(String(a)))return false;e.click();for(let i=0;i<8;i++){if(isChecked(e))return true;await pause(40);}return false;
}
function roleRadioGroup(e){const root=e.closest('[role="radiogroup"],[role="group"],fieldset')||e.parentElement;return [...(root?.querySelectorAll('[role="radio"]')||[e])].filter(visible);}
const optionText=e=>compact(e.getAttribute('aria-label')||referencedText(e,'aria-labelledby')||labelText(e.closest('label'))||e.textContent||e.value);
async function fillRoleRadios(fields){
 let count=0;const seen=new Set();
 for(const e of fields.filter(e=>controlRole(e)==='radio')){
  const group=roleRadioGroup(e),root=group[0]?.closest('[role="radiogroup"],[role="group"],fieldset')||group[0]?.parentElement;if(seen.has(root))continue;seen.add(root);
  if(group.some(isChecked))continue;const a=answer(group[0]);if(a===null)continue;const matches=group.filter(o=>P.optionMatches(label(group[0]),optionText(o),a,packet.profile));if(matches.length!==1)continue;
  matches[0].click();for(let i=0;i<8&&!isChecked(matches[0]);i++)await pause(40);if(isChecked(matches[0]))count++;
 }
 return count;
}

async function updateAttentionPosition(){
 if(!bar||!packet?.job?.id)return;let counter=bar.querySelector('.attention-position');if(!counter){counter=document.createElement('div');counter.className='attention-position';counter.style.cssText='font-weight:750;font-size:17px;margin-bottom:8px';counter.setAttribute('role','status');bar.prepend(counter);}
 try{const data=await send('attention-position');counter.hidden=!data.position;if(data.position)counter.textContent=data.position+'/'+data.total+' · Needs your input';}catch{counter.hidden=true;}
}
function mount(){
 document.getElementById('applypilot-local-controls')?.remove();bar=document.createElement('aside');bar.id='applypilot-local-controls';bar.style.cssText='position:fixed;bottom:16px;right:16px;max-width:360px;z-index:2147483647;background:#12253b;color:white;padding:16px;border-radius:12px;box-shadow:0 3px 18px #0008;font:14px system-ui';
 const heading=document.createElement('strong');heading.textContent='ApplyPilot · '+packet.job.title;note=document.createElement('p');note.setAttribute('role','status');
 const refill=document.createElement('button');refill.textContent='Fill available answers';refill.onclick=async()=>{try{await recordAssistance();await resumeFill();}catch(e){note.textContent=e.message;}};
 const save=document.createElement('button');save.textContent='Remember an answer';save.onclick=async()=>{await recordAssistance();const question=prompt('Exact question to remember for this applicant:');if(!question)return;if(protectedQuestion(question)){note.textContent='Complete sensitive statements directly with the employer.';return;}const value=prompt('Your truthful answer (reused only for this exact question):');if(value===null||!value.trim())return;try{await send('remember',{question,answer:value});packet=null;await fill();note.textContent='Answer saved for this applicant.';}catch(e){note.textContent=e.message;}};
 const capture=document.createElement('button');capture.textContent='Save form answers to library';capture.onclick=async()=>{capture.disabled=true;try{await recordAssistance();const r=await send('capture',{fields:formAnswers()});note.textContent=r.saved+' answers saved. Review them in the dashboard Answer library. Nothing was submitted.';}catch(e){note.textContent='Could not save answers: '+e.message;}finally{capture.disabled=false;}};
 bar.append(heading,note,refill,save,capture);document.body.append(bar);updateAttentionPosition();
}
function controls(){return [...document.querySelectorAll('input,select,textarea,[contenteditable="true"],[role="combobox"],[role="checkbox"],[role="radio"]')].filter(e=>!bar?.contains(e)&&visible(e)&&!e.disabled&&!e.readOnly);}
function formAnswers(){
 const rows=[];for(const e of controls()){
  const q=label(e),role=controlRole(e);if(protectedQuestion(q)||/password|one.?time|verification code|captcha/i.test(q)||['password','file','hidden','submit','button'].includes(e.type))continue;
  let value='';if(role==='combobox'){if(!customComplete(e))continue;value=customValue(e);}else if(role==='radio'||e.type==='radio'){if(!isChecked(e))continue;value=optionText(e);}else if(role==='checkbox'||e.type==='checkbox'){if(!isChecked(e))continue;value='Yes';}else if(e.tagName==='SELECT'){if(!e.value||e.selectedOptions[0]?.disabled)continue;value=e.selectedOptions[0]?.textContent;}else value=e.matches?.('[contenteditable="true"]')?e.textContent:e.value;
  if(typeof value==='string'&&value.trim())rows.push({question:q,answer:value.trim().slice(0,4000)});
 }return rows.slice(0,120);
}
function controlComplete(e,fields){
 const role=controlRole(e);if(role==='combobox')return customComplete(e);if(role==='checkbox'||e.type==='checkbox')return isChecked(e);if(role==='radio')return roleRadioGroup(e).some(isChecked);if(e.type==='radio')return fields.some(o=>o.type==='radio'&&o.name===e.name&&o.form===e.form&&o.checked);
 if(e.type==='file')return !!e.files?.length;if(e.matches?.('[contenteditable="true"]'))return !!compact(e.textContent);return !!e.value&&!(e.validity&&!e.validity.valid);
}
function review(){
 const fields=controls(),required=fields.filter(isRequired),captcha=[...document.querySelectorAll('iframe[src*="captcha"],iframe[title*="challenge" i],.g-recaptcha,.h-captcha,[data-sitekey]')].some(visible);
 const login=fields.some(e=>e.type==='password'||e.autocomplete==='one-time-code'||/\b(verification code|authentication code|one.time code)\b/i.test(label(e)));
 const sensitive=required.some(e=>descriptors(e).some(protectedQuestion)),custom=required.some(e=>['combobox','checkbox','radio'].includes(controlRole(e))&&!controlComplete(e,fields));
 const missing=[...new Set(required.filter(e=>!controlComplete(e,fields)).map(label))];
 const errors=[...document.querySelectorAll('[aria-invalid="true"],[role="alert"]')].filter(visible).filter(e=>e.getAttribute('aria-invalid')==='true'||/required|invalid|error/i.test(e.innerText||''));
 const embedded=[...document.querySelectorAll('iframe')].filter(visible).some(e=>!/captcha|challenge/i.test(e.src)&&e.getBoundingClientRect().height>150);
 return {fields:missing,reason:fieldErrors.length?'Could not fill: '+fieldErrors.join('; '):captcha?'CAPTCHA requires you':login?'Sign-in or MFA requires you':sensitive?'Sensitive, legal, or demographic response requires you':custom?'Required custom form control requires review':embedded?'Embedded form requires review':missing.length?'Needs your input: '+missing.join('; '):errors.length?'Employer validation needs review':''};
}
async function fillPass(){
 if(!packet)packet=await send('packet');if(!bar)mount();let count=0;fieldErrors=[];if(siteIssue())return 0;const fields=controls();if(fields.length||document.querySelector('form'))await send('form-opened');
 for(const e of fields){
  try{
   const role=controlRole(e),a=answer(e);if(role==='combobox'){if(a!==null&&await fillCombobox(e,a))count++;continue;}if(role==='checkbox'){if(a!==null&&await fillRoleCheckbox(e,a))count++;continue;}if(role==='radio')continue;
   if(e.tagName==='SELECT'&&e.multiple)continue;if(!e.matches('input,select,textarea,[contenteditable="true"]')||['hidden','password','file','checkbox','submit','button','radio','reset','image'].includes(e.type)||(compact(e.matches('[contenteditable="true"]')?e.textContent:e.value)&&!(e.tagName==='SELECT'&&(e.selectedOptions[0]?.disabled||/^(select|choose)(\b|\.\.\.)/i.test(compact(e.selectedOptions[0]?.textContent))))))continue;
   if(a===null||a===undefined||a==='')continue;if(e.tagName==='SELECT'){const opts=[...e.options].filter(o=>!o.disabled&&P.optionMatches(label(e),o.textContent,a,packet.profile));if(opts.length!==1)continue;setValue(e,opts[0].value);}else setValue(e,a);count++;
  }catch{if(isRequired(e))fieldErrors.push(label(e)+' (field could not accept the saved value)');}
 }
 for(const e of fields.filter(e=>e.type==='checkbox'&&!e.checked)){const a=answer(e);if(a!==null&&/^(yes|true)$/i.test(String(a))&&!protectedQuestion(label(e))){e.click();if(e.checked)count++;}}
 const forms=[...document.forms],groups=new Map();for(const e of fields.filter(e=>e.type==='radio')){const key=forms.indexOf(e.form)+':'+e.name;if(!e.name)continue;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);}
 for(const group of groups.values()){if(group.some(e=>e.checked))continue;const a=answer(group[0]);if(a===null)continue;const match=group.filter(e=>P.optionMatches(label(group[0]),optionText(e),a,packet.profile));if(match.length===1){match[0].click();if(match[0].checked)count++;}}
 count+=await fillRoleRadios(fields);
 const files=[...document.querySelectorAll('input[type="file"]')].filter(e=>!e.disabled&&!/cover|portfolio/i.test(label(e)+' '+e.name+' '+e.id)&&/resume|cv|curriculum/i.test(label(e)+' '+e.name+' '+e.id));
 if(files.length===1&&!files[0].files.length&&packet.resume?.base64){const r=packet.resume,bytes=Uint8Array.from(atob(r.base64),c=>c.charCodeAt(0)),dt=new DataTransfer();dt.items.add(new File([bytes],r.name,{type:r.name.endsWith('.pdf')?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));files[0].files=dt.files;files[0].dispatchEvent(new Event('input',{bubbles:true}));files[0].dispatchEvent(new Event('change',{bubbles:true}));count++;}
 note.textContent=count+' fields filled.';if(count)await send('progress',{fields:[],message:'Filled '+count+' fields on the employer form.',blocked:false,filled:count});return count;
}
// AI results are application-only and are never allowed to overwrite a user's edit.
async function prepareMissingAnswers(){
 if(!packet?.aiAssistance||attempted||siteIssue())return 0;
 let prepared=0;
 for(const e of controls()){
  const fields=controls(),q=label(e),key=norm(q);
  if(prepared>=12)break;
  if(attempted||!visible(e)||controlComplete(e,fields)||descriptors(e).some(protectedQuestion)||answer(e)!==null||q==='Required field'||q.length<3||['file','password','checkbox','hidden','submit','button'].includes(e.type)||controlRole(e)==='checkbox')continue;
  if(!e.matches('input,select,textarea,[contenteditable="true"],[role="combobox"],[role="radio"]'))continue;
  if(aiTried.has(key)&&Date.now()-aiTried.get(key)<60000)continue;
  aiTried.set(key,Date.now());const url=location.href,question=q;note.textContent='Gemini is preparing: '+q;
  try{
   const choices=e.tagName==='SELECT'?[...e.options].filter(o=>!o.disabled&&o.value&&!/^(?:select|choose)\b/i.test(o.textContent.trim())).map(o=>o.textContent.trim()):e.type==='radio'?fields.filter(o=>o.type==='radio'&&o.name===e.name&&o.form===e.form).map(optionText):controlRole(e)==='radio'?roleRadioGroup(e).map(optionText):[];
   const result=await send('answer',{question,choices,answerFormat:e.type==='number'?'number':'text'}),state=await send('state');
   if(attempted||state.attempted||location.href!==url||!visible(e)||label(e)!==question||controlComplete(e,controls()))continue;
   if(typeof result.answer==='string'&&result.answer.trim()){
    packet.answers=packet.answers||{};Object.defineProperty(packet.answers,question,{value:result.answer.trim(),enumerable:true,configurable:true,writable:true});
    packet.applicationOnlyQuestions=[...new Set([...(packet.applicationOnlyQuestions||[]),question])];aiIssues.delete(question);prepared++;
   }else if(isRequired(e))aiIssues.set(question,result.reason||'Save the missing fact in your profile.');
  }catch(error){if(isRequired(e))aiIssues.set(question,error.message);}
 }
 return prepared;
}
// Let conditional controls settle and fill newly revealed fields before calling
// a step blocked. Each pass uses a fresh DOM and never clicks navigation/Submit.
async function fill(){
 if(!packet)packet=await send('packet');attempted=attempted||!!packet.job.attempted;if(!bar)mount();
 let total=0;
 for(let pass=0;pass<4;pass++){
  if(attempted)break;
  let filled=await fillPass();total+=filled;
  const prepared=await prepareMissingAnswers();
  if(prepared){const added=await fillPass();filled+=added;total+=added;}
  if(!filled&&!prepared)break;
  await pause(180);
 }
 return total;
}
async function report(reason,fields=[],blocked=true){note.textContent=reason;if(blocked&&!attempted){stopped=true;clearInterval(timer);}await send('progress',{fields,message:reason,blocked});if(blocked)await updateAttentionPosition();}
function signature(){return location.href+'|'+controls().map(e=>label(e)+':'+e.type+':'+controlRole(e)).join('|')+'|'+buttons().map(e=>buttonName(e)).join('|');}
function buttons(){return [...document.querySelectorAll('button,input[type="submit"],[role="button"]')].filter(e=>!bar?.contains(e)&&visible(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true');}
const buttonName=e=>compact(e.innerText||e.value||e.getAttribute('aria-label'));
const isSubmitAction=e=>/^(?:submit(?: my| your| the)?(?: application)?|send(?: my| the)? application|complete application)$/i.test(buttonName(e));
const isNextAction=e=>/^(?:next(?: step)?|continue(?: application)?|save\s*(?:&|and)\s*continue|save and next|review(?: application)?|proceed)$/i.test(buttonName(e));
async function advance(){
 const state=await send('state');attempted=attempted||state.attempted;const issue=siteIssue();if(issue){stopped=true;clearInterval(timer);const result=await send('site-error',{code:issue.code,empty:controls().length===0&&!document.querySelector('form'),initial:lastStep===''});note.textContent=result.message;return;}
 const text=receipt();if(text&&!initialReceipt&&attempted){await send('receipt',{receipt:text});note.textContent='Employer receipt verified. Application submitted.';stopped=true;clearInterval(timer);return;}
 if(attempted){if(!submitAt)submitAt=Date.now();if(Date.now()-submitAt>30000)await report('Submission uncertain. Check the employer receipt before retrying.');return;}
 const check=review();if(check.fields.length){const issue=check.fields.map(q=>aiIssues.get(q)).find(Boolean);if(issue)check.reason+=' · '+issue;}if(!state.automatic){note.textContent=check.reason||'Saved details filled. Review the employer form and click Submit.';await report(note.textContent,check.fields,!!check.reason);if(!attempted){stopped=true;clearInterval(timer);}return;}if(check.reason)return report(check.reason,check.fields);if(initialReceipt)return report('An existing receipt is visible. Verify this application manually.');
 const signatureNow=signature();if(lastStep===signatureNow){if(Date.now()-stepAt>15000)await report('This step did not advance. Check employer validation.');return;}
 const bs=buttons(),submit=bs.filter(isSubmitAction),next=bs.filter(isNextAction);
 if(!controls().length&&!bs.some(b=>isSubmitAction(b)||isNextAction(b)||/^(?:apply|apply now|apply for this job|start application)$/i.test(buttonName(b)))&&Date.now()-pageWaitAt<20000){note.textContent='Waiting for the employer form to load…';return;}
 if(submit.length===1&&next.length===0){
  if(!controls().length&&!document.querySelector('form'))return report('Cannot identify the final application form.');await send('capture',{fields:formAnswers()});const finalCheck=review();if(finalCheck.reason)return report(finalCheck.reason,finalCheck.fields);
  const finalButtons=buttons(),finalSubmit=finalButtons.filter(isSubmitAction);if(finalSubmit.length!==1||finalButtons.some(isNextAction))return report('The form changed before final review. Review this step.');return report('Ready to submit — all supported fields are filled. Review the form, then click Submit.',[],true);
 }
 if(next.length===1&&submit.length===0){if(!controls().length)return report('Cannot identify fields for this step.');await send('capture',{fields:formAnswers()});await send('step');lastStep=signatureNow;stepAt=Date.now();next[0].click();return;}
 const apply=bs.filter(e=>/^(?:apply|apply now|apply for this job|start application)$/i.test(buttonName(e)));if(!controls().length&&apply.length===1&&lastStep===''){await send('step');lastStep=signatureNow;stepAt=Date.now();apply[0].click();return;}await report('Application action is unfamiliar or ambiguous. Continue manually.');
}
function startReceiptMonitor(){stopped=false;clearInterval(timer);timer=setInterval(monitor,2500);}
async function persistAndReplaySubmission(button,form){
 if(submissionRecording||attempted)return;submissionRecording=true;
 try{await send('capture',{fields:formAnswers()}).catch(()=>{});await send('attempt',{before:bodyText(),human:true});attempted=true;submitAt=Date.now();note.textContent='Submission recorded. Waiting for employer confirmation.';startReceiptMonitor();replayingSubmission=true;if(button)button.click();else if(form?.requestSubmit)form.requestSubmit();else if(form)HTMLFormElement.prototype.submit.call(form);}
 catch(error){stopped=true;clearInterval(timer);note.textContent='Submit paused because ApplyPilot could not record the attempt: '+error.message+'. Keep this page open and review it in ApplyPilot.';await send('progress',{fields:[],message:note.textContent,blocked:true}).catch(()=>{});}
 finally{replayingSubmission=false;if(attempted)submissionRecording=false;}
}
async function monitor(){if(!started||busy||stopped)return;busy=true;try{if(!attempted)await fill();await advance();}catch(e){stopped=true;clearInterval(timer);if(note)note.textContent='Connection or form error: '+e.message;await send('progress',{fields:[],message:e.message,blocked:true}).catch(()=>{});}finally{busy=false;}}
// Refresh paused forms without reopening them or clicking any navigation button.
let savedRefreshBusy=false;
const answerSnapshot=p=>JSON.stringify([p?.profile,p?.answers,p?.aiAssistance,p?.applicationOnlyQuestions]);
async function refreshPausedAnswers(){
 if(!started||!stopped||busy||savedRefreshBusy||attempted||submissionRecording||siteIssue())return;
 savedRefreshBusy=true;busy=true;
 try{
  const state=await send('state');if(state.attempted){attempted=true;return;}if(!state.refreshEnabled)return;
  const latest=await send('packet');if(latest.job.attempted){attempted=true;return;}
  if(answerSnapshot(latest)===answerSnapshot(packet))return;
  packet=latest;busy=true;attemptedCustom=new WeakMap();
  // Only fill already saved answers here. AI preparation runs through the existing
  // bounded server worker; partial answer updates never advance or submit a form.
  await fillPass();const check=review();
  await report(check.reason||'Ready to submit - all supported fields are filled. Review the form, then click Submit.',check.fields,true);
 }catch{/* Keep the existing form and edits intact when the connection is unavailable. */}
 finally{busy=false;savedRefreshBusy=false;}
}
if(!siteIssue())setInterval(refreshPausedAnswers,30000);
async function resumeFill(){
 if(busy)throw Error('Form preparation is already running. Wait for it to finish.');busy=true;clearInterval(timer);pageWaitAt=Date.now();
 try{packet=await send('packet');attempted=attempted||!!packet.job.attempted||!!(await send('state')).attempted;
  if(!started){initialReceipt=!!receipt()&&!attempted;started=true;}
  stopped=false;attemptedCustom=new WeakMap();await fill();await advance();if(!stopped)timer=setInterval(monitor,2500);
 }finally{busy=false;}
}
async function begin(){try{await resumeFill();}catch(e){if(packet){if(!bar)mount();note.textContent=e.message;await send('progress',{fields:[],message:e.message,blocked:true}).catch(()=>{});}/* Unlinked tabs remain untouched and can be linked later. */}}
for(const type of ['input','change'])document.addEventListener(type,e=>{if(started&&e.isTrusted&&!bar?.contains(e.target)&&e.target.matches?.('input,select,textarea,[contenteditable="true"],[role="combobox"],[role="checkbox"],[role="radio"]'))recordAssistance();},true);
document.addEventListener('click',e=>{
 const b=e.target.closest?.('button,input[type="submit"],[role="button"]');if(!started||!e.isTrusted||!b||bar?.contains(b))return;recordAssistance();if(!isSubmitAction(b)||replayingSubmission)return;e.preventDefault();e.stopImmediatePropagation();if(attempted||submissionRecording){if(note)note.textContent='This submission action was already recorded. Check the employer receipt before trying again.';return;}persistAndReplaySubmission(b,b.form||b.closest('form'));
},true);
document.addEventListener('submit',e=>{
 if(!started||!e.isTrusted||replayingSubmission)return;const form=e.target,submitter=e.submitter&&isSubmitAction(e.submitter)?e.submitter:buttons().find(b=>b.form===form&&isSubmitAction(b));if(!submitter)return;e.preventDefault();e.stopImmediatePropagation();recordAssistance();if(attempted||submissionRecording){if(note)note.textContent='This submission action was already recorded. Check the employer receipt before trying again.';return;}persistAndReplaySubmission(submitter,form);
},true);
chrome.runtime.onMessage.addListener((m,sender,reply)=>{if(m.action==='fill'){resumeFill().then(()=>reply({ok:true})).catch(e=>reply({error:e.message}));return true;}});
begin();
})();
