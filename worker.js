import {applicationLimit,employerHold,recordEmployerLimit} from './employer-limits.js';
import {installLibrary,reusableAnswers,captureAnswers,confirmLibrary} from './answer-library.js';
import {installDrafts} from './answer-drafts.js';
import {hasResearchDraftForQuestion,installResearch,markResearchDraftUsed} from './google-research.js';
import {researchConsentWithdrawn} from './research-consent.js';
import {automaticTextAnswer} from './automatic-answer.js';
import {supported as hostAllowed,employerPageIssue} from './local-policy.js';
import {recoverWorkerJobs} from './local-state.js';
import {Handoffs,serveHandoffs} from './handoff.js';
import {pickResumeField} from './form-policy.js';
import {approvedHostedCheckbox,approvedHostedRadioIndex,hostedFieldAnswer,hostedOptionChoice,protectedHostedQuestion,requiredUnansweredRadioGroups,scopedHostedComboboxOptions} from './hosted-form.js';
import {chromium} from 'playwright';import {db,event,now} from './db.js';
import {runDueSearches} from './discovery.js';
installLibrary(db);
installDrafts(db);
installResearch(db);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function set(job,status,message,challenge=null,confirmation=null){db.prepare('UPDATE jobs SET status=?,challenge=?,confirmation=?,updated_at=? WHERE id=?').run(status,challenge,confirmation,now(),job.id);event(job.id,status,message)}
function claim(){if(handoffs?.full())return null;db.exec('BEGIN IMMEDIATE');try{let j=db.prepare("SELECT * FROM jobs WHERE status='queued' AND COALESCE(json_extract(job_metadata_json,'$.available'),1)!=0 AND applicant_id IN (SELECT id FROM applicants WHERE execution_mode='cloud') ORDER BY match_score DESC,discovery_priority,created_at LIMIT 1").get();if(j){db.prepare("UPDATE jobs SET status='running',attempts=attempts+1,lease_at=?,updated_at=? WHERE id=?").run(now(),now(),j.id);event(j.id,'running','Opening employer application')}db.exec('COMMIT');return j}catch(e){db.exec('ROLLBACK');throw e}}
async function pageIssue(page,status=0){
 const text=await page.locator('body').innerText().catch(()=>'');
 const hasForm=await page.locator('form,input:visible,textarea:visible,select:visible').count()>0;
 return employerPageIssue({status,text,hasForm});
}
async function fieldDescriptor(locator){
 return locator.evaluate(e=>{
  const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
  const ids=value=>clean(value).split(/\s+/).map(id=>document.getElementById(id)?.innerText||document.getElementById(id)?.textContent||'').filter(Boolean).join(' ');
  const labelled=ids(e.getAttribute('aria-labelledby')),described=ids(e.getAttribute('aria-describedby'));
  const explicit=[...e.labels||[]].map(label=>label.innerText||label.textContent||'').join(' ');
  const legend=e.closest('fieldset')?.querySelector(':scope > legend')?.innerText||'';
  const wrapper=e.closest('[data-automation-id*="formField" i],.application-question,[class*="field" i],[role="group"]');
  let context='';if(wrapper){const clone=wrapper.cloneNode(true);clone.querySelectorAll('input,textarea,select,button,[role="option"],script,style').forEach(node=>node.remove());context=clone.innerText||clone.textContent||'';}
  return {label:clean(explicit||labelled||legend||context).slice(0,4000),ariaLabel:clean(e.getAttribute('aria-label')),description:clean(described).slice(0,4000),name:e.name||'',id:e.id||'',placeholder:e.placeholder||'',autocomplete:e.autocomplete||'',type:e.type||e.getAttribute('role')||'',required:!!e.required||e.getAttribute('aria-required')==='true'||e.closest('[aria-required="true"]')!==null};
 });
}
async function fill(page,p){
 const answers=JSON.parse(p.answers_json||'{}'),controls=page.locator('input:not([role="combobox"]):visible');let n=0;
 for(let i=0;i<await controls.count();i++){
  const l=controls.nth(i),descriptor=await fieldDescriptor(l),type=String(descriptor.type||'').toLowerCase();if(['file','radio','checkbox','hidden','password','submit','button'].includes(type)||await l.inputValue().catch(()=>'')!=='')continue;
  const selected=hostedFieldAnswer(descriptor,p,answers);if(!selected)continue;
  await l.fill(selected.answer);n++;
 }
 return n;
}
function authorizeResearchFill(job,profile,question){if(researchConsentWithdrawn(db,job.id,profile.id))return false;if(!hasResearchDraftForQuestion(db,job.id,question))return true;markResearchDraftUsed(db,job.id,question);return !researchConsentWithdrawn(db,job.id,profile.id);}
async function review(page){return page.evaluate(()=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'};const clean=value=>String(value||'').replace(/\s+/g,' ').trim();const label=e=>{const ids=value=>clean(value).split(/\s+/).map(id=>document.getElementById(id)?.innerText||document.getElementById(id)?.textContent||'').filter(Boolean).join(' ');return clean((e.type==='radio'?e.closest('fieldset')?.querySelector('legend')?.innerText:'')||[...e.labels||[]].map(x=>x.innerText).join(' ')||ids(e.getAttribute('aria-labelledby'))||e.getAttribute('aria-label')||e.closest('[role="group"],[data-automation-id*="formField" i],.application-question,[class*="field" i]')?.innerText||e.name||'Required field').slice(0,4000)};let captcha=[...document.querySelectorAll('iframe[src*="captcha"],iframe[title*="challenge" i],.g-recaptcha,.h-captcha')].some(visible);if([...document.querySelectorAll('[name="g-recaptcha-response"],[name="h-captcha-response"]')].some(e=>e.value?.trim()))captcha=false;let signIn=[...document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"]')].some(visible);let missing=[...document.querySelectorAll('input:required,textarea:required,select:required,[aria-required="true"]')].filter(e=>{if(!visible(e))return false;const role=e.getAttribute('role');if(e.type==='file')return !e.files?.length;if(e.type==='radio')return ![...document.querySelectorAll('input[type="radio"]')].some(other=>other.name===e.name&&other.form===e.form&&other.checked);if(e.type==='checkbox')return !e.checked;if(role==='checkbox')return e.getAttribute('aria-checked')!=='true';if(role==='radio')return !e.closest('[role="radiogroup"]')?.querySelector('[role="radio"][aria-checked="true"]');if(role==='combobox')return !(e.value||e.getAttribute('aria-valuetext')||e.getAttribute('data-value')||e.textContent?.trim());return !e.value}).map(label);return {captcha,signIn,missing:[...new Set(missing)]}})}
async function custom(page,p,j){
 const answers=JSON.parse(p.answers_json||'{}'),applicationAnswers=JSON.parse(j.answers_json||'{}'),inputs=page.locator('textarea:visible,input[type="text"]:not([role="combobox"]):visible,input:not([type]):not([role="combobox"]):visible'),unresolved=[];
 for(let i=0;i<Math.min(await inputs.count(),50);i++){
  const l=inputs.nth(i);if(await l.inputValue().catch(()=>'')!=='')continue;
  const descriptor=await fieldDescriptor(l),q=descriptor.label||descriptor.ariaLabel||descriptor.description||descriptor.placeholder||descriptor.name||descriptor.id;if(!q)continue;
  if(protectedHostedQuestion(q)){if(descriptor.required)unresolved.push(q);continue;}
  const selected=await automaticTextAnswer({db,profile:p,job:j,question:q,answers,applicationAnswers}),applicationOnly=['public_page','application_only','approved_facts'].includes(selected.source);
  if(applicationOnly)await l.evaluate(e=>e.dataset.applypilotApplicationOnly='true');if(selected.source==='public_page')event(j.id,'public_page_draft',`Google filled a cited public-page draft for: ${q}`);if(selected.source==='application_only')event(j.id,'application_only_answer',`Filled an edited application-only answer for: ${q}`);if(selected.source==='approved_facts')event(j.id,'ai_draft',`AI filled a fact-grounded draft for: ${q}`);
  if(selected.answer!==null){if(applicationOnly&&!authorizeResearchFill(j,p,q))return {unresolved,withdrawn:true};await l.fill(selected.answer);event(j.id,'answer',`Answered: ${q}`)}else if(descriptor.required)unresolved.push(q);
 }
 return {unresolved,withdrawn:false};
}
async function selections(page,p,j){
 const answers=JSON.parse(p.answers_json||'{}');
 const selects=page.locator('select:visible');
 for(let i=0;i<await selects.count();i++){
  const el=selects.nth(i),descriptor={...await fieldDescriptor(el),type:'select',populated:await el.evaluate(e=>!!e.value&&!e.selectedOptions?.[0]?.disabled&&!/^(?:select|choose)(?:\b|\.{3})/i.test(e.selectedOptions?.[0]?.textContent?.trim()||''))};if(descriptor.populated)continue;
  const q=descriptor.label||descriptor.ariaLabel||descriptor.name||descriptor.id;
  const options=await el.locator('option').evaluateAll(xs=>xs.map(x=>({label:x.textContent,value:x.value,disabled:x.disabled})));
  const choice=hostedOptionChoice(descriptor,options,p,answers);
  if(choice){if(!authorizeResearchFill(j,p,q))return false;await el.selectOption(choice.value);}
 }
 return true;
}
async function radios(page,p,j){
 const fields=page.locator('input[type="radio"]:visible');
 const descriptors=await fields.evaluateAll(xs=>xs.map(e=>({name:e.name,form:[...document.forms].indexOf(e.form),question:e.closest('fieldset')?.querySelector('legend')?.innerText?.trim()||'',label:e.labels?.[0]?.innerText?.trim()||e.getAttribute('aria-label')||'',checked:e.checked})));
 const groups=new Map();descriptors.forEach((o,index)=>{const key=o.form+':'+o.name;if(!groups.has(key))groups.set(key,[]);groups.get(key).push({...o,index})});
 const answers=JSON.parse(p.answers_json||'{}');for(const options of groups.values()){
  if(options.some(o=>o.checked))continue;const selected=approvedHostedRadioIndex(options,answers);
  if(selected>=0){if(!authorizeResearchFill(j,p,options[selected].question))return false;await fields.nth(options[selected].index).check();}
 }
 return true;
}
async function checkboxes(page,p,j){
 const answers=JSON.parse(p.answers_json||'{}'),fields=page.locator('input[type="checkbox"]:visible');
 for(let i=0;i<await fields.count();i++){
  const field=fields.nth(i);if(await field.isChecked().catch(()=>false))continue;
  const descriptor=await fieldDescriptor(field),question=descriptor.label||descriptor.ariaLabel||descriptor.description||descriptor.name||descriptor.id;
  const approved=approvedHostedCheckbox(question,answers);if(approved===true){if(!authorizeResearchFill(j,p,question))return false;await field.check();}
 }
 return true;
}
async function customControls(page,p,j){
 const answers=JSON.parse(p.answers_json||'{}'),unresolved=[];
 const combos=page.locator('[role="combobox"]:not(select):visible');
 for(let i=0;i<await combos.count();i++){
  const control=combos.nth(i),descriptor=await fieldDescriptor(control),question=descriptor.label||descriptor.ariaLabel||descriptor.description||descriptor.name||descriptor.id;
  const populated=await control.evaluate(e=>{const text=String(e.textContent||'').trim();return !!(e.value||e.getAttribute('aria-valuetext')||e.getAttribute('data-value')||e.getAttribute('aria-activedescendant')||(!e.matches('input')&&text&&!/^(?:select|choose)(?:\b|\.{3})/i.test(text)));}).catch(()=>false);if(populated)continue;
  if(!question||protectedHostedQuestion(question)){if(descriptor.required)unresolved.push(question||'Required selection');continue;}
  const scopeIds=await control.evaluate(e=>[...new Set(`${e.getAttribute('aria-controls')||''} ${e.getAttribute('aria-owns')||''}`.trim().split(/\s+/).filter(Boolean))]);
  const marker=`combo-${i}-${Date.now()}`,optionLocator=page.locator('[role="option"]:visible');
  await optionLocator.evaluateAll((xs,value)=>xs.forEach(x=>x.setAttribute('data-applypilot-visible-before-combobox',value)),marker);
  const clicked=await control.click().then(()=>true,()=>false);
  if(clicked)await page.waitForFunction(({ids,marker})=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'};return [...document.querySelectorAll('[role="option"]')].some(option=>visible(option)&&(ids.some(id=>document.getElementById(id)?.contains(option))||(!ids.length&&option.getAttribute('data-applypilot-visible-before-combobox')!==marker)));},{ids:scopeIds,marker},{timeout:1200}).catch(()=>{});
  const rawOptions=await optionLocator.evaluateAll((xs,{ids,marker})=>{const groups=[];return xs.map((x,index)=>{const group=x.closest('[role="listbox"],[role="menu"],[role="tree"],[role="grid"]')||x.parentElement;let groupIndex=groups.indexOf(group);if(groupIndex<0){groups.push(group);groupIndex=groups.length-1;}return {index,label:(x.innerText||x.textContent||'').trim(),value:x.getAttribute('data-value')||x.getAttribute('value')||'',disabled:x.getAttribute('aria-disabled')==='true',scopeIds:ids.filter(id=>document.getElementById(id)?.contains(x)),newlyVisible:x.getAttribute('data-applypilot-visible-before-combobox')!==marker,group:String(groupIndex)};});},{ids:scopeIds,marker});
  const expanded=await control.getAttribute('aria-expanded')==='true',opened=clicked&&(expanded||rawOptions.some(option=>option.scopeIds.length||option.newlyVisible));
  const options=scopedHostedComboboxOptions(rawOptions,{scopeIds,opened});
  const choice=hostedOptionChoice(descriptor,options,p,answers);
  await page.locator('[data-applypilot-visible-before-combobox]').evaluateAll(xs=>xs.forEach(x=>x.removeAttribute('data-applypilot-visible-before-combobox'))).catch(()=>{});
  if(choice){if(!authorizeResearchFill(j,p,question))return {unresolved,withdrawn:true};await optionLocator.nth(choice.index).click();}
  else {await control.press('Escape').catch(()=>{});if(descriptor.required)unresolved.push(question);}
 }
 const groups=page.locator('[role="radiogroup"]:visible');
 for(let i=0;i<await groups.count();i++){
  const group=groups.nth(i),descriptor=await fieldDescriptor(group),question=descriptor.label||descriptor.ariaLabel||descriptor.description||`Selection ${i+1}`,optionsLocator=group.locator('[role="radio"]:visible');
  if(await optionsLocator.evaluateAll(xs=>xs.some(x=>x.getAttribute('aria-checked')==='true')))continue;
  const options=await optionsLocator.evaluateAll((xs,q)=>xs.map((x,index)=>({index,question:q,label:(x.innerText||x.textContent||x.getAttribute('aria-label')||'').trim(),checked:x.getAttribute('aria-checked')==='true'})),question),selected=approvedHostedRadioIndex(options,answers);
  if(selected>=0){if(!authorizeResearchFill(j,p,question))return {unresolved,withdrawn:true};await optionsLocator.nth(selected).click();}else if(descriptor.required)unresolved.push(question);
 }
 const roles=page.locator('[role="checkbox"]:not(input):visible');
 for(let i=0;i<await roles.count();i++){
  const field=roles.nth(i);if(await field.getAttribute('aria-checked')==='true')continue;
  const descriptor=await fieldDescriptor(field),question=descriptor.label||descriptor.ariaLabel||descriptor.description||`Checkbox ${i+1}`,approved=approvedHostedCheckbox(question,answers);
  if(approved===true){if(!authorizeResearchFill(j,p,question))return {unresolved,withdrawn:true};await field.click();}else if(descriptor.required)unresolved.push(question);
 }
 return {unresolved,withdrawn:false};
}
async function rememberForm(page,job){
 const fields=await page.locator('input:visible,textarea:visible,select:visible').evaluateAll(xs=>xs.filter(e=>e.dataset.applypilotApplicationOnly!=='true'&&!['password','hidden','file','checkbox','submit','button'].includes(e.type)&&(e.type!=='radio'||e.checked)).map(e=>({question:(e.type==='radio'?e.closest('fieldset')?.querySelector('legend')?.innerText:null)||e.labels?.[0]?.innerText||e.getAttribute('aria-label')||'',answer:e.tagName==='SELECT'?e.selectedOptions?.[0]?.textContent:e.type==='radio'?(e.labels?.[0]?.innerText||''):e.value})).filter(f=>f.question&&f.answer).slice(0,120));
 captureAnswers(db,job,fields.filter(field=>!hasResearchDraftForQuestion(db,job.id,field.question)));
}
async function humanPause(job,page,p){
 // Fill only accessible fields. Playwright respects overlays and actionability.
 const filled=await fill(page,p).catch(()=>0);if(filled)event(job.id,'filled',`Filled ${filled} contact fields before human handoff`);
 try{const files=page.locator('input[type="file"]');const fields=await files.evaluateAll(xs=>xs.map(e=>({label:[...e.labels||[]].map(l=>l.innerText).join(' '),id:e.id.replace(/[_-]/g,' '),name:e.name.replace(/[_-]/g,' ')})));const selected=pickResumeField(fields);if(selected>=0){await files.nth(selected).setInputFiles(p.resume_path);event(job.id,'upload','Resume attached before human handoff');}}catch{}
 set(job,'paused','Human verification required','CAPTCHA');
}
let handoffs,resumeQueue=[];
async function run(job,browser,resumed=null){const held=employerHold(db,job);if(held)return set(job,'needs_review',held.message,'Employer application limit');let p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(job.applicant_id,job.user_id);if(p)p={...p,answers_json:JSON.stringify({...reusableAnswers(db,p),...JSON.parse(job.answers_json||'{}')})};if(!p?.consent||!p.email||!p.resume_path)return set(job,'needs_review','Profile needs consent, email and resume');if(researchConsentWithdrawn(db,job.id,p.id))return set(job,'needs_review','Google public job-page drafting consent was withdrawn','Research consent withdrawn');if(!hostAllowed(job.url))return set(job,'needs_review','Use a supported direct employer application link');let context=resumed?.context||await browser.newContext({acceptDownloads:false,locale:'en-CA',viewport:{width:1100,height:800}});let page=resumed?.page||await context.newPage();const browserPage=page;browserPage.setDefaultTimeout(5000);if(!resumed&&!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type='completion_tracking'").get(job.id))event(job.id,'completion_tracking','Hosted form tracking started before application preparation.');try{if(!resumed){const navigation=await page.goto(job.url,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1200);const issue=await pageIssue(page,navigation?.status());if(issue)return set(job,'needs_review',issue.message+' The application was not submitted. Try this employer later.','Employer site unavailable');}if(applicationLimit(await page.locator('body').innerText())){recordEmployerLimit(db,job.user_id,job.id,await page.locator('body').innerText(),{source:'Employer page observed by hosted worker'});return set(job,'needs_review','Employer application limit reached. Other employers can continue.','Employer application limit');}if(!hostAllowed(page.url()))return set(job,'needs_review','Employer redirected to a website that needs review');let check=await review(page);db.prepare('UPDATE jobs SET required_fields_json=? WHERE id=?').run(JSON.stringify(check.missing),job.id);if(check.captcha)return await humanPause(job,page,p);if(check.signIn)return set(job,'paused','Sign-in required','Sign-in');const landing=await page.locator('input:visible,textarea:visible,select:visible,[role="combobox"]:visible').count()===0;let apply=page.getByRole('button',{name:/^(apply|apply now|apply for this job)$/i});let applyLink=page.getByRole('link',{name:/^apply for this job$/i});if(!resumed&&landing&&await apply.count()===1){await apply.click();await page.waitForTimeout(800);if(!hostAllowed(page.url()))return set(job,'needs_review','Application redirected to an unsupported site')}else if(!resumed&&landing&&await applyLink.count()){let urls=await applyLink.evaluateAll(links=>[...new Set(links.map(link=>link.href))]);if(urls.length!==1||!hostAllowed(urls[0]))return set(job,'needs_review','Application link needs review');await applyLink.first().click();await page.waitForTimeout(800);if(!hostAllowed(page.url()))return set(job,'needs_review','Application redirected to an unsupported site')}
// Locate an application embedded in a supported employer frame.
const scopes=[];for(const frame of browserPage.frames()){
 if(!hostAllowed(frame.url()))continue;
 const inputs=await frame.locator('input[type="email"]:visible,input[name*="first" i]:visible,input[name*="name" i]:visible').count();
 const uploads=await frame.locator('input[type="file"]').count();
 if(inputs&&uploads)scopes.push(frame);
}
if(scopes.length>1)return set(job,'needs_review','Several application forms were found. Open the employer form to choose the correct one.','Ambiguous form');
if(scopes.length===1){page=scopes[0];if(page!==browserPage.mainFrame())event(job.id,'form','Located embedded employer application');}
check=await review(page);db.prepare('UPDATE jobs SET required_fields_json=? WHERE id=?').run(JSON.stringify(check.missing),job.id);if(check.captcha)return await humanPause(job,page,p);if(check.signIn)return set(job,'paused','Sign-in required','Sign-in');
let uploaded=false;
for(let step=0;step<15;step++){
const heldNow=employerHold(db,job);if(heldNow)return set(job,'needs_review',heldNow.message,'Employer application limit');
const limitText=await page.locator('body').innerText();if(applicationLimit(limitText)){recordEmployerLimit(db,job.user_id,job.id,limitText,{source:'Employer page observed by hosted worker'});return set(job,'needs_review','Employer application limit reached. Other employers can continue.','Employer application limit');}
const issue=await pageIssue(page);if(issue)return set(job,'needs_review',issue.message+' Review this employer page before continuing.','Employer site unavailable');
const freshResearch=db.prepare('SELECT google_research_consent FROM applicants WHERE id=? AND user_id=?').get(p.id,job.user_id);p.google_research_consent=freshResearch?.google_research_consent?1:0;
if(researchConsentWithdrawn(db,job.id,p.id))return set(job,'needs_review','Google public job-page drafting consent was withdrawn','Research consent withdrawn');
if(!hostAllowed(page.url()))return set(job,'needs_review','Application redirected outside supported employers','Unsupported redirect');
if(await page.locator('input[autocomplete=one-time-code]:visible,input[type=password]:visible').count())return set(job,'paused','Sign-in or MFA requires you','Sign-in');
let filled=await fill(page,p);event(job.id,'filled',`Filled ${filled} standard fields`);let file=page.locator('input[type="file"]'),count=await file.count();if(count){
const fields=await file.evaluateAll(xs=>xs.map(e=>({label:[...e.labels||[]].map(l=>l.innerText).join(' '),id:e.id.replace(/[_-]/g,' '),name:e.name.replace(/[_-]/g,' '),context:(e.closest('fieldset')?.querySelector('legend')?.innerText||e.parentElement?.querySelector('label')?.innerText||'')})));
const selected=pickResumeField(fields);
if(selected<0)return set(job,'needs_review','Cannot identify a unique resume upload. Fields: '+fields.map(f=>f.label||f.id||f.name||'unlabelled upload').join('; '),'Upload needs review');
await file.nth(selected).setInputFiles(p.resume_path);uploaded=true;event(job.id,'upload','Resume attached to identified resume field');
}if(!await selections(page,p,job)||!await radios(page,p,job)||!await checkboxes(page,p,job))return set(job,'needs_review','Google public job-page drafting consent was withdrawn','Research consent withdrawn');const customResult=await custom(page,p,job);if(customResult.withdrawn)return set(job,'needs_review','Google public job-page drafting consent was withdrawn','Research consent withdrawn');const customState=await customControls(page,p,job);if(customState.withdrawn)return set(job,'needs_review','Google public job-page drafting consent was withdrawn','Research consent withdrawn');let unknown=[...new Set([...customResult.unresolved,...customState.unresolved])];check=await review(page);const requiredMissing=[...new Set([...check.missing,...unknown])];db.prepare('UPDATE jobs SET required_fields_json=? WHERE id=?').run(JSON.stringify(requiredMissing),job.id);if(check.captcha)return await humanPause(job,page,p);if(check.signIn)return set(job,'paused','Sign-in required','Sign-in');if(requiredMissing.length){const protectedMissing=requiredMissing.filter(protectedHostedQuestion);return set(job,'needs_review',`${protectedMissing.length?'Protected questions need you':'Missing required fields'}: ${requiredMissing.slice(0,8).join('; ')}`,protectedMissing.length?'Sensitive action':'Missing answers');}const radioState=await page.locator('input[type=radio]:visible').evaluateAll(radios=>radios.map(r=>({form:[...document.forms].indexOf(r.form),name:r.name||'',question:r.closest('fieldset')?.querySelector('legend')?.innerText||'',required:r.required||r.getAttribute('aria-required')==='true'||r.closest('fieldset')?.getAttribute('aria-required')==='true',checked:r.checked}))),unanswered=requiredUnansweredRadioGroups(radioState);if(unanswered.length)return set(job,'needs_review',`Unanswered selection questions: ${unanswered.slice(0,8).join('; ')}`,'Missing answers');let submit=page.getByRole('button',{name:/^(submit application|submit|send application|complete application)$/i});const next=page.getByRole('button',{name:/^(next|next step|continue|continue application|save (?:and|&) continue|review|review application|proceed)$/i});
if(await next.count()===1&&await submit.count()===0){
 if(researchConsentWithdrawn(db,job.id,p.id))return set(job,'needs_review','Google public job-page drafting consent was withdrawn','Research consent withdrawn');
 await rememberForm(page,job);const before=await page.locator('body').innerText();await next.click();let advanced=false;for(let settle=0;settle<8;settle++){await browserPage.waitForTimeout(300);if(await page.locator('body').innerText()!==before){advanced=true;break;}}
 if(!advanced)return set(job,'needs_review','Application did not advance; check validation','Form validation');
 event(job.id,'step','Completed application step '+(step+1));continue;
}
if(await submit.count()!==1||await next.count()>0)return set(job,'needs_review',`Submit button not recognized${unknown.length?`; required questions: ${unknown.slice(0,4).join('; ')}`:''}`,'Unfamiliar form');if(researchConsentWithdrawn(db,job.id,p.id))return set(job,'needs_review','Google public job-page drafting consent was withdrawn','Research consent withdrawn');const current=db.prepare('SELECT consent FROM applicants WHERE id=?').get(p.id);if(!current?.consent)return set(job,'needs_review','Consent was withdrawn');await rememberForm(page,job);const finalHold=employerHold(db,job);if(finalHold)return set(job,'needs_review',finalHold.message,'Employer application limit');event(job.id,'prepared','All supported fields are filled. The applicant must make the final submission.');return set(job,'needs_review','Ready to submit — review the filled application and click Submit.','Ready to submit');
}
return set(job,'needs_review','Application exceeded the 15-step limit','Step limit');
}catch(e){set(job,'needs_review',`Worker stopped: ${String(e.message).slice(0,350)}`,db.prepare('SELECT challenge FROM jobs WHERE id=?').get(job.id)?.challenge==='Submission in progress'?'Unconfirmed submission':'Worker error')}finally{
 const state=db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id);
 if(['paused','needs_review'].includes(state?.status)&&!['Employer site unavailable','Employer application limit'].includes(db.prepare('SELECT challenge FROM jobs WHERE id=?').get(job.id)?.challenge)&&!browserPage.isClosed()){
  const held=await handoffs.hold({...job,...db.prepare('SELECT challenge FROM jobs WHERE id=?').get(job.id)},context,browserPage);db.prepare('UPDATE jobs SET handoff_available=? WHERE id=?').run(held===false?0:1,job.id);event(job.id,'handoff','Live browser ready. Take over to continue in the same form.');
 }else await context.close();
}}
async function main(){recoverWorkerJobs();let browser=await chromium.launch({headless:true});console.log('ApplyPilot worker running');
 db.prepare('UPDATE jobs SET handoff_available=0').run();
 handoffs=new Handoffs({
  onClose:(job,message)=>{db.prepare('UPDATE jobs SET handoff_available=0 WHERE id=?').run(job.id);event(job.id,'handoff_closed',message)},
  onPossibleSubmit:job=>{if(!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('manual_submission','submission_started') LIMIT 1").get(job.id)){event(job.id,'manual_submission','Applicant clicked the employer submit control.');event(job.id,'submission_started','Submission intent saved before the employer action.');}db.prepare("UPDATE jobs SET challenge='Unconfirmed submission',updated_at=? WHERE id=?").run(now(),job.id)},
  onSubmitted:(job,receiptText)=>{confirmLibrary(db,job);set(job,'submitted','Employer confirmed receipt during human handoff',null,receiptText);db.prepare('UPDATE jobs SET handoff_available=0 WHERE id=?').run(job.id)},
  onResume:async(job,session)=>{
   const current=db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
   if(!['paused','needs_review'].includes(current?.status)||['Unconfirmed submission','Submission in progress'].includes(current.challenge))throw Error('Check the employer receipt before resuming. A submission may already have occurred.');
   const applicant=db.prepare('SELECT consent FROM applicants WHERE id=?').get(job.applicant_id);if(!applicant?.consent)throw Error('Applicant consent is required');
   db.prepare("UPDATE jobs SET status='running',handoff_available=0,challenge=NULL,updated_at=? WHERE id=?").run(now(),job.id);
   event(job.id,'resumed','Applicant returned the same browser to the worker');resumeQueue.push({job:current,session});
  }
 });serveHandoffs(handoffs);const heartbeat=()=>db.prepare('INSERT INTO worker_status VALUES(1,?) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat').run(now());heartbeat();setInterval(heartbeat,10000);let discoveryBusy=false;async function discoveryTick(){if(discoveryBusy)return;discoveryBusy=true;try{await runDueSearches()}catch(e){console.error('Discovery:',e)}finally{discoveryBusy=false}}setInterval(discoveryTick,60000);discoveryTick();process.on('SIGTERM',async()=>{await browser.close();process.exit(0)});for(;;){await handoffs.expire();const resume=resumeQueue.shift();if(resume){await run(resume.job,browser,resume.session);continue}let j=claim();if(j)await run(j,browser);else await sleep(3000)}}main().catch(e=>{console.error(e);process.exit(1)});
