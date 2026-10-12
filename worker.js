import {hostedFormState} from './hosted-form-state.js';
import {employmentContext} from './employment-answers.js';
import {currentSearchScope} from './search-scope.js';
import {fillHostedButtonGroups} from './hosted-buttons.js';
import {readToken} from './auth.js';
import {fillHostedText,typeHostedSearch} from './hosted-input.js';
import {submitHostedApplication,retainBlockedSession,releaseSkippedHandoffs} from './hosted-submission.js';
import {inActiveBatch} from './application-batches.js';
import {ensureFocusedJob,savedSearchClaimProblem,focusAllowsSubmit,reserveAutonomousAttempt,saveFormProgress} from './single-application.js';
import {applicationLimit,employerHold,recordEmployerLimit} from './employer-limits.js';
import {installLibrary,reusableAnswers,captureAnswers,confirmLibrary} from './answer-library.js';
import {installDrafts} from './answer-drafts.js';
import {hasResearchDraftForQuestion,installResearch,markResearchDraftUsed} from './google-research.js';
import {researchConsentWithdrawn} from './research-consent.js';
import {automaticTextAnswer} from './automatic-answer.js';
import {prepareHostedDropdown} from './dropdown-answer.js';
import {supported as hostAllowed,sameApplication,employerPageIssue,savedOptionSelections} from './local-policy.js';
import {recoverWorkerJobs} from './local-state.js';
import {Handoffs,serveHandoffs} from './handoff.js';
import {pickResumeField} from './form-policy.js';
import {approvedHostedCheckbox,approvedHostedRadioIndex,hostedFieldAnswer,hostedFieldKind,hostedOptionChoice,protectedHostedQuestion,requiredUnansweredRadioGroups,scopedHostedComboboxOptions} from './hosted-form.js';
import {chromium} from 'playwright';import {db,event,now} from './db.js';
import {runDueSearches} from './discovery.js';
import {prioritizeApplications} from './application-diversity.js';
installLibrary(db);
installDrafts(db);
installResearch(db);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function set(job,status,message,challenge=null,confirmation=null){if(db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id)?.status==='archived')return;db.prepare('UPDATE jobs SET status=?,challenge=?,confirmation=?,updated_at=? WHERE id=?').run(status,challenge,confirmation,now(),job.id);event(job.id,status,message)}
function claim(){if(handoffs?.full())return null;
 for(const f of db.prepare('SELECT user_id FROM work_focus WHERE enabled=1').all())ensureFocusedJob(db,f.user_id);
 db.exec('BEGIN IMMEDIATE');
 try{
  const candidates=db.prepare("SELECT * FROM jobs WHERE status='queued' AND COALESCE(json_extract(job_metadata_json,'$.available'),1)!=0 AND applicant_id IN (SELECT id FROM applicants WHERE execution_mode='cloud') AND local_owner IS NULL AND (NOT EXISTS(SELECT 1 FROM application_batch_preferences b WHERE b.user_id=jobs.user_id AND b.enabled=1) OR EXISTS(SELECT 1 FROM application_batch_members m JOIN application_batch_preferences b ON b.current_batch=m.batch_id AND b.enabled=1 WHERE m.job_id=jobs.id AND m.user_id=jobs.user_id)) AND (NOT EXISTS(SELECT 1 FROM work_focus f WHERE f.user_id=jobs.user_id AND f.enabled=1) OR id=(SELECT job_id FROM work_focus f WHERE f.user_id=jobs.user_id AND f.enabled=1)) ORDER BY match_score DESC,discovery_priority,created_at").all();let j;
  for(const userId of new Set(candidates.map(job=>job.user_id))){
   j=prioritizeApplications(db,userId,candidates.filter(job=>job.user_id===userId)).find(job=>job.metadata?.eligibility?.eligible!==false&&!savedSearchClaimProblem(db,job));
   if(j)break;
  }
  if(j){db.prepare("UPDATE jobs SET status='running',attempts=attempts+1,lease_at=?,updated_at=? WHERE id=?").run(now(),now(),j.id);event(j.id,'running','Opening employer application')}
  db.exec('COMMIT');return j;
 }catch(e){db.exec('ROLLBACK');throw e}
}
async function pageIssue(page,status=0){
 const text=await page.locator('body').innerText().catch(()=>'');
 const hasForm=await page.locator('form,input:visible,textarea:visible,select:visible').count()>0;
 return employerPageIssue({status,text,hasForm});
}
async function fieldDescriptor(locator){return locator.evaluate(hostedFormState);}
async function fill(page,p){
 const answers=JSON.parse(p.answers_json||'{}'),controls=page.locator('input:not([role="combobox"]):visible');let n=0;
 for(let i=0;i<await controls.count();i++){
  const l=controls.nth(i),descriptor=await fieldDescriptor(l),type=String(descriptor.type||'').toLowerCase();if(['file','radio','checkbox','hidden','password','submit','button'].includes(type)||await l.inputValue().catch(()=>'')!=='')continue;
  const selected=hostedFieldAnswer(descriptor,p,answers);if(!selected)continue;
  if(await fillHostedText(l,selected.answer,{kind:selected.kind}))n++;
 }
 return n;
}
function authorizeResearchFill(job,profile,question){if(researchConsentWithdrawn(db,job.id,profile.id))return false;if(!hasResearchDraftForQuestion(db,job.id,question))return true;markResearchDraftUsed(db,job.id,question);return !researchConsentWithdrawn(db,job.id,profile.id);}
async function review(page){
 const state=await page.evaluate(hostedFormState);
 // A matching embedded form does not exempt an outer-page CAPTCHA, sign-in,
 // or validation overlay. Do not count unrelated outer fields as questions.
 if(typeof page.parentFrame==='function'&&page.parentFrame()){
  const outer=await page.page().mainFrame().evaluate(hostedFormState);
  state.captcha=state.captcha||outer.captcha;state.signIn=state.signIn||outer.signIn;state.pending=state.pending||outer.pending;
 }
 return state;
}
async function custom(page,p,j){
 const answers=JSON.parse(p.answers_json||'{}'),applicationAnswers=JSON.parse(j.answers_json||'{}'),inputs=page.locator('textarea:visible,input[type="text"]:not([role="combobox"]):visible,input:not([type]):not([role="combobox"]):visible,input[type="number"]:visible,input[type="date"]:visible'),unresolved=[];
 for(let i=0;i<Math.min(await inputs.count(),50);i++){
  const l=inputs.nth(i);if(await l.inputValue().catch(()=>'')!=='')continue;
  const descriptor=await fieldDescriptor(l),q=descriptor.label||descriptor.ariaLabel||descriptor.description||descriptor.placeholder||descriptor.name||descriptor.id;if(!q)continue;
  if(descriptor.ambiguous||descriptor.contextRequired){if(descriptor.required)unresolved.push(q);continue;}
  const approved=hostedFieldAnswer(descriptor,p,answers);
  if(approved?.kind==='employment'){if(await fillHostedText(l,approved.answer,{kind:approved.kind}))event(j.id,'answer',`Filled approved application fact: ${q}`);continue;}
  if(protectedHostedQuestion(q+' '+(descriptor.description||''))){if(descriptor.required)unresolved.push(q);continue;}
  // Profile conflicts/missing facts must not fall through to model drafting.
  // This also fills contact facts when an employer renders them as textareas.
  if(hostedFieldKind(descriptor)){
   const trusted=hostedFieldAnswer(descriptor,p,answers);
   if(trusted){if(await fillHostedText(l,trusted.answer,{kind:trusted.kind}))event(j.id,'answer',`Filled saved profile field: ${q}`);}
   else if(descriptor.required)unresolved.push(q);
   continue;
  }
  const selected=await automaticTextAnswer({db,profile:p,job:j,question:q,answers,applicationAnswers,fieldHelp:descriptor.description,answerFormat:descriptor.type==='number'?'number':'text',maxLength:await l.evaluate(e=>e.maxLength>0?e.maxLength:4000)}),applicationOnly=['public_page','application_only','approved_facts'].includes(selected.source);
  if(selected.answer===null&&selected.reason)event(j.id,'answer_blocked',q+': '+selected.reason);
  if(applicationOnly)await l.evaluate(e=>e.dataset.applypilotApplicationOnly='true');if(selected.source==='public_page')event(j.id,'public_page_draft',`Google filled a cited public-page draft for: ${q}`);if(selected.source==='application_only')event(j.id,'application_only_answer',`Filled an edited application-only answer for: ${q}`);if(selected.source==='approved_facts')event(j.id,'ai_draft',`AI filled a fact-grounded draft for: ${q}`);
  if(selected.answer!==null){if(applicationOnly&&!authorizeResearchFill(j,p,q))return {unresolved,withdrawn:true};if(await fillHostedText(l,selected.answer))event(j.id,'answer',`Answered: ${q}`)}else if(descriptor.required)unresolved.push(q);
 }
 return {unresolved,withdrawn:false};
}
async function selections(page,p,j){
 const answers=JSON.parse(p.answers_json||'{}');
 const selects=page.locator('select:visible');
 for(let i=0;i<await selects.count();i++){
  const el=selects.nth(i),descriptor={...await fieldDescriptor(el),type:'select',populated:await el.evaluate(e=>!!e.value&&!e.selectedOptions?.[0]?.disabled&&!/^(?:select|choose)(?:\b|\.{3})/i.test(e.selectedOptions?.[0]?.textContent?.trim()||''))};if(descriptor.populated)continue;
  const q=descriptor.label||descriptor.ariaLabel||descriptor.name||descriptor.id;
  if(descriptor.ambiguous||descriptor.contextRequired)continue;
  const options=await el.locator('option').evaluateAll(xs=>xs.map((x,index)=>({index,label:x.textContent,value:x.value,disabled:x.disabled||!!x.closest('optgroup[disabled]')})));
  if(await el.evaluate(e=>e.multiple)){
   const choices=savedOptionSelections(q,options,answers);if(!choices||protectedHostedQuestion(q+' '+(descriptor.description||'')+' '+options.map(o=>o.label).join(' ')))continue;
   const current=await el.locator('option').evaluateAll(xs=>xs.map((x,index)=>({index,label:x.textContent,value:x.value,disabled:x.disabled||!!x.closest('optgroup[disabled]')})));
   if(JSON.stringify(current)!==JSON.stringify(options)||await el.evaluate(e=>[...e.selectedOptions].some(o=>o.value&&!o.disabled&&!/^(?:select|choose)\b/i.test(o.textContent.trim()))))continue;
   if(!authorizeResearchFill(j,p,q))return false;
   await el.selectOption(choices.map(o=>({index:o.index})));await el.blur();
   const retained=await el.evaluate(e=>[...e.selectedOptions].map(o=>({index:o.index,label:o.textContent,value:o.value})).sort((a,b)=>a.index-b.index));
   const expected=choices.map(o=>({index:o.index,label:o.label,value:o.value})).sort((a,b)=>a.index-b.index);
   if(JSON.stringify(retained)!==JSON.stringify(expected)){const error=Error('The employer form did not retain the complete selection. Review the field before continuing.');error.code='HOSTED_INPUT_NOT_RETAINED';throw error;}
   continue;
  }
  const choice=await prepareHostedDropdown(db,j,p,descriptor,options,answers);
  const current=await el.locator('option').evaluateAll(xs=>xs.map((x,index)=>({index,label:x.textContent,value:x.value,disabled:x.disabled||!!x.closest('optgroup[disabled]')})));
  const populated=await el.evaluate(e=>!!e.value&&!e.selectedOptions?.[0]?.disabled&&!/^(?:select|choose)\b/i.test(e.selectedOptions?.[0]?.textContent?.trim()||''));
  if(choice&&!populated&&JSON.stringify(current)===JSON.stringify(options)){if(!authorizeResearchFill(j,p,q))return false;await el.selectOption({index:choice.index});await el.blur();if(!await el.evaluate((e,selected)=>e.selectedIndex===selected.index&&e.selectedOptions[0]?.textContent===selected.label&&e.value===String(selected.value),choice)){const error=Error('The employer form did not retain the selected answer.');error.code='HOSTED_INPUT_NOT_RETAINED';throw error;}if(choice.aiPrepared)await el.evaluate(e=>e.dataset.applypilotApplicationOnly='true');}
 }
 return true;
}
async function radios(page,p,j){
 const fields=page.locator('input[type="radio"]:visible');
 const descriptors=await fields.evaluateAll(xs=>xs.map(e=>({name:e.name,form:[...document.forms].indexOf(e.form),label:e.labels?.[0]?.innerText?.trim()||e.getAttribute('aria-label')||'',checked:e.checked,disabled:e.disabled})));
 for(let i=0;i<descriptors.length;i++){const d=await fieldDescriptor(fields.nth(i));descriptors[i].question=d.label||d.ariaLabel;descriptors[i].label=d.optionLabel||descriptors[i].label;descriptors[i].description=d.description;descriptors[i].ambiguous=d.ambiguous;descriptors[i].contextRequired=d.contextRequired;}
 const groups=new Map();descriptors.forEach((o,index)=>{const key=o.form+':'+(o.name||'unnamed-'+index);if(!groups.has(key))groups.set(key,[]);groups.get(key).push({...o,index})});
 const answers=JSON.parse(p.answers_json||'{}');for(const options of groups.values()){
  if(options.some(o=>o.checked))continue;const selected=approvedHostedRadioIndex(options,answers,p);
  if(selected>=0){if(!authorizeResearchFill(j,p,options[selected].question))return false;const choice=fields.nth(options[selected].index);await choice.check();await choice.blur();if(!await choice.isChecked()){const error=Error('The employer form did not retain the selected answer.');error.code='HOSTED_INPUT_NOT_RETAINED';throw error;}}
 }
 return true;
}
async function checkboxes(page,p,j){
 const answers=JSON.parse(p.answers_json||'{}'),fields=page.locator('input[type="checkbox"]:visible');
 for(let i=0;i<await fields.count();i++){
  const field=fields.nth(i);if(await field.isChecked().catch(()=>false))continue;
  const descriptor=await fieldDescriptor(field),question=descriptor.label||descriptor.ariaLabel||descriptor.description||descriptor.name||descriptor.id;
  const approved=descriptor.ambiguous||descriptor.contextRequired||protectedHostedQuestion(question+' '+(descriptor.description||''))?null:approvedHostedCheckbox(question,answers);if(approved===true){if(!authorizeResearchFill(j,p,question))return false;await field.check();await field.blur();if(!await field.isChecked()){const error=Error('The employer form did not retain the selected answer.');error.code='HOSTED_INPUT_NOT_RETAINED';throw error;}}
 }
 return true;
}
async function customControls(page,p,j){
 const answers=JSON.parse(p.answers_json||'{}'),unresolved=[];
 const combos=page.locator('[role="combobox"]:not(select):visible');
 for(let i=0;i<await combos.count();i++){
  const control=combos.nth(i),descriptor=await fieldDescriptor(control),question=descriptor.label||descriptor.ariaLabel||descriptor.description||descriptor.name||descriptor.id;
  if(descriptor.ambiguous||descriptor.contextRequired){if(descriptor.required)unresolved.push(question);continue;}
  // Native multiple selects have an atomic adapter. Custom multi-selects do
  // not: never treat their first chip as the whole saved selection, or apply a
  // JSON/newline list through the single-option path.
  const canonical=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[?*✱]/g,'').replace(/\s+/g,' ').trim();
  const saved=Object.entries(answers).filter(([label])=>canonical(label)===canonical(question));
  let requested=null;if(saved.length===1){const value=saved[0][1];if(Array.isArray(value))requested=value;else if(typeof value==='string'){try{const parsed=JSON.parse(value);if(Array.isArray(parsed))requested=parsed;}catch{}if(!requested&&value.includes('\n'))requested=value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);}}
  if(requested&&requested.length>1){
   const selected=(descriptor.selectedValue||'').split('\n').map(canonical).filter(Boolean);
   const complete=requested.every(value=>typeof value==='string')&&new Set(requested.map(canonical)).size===requested.length&&selected.length===requested.length&&requested.every(value=>selected.includes(canonical(value)));
   await control.evaluate((e,incomplete)=>{if(incomplete)e.dataset.applypilotIncompleteSelection='true';else delete e.dataset.applypilotIncompleteSelection;},!complete);
   if(!complete&&descriptor.required)unresolved.push(question);
   continue;
  }
  if(descriptor.populated)continue;
  // A user's unfinished menu search is still their edit, even though it is
  // not a committed option. Resume only a query this worker owns.
  const userSearch=await control.evaluate(e=>e.matches('input')&&!!e.value&&e.dataset.applypilotUncommittedSearch!=='true');
  if(userSearch){if(descriptor.required)unresolved.push(question);continue;}
  if(!question||protectedHostedQuestion(question)&&!hostedFieldAnswer(descriptor,p,answers)){if(descriptor.required)unresolved.push(question||'Required selection');continue;}
  let scopeIds=await control.evaluate(e=>[...new Set(`${e.getAttribute('aria-controls')||''} ${e.getAttribute('aria-owns')||''}`.trim().split(/\s+/).filter(Boolean))]);
  const marker=`combo-${i}-${Date.now()}`,optionLocator=page.locator('[role="option"]:visible');
  await optionLocator.evaluateAll((xs,value)=>xs.forEach(x=>x.setAttribute('data-applypilot-visible-before-combobox',value)),marker);
  const clicked=await control.click().then(()=>true,()=>false);
  const trusted=hostedFieldAnswer(descriptor,p,answers);
  const query=clicked&&trusted&&['location','city','region','country'].includes(trusted.kind)&&await typeHostedSearch(control,trusted.answer)?trusted.answer:null;
  scopeIds=await control.evaluate(e=>[...new Set(`${e.getAttribute('aria-controls')||''} ${e.getAttribute('aria-owns')||''}`.trim().split(/\s+/).filter(Boolean))]);
  if(clicked)await page.waitForFunction(({ids,marker,query})=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'};const clean=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();return [...document.querySelectorAll('[role="option"]')].some(option=>visible(option)&&option.getAttribute('aria-disabled')!=='true'&&(!query||clean(option.innerText||option.textContent)===clean(query))&&(ids.some(id=>document.getElementById(id)?.contains(option))||(!ids.length&&option.getAttribute('data-applypilot-visible-before-combobox')!==marker)));},{ids:scopeIds,marker,query},{timeout:5000}).catch(()=>{});
  const rawOptions=await optionLocator.evaluateAll((xs,{ids,marker})=>{const groups=[];return xs.map((x,index)=>{const group=x.closest('[role="listbox"],[role="menu"],[role="tree"],[role="grid"]')||x.parentElement;let groupIndex=groups.indexOf(group);if(groupIndex<0){groups.push(group);groupIndex=groups.length-1;}return {index,label:(x.innerText||x.textContent||'').trim(),value:x.getAttribute('data-value')||x.getAttribute('value')||'',disabled:x.getAttribute('aria-disabled')==='true',scopeIds:ids.filter(id=>document.getElementById(id)?.contains(x)),newlyVisible:x.getAttribute('data-applypilot-visible-before-combobox')!==marker,group:String(groupIndex)};});},{ids:scopeIds,marker});
  const expanded=await control.getAttribute('aria-expanded')==='true',opened=clicked&&(expanded||rawOptions.some(option=>option.scopeIds.length||option.newlyVisible));
  const options=scopedHostedComboboxOptions(rawOptions,{scopeIds,opened});
  const choice=await prepareHostedDropdown(db,j,p,descriptor,options.map(o=>({...o,value:o.value||undefined})),answers);
  const currentOptions=await optionLocator.evaluateAll(xs=>xs.map((x,index)=>({index,label:(x.innerText||x.textContent||'').trim(),disabled:x.getAttribute('aria-disabled')==='true'})));
  const optionsChanged=options.some(o=>!currentOptions.some(c=>c.index===o.index&&c.label===o.label&&c.disabled===o.disabled));
  const currentDescriptor=await fieldDescriptor(control),nowPopulated=currentDescriptor.populated||!!(currentDescriptor.selectedValue&&currentDescriptor.selectedValue!==query);
  const searchChanged=await control.evaluate((e,query)=>e.matches('input')&&!!e.value&&e.value!==query,query);
  await page.locator('[data-applypilot-visible-before-combobox]').evaluateAll(xs=>xs.forEach(x=>x.removeAttribute('data-applypilot-visible-before-combobox'))).catch(()=>{});
  if(choice&&!optionsChanged&&!nowPopulated&&!searchChanged){if(!authorizeResearchFill(j,p,question))return {unresolved,withdrawn:true};await optionLocator.nth(choice.index).click();
   // Verify the committed label, not the text typed into a search input.
   // A failed/ignored click must remain an exact required-question blocker.
   let committed=false;for(let retry=0;retry<10;retry++){
    const selected=await fieldDescriptor(control);
    const expected=String(choice.label).replace(/\s+/g,' ').trim();
    const inputCommit=await control.evaluate((e,label)=>e.matches('input')&&e.value===label&&e.getAttribute('aria-expanded')!=='true',expected);
    if((selected.selectedValue===expected||inputCommit)&&await control.getAttribute('aria-expanded')!=='true'){committed=true;break;}
    await (typeof page.waitForTimeout==='function'?page:page.page()).waitForTimeout(75);
   }
   if(committed){await control.evaluate((e,label)=>{e.dataset.applypilotCommittedValue=label;delete e.dataset.applypilotUncommittedSearch;},String(choice.label).replace(/\s+/g,' ').trim());}
   else if(descriptor.required)unresolved.push(question);
   if(choice.aiPrepared)await control.evaluate(e=>e.dataset.applypilotApplicationOnly='true');}
  else {await control.press('Escape').catch(()=>{});if(descriptor.required)unresolved.push(question);}
 }
 const groups=page.locator('[role="radiogroup"]:visible');
 for(let i=0;i<await groups.count();i++){
  const group=groups.nth(i),descriptor=await fieldDescriptor(group),question=descriptor.label||descriptor.ariaLabel||descriptor.description||`Selection ${i+1}`,optionsLocator=group.locator('[role="radio"]:visible');
  if(await optionsLocator.evaluateAll(xs=>xs.some(x=>x.getAttribute('aria-checked')==='true')))continue;
  const options=await optionsLocator.evaluateAll((xs,q)=>xs.map((x,index)=>({index,question:q,label:(x.innerText||x.textContent||x.getAttribute('aria-label')||'').trim(),checked:x.getAttribute('aria-checked')==='true',disabled:x.getAttribute('aria-disabled')==='true'})),question),selected=approvedHostedRadioIndex(options.map(o=>({...o,description:descriptor.description,ambiguous:descriptor.ambiguous,contextRequired:descriptor.contextRequired})),answers,p);
  if(selected>=0){if(!authorizeResearchFill(j,p,question))return {unresolved,withdrawn:true};await optionsLocator.nth(selected).click();}else if(descriptor.required)unresolved.push(question);
 }
 await fillHostedButtonGroups(page,p,answers);
 const roles=page.locator('[role="checkbox"]:not(input):visible');
 for(let i=0;i<await roles.count();i++){
  const field=roles.nth(i);if(await field.getAttribute('aria-checked')==='true')continue;
  const descriptor=await fieldDescriptor(field),question=descriptor.label||descriptor.ariaLabel||descriptor.description||`Checkbox ${i+1}`,approved=descriptor.ambiguous||descriptor.contextRequired||protectedHostedQuestion(question+' '+(descriptor.description||''))?null:approvedHostedCheckbox(question,answers);
  if(approved===true){if(!authorizeResearchFill(j,p,question))return {unresolved,withdrawn:true};await field.click();}else if(descriptor.required)unresolved.push(question);
 }
 return {unresolved,withdrawn:false};
}
// Upload only a currently actionable, uniquely identified resume field. A
// resumed form or conditional rescan must never replace an applicant's file.
async function attachHostedResume(page,p){
 const files=page.locator('input[type="file"]');
 const fields=await files.evaluateAll(xs=>xs.map((e,index)=>{
  const wrapper=e.closest('.ashby-application-form-field-entry,.application-question,fieldset,[class*="upload" i],[class*="field" i]')||e.parentElement;
  const visible=node=>{if(!node)return false;const r=node.getBoundingClientRect(),s=getComputedStyle(node);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'&&!node.closest('[hidden],[aria-hidden="true"]');};
  return {index,active:!e.disabled&&!e.matches(':disabled')&&!e.closest('[hidden],[aria-hidden="true"]')&&(visible(e)||visible(wrapper)),label:[...e.labels||[]].map(l=>l.innerText).join(' '),id:e.id.replace(/[_-]/g,' '),name:e.name.replace(/[_-]/g,' '),context:wrapper?.querySelector('legend,label')?.innerText||''};
 }).filter(f=>f.active));
 if(!fields.length)return {attached:false};
 const selected=pickResumeField(fields);
 if(selected<0)return {issue:'Cannot identify a unique resume upload. Fields: '+fields.map(f=>f.label||f.id||f.name||'unlabelled upload').join('; ')};
 const file=files.nth(fields[selected].index);
 if(await file.evaluate(e=>!!e.files?.length||e.dataset.applypilotUploadAttempted==='true'))return {attached:false};
 await file.evaluate(e=>e.dataset.applypilotUploadAttempted='true');
 await file.setInputFiles(p.resume_path);
 const retained=await file.evaluate(e=>!!e.files?.length&&[...e.files].every(f=>f.size>0)).catch(()=>false);
 if(!retained)return {issue:'The employer did not retain the resume attachment. Review the upload before continuing.'};
 return {attached:true};
}

// Fill newly revealed questions without replaying uploads or overwriting edits.
// Two quiet seconds after the final change catches debounced validation and
// delayed conditional sections before a form is described as ready.
async function prepareHostedFields(page,p,job,wait){
 const final=page.getByRole?.('button',{name:/^(submit application|submit|send application|complete application)$/i});
 if(final&&await final.count()===1)await final.scrollIntoViewIfNeeded().catch(()=>{});
 let unknown=[],check=await review(page),filled=0,previous=check.signature||JSON.stringify([check.required,check.filled,check.missing]);
 for(let pass=0;pass<4;pass++){
  if(!sameApplication(page.url(),job.url)||typeof page.parentFrame==='function'&&page.parentFrame()&&!sameApplication(page.page().url(),job.url))return {identityChanged:true};
  if(check.captcha||check.signIn)return {check,unknown,filled};
  filled+=await fill(page,p);
  const upload=await attachHostedResume(page,p);if(upload.issue)return {check,unknown,filled,uploadIssue:upload.issue};
  if(upload.attached)event(job.id,'upload','Resume selected in the identified resume field; checking employer validation');
  if(!await selections(page,p,job)||!await radios(page,p,job)||!await checkboxes(page,p,job))return {withdrawn:true};
  const text=await custom(page,p,job);if(text.withdrawn)return {withdrawn:true};
  const controls=await customControls(page,p,job);if(controls.withdrawn)return {withdrawn:true};
  unknown=[...new Set([...text.unresolved,...controls.unresolved])];
  let stable=0,last=null;
  for(let settle=0;settle<20;settle++){
   await wait(250);check=await review(page);
   if(check.captcha||check.signIn)break;
   const key=check.signature||JSON.stringify([check.required,check.filled,check.missing]);
   stable=!check.pending&&key===last?stable+1:0;last=key;
   if(stable>=8)break;
  }
  if(stable<8&&!check.captcha&&!check.signIn)check.pending=true;
  const key=check.signature||JSON.stringify([check.required,check.filled,check.missing]);
  if(check.captcha||check.signIn||check.pending||key===previous)break;
  previous=key;
 }
 unknown=unknown.filter(question=>!check.questions||check.questions.includes(question));
 return {check,unknown,filled};
}
async function recordFormProgress(page,job){const {required,filled}=await page.evaluate(hostedFormState);saveFormProgress(db,job.id,{required,filled});}
async function rememberForm(page,job){
 const controls=page.locator('input:visible,textarea:visible,select:visible'),fields=[];
 for(let i=0;i<Math.min(await controls.count(),120);i++){
  const control=controls.nth(i),descriptor=await fieldDescriptor(control);
  if(descriptor.ambiguous||descriptor.contextRequired)continue;
  const eligible=await control.evaluate(e=>e.dataset.applypilotApplicationOnly!=='true'&&!['password','hidden','file','checkbox','submit','button'].includes(e.type)&&(e.type!=='radio'||e.checked));
  if(!eligible)continue;
  const value=await control.evaluate(e=>{
   if(e.dataset.applypilotApplicationOnly==='true'||['password','hidden','file','checkbox','submit','button'].includes(e.type)||e.type==='radio'&&!e.checked)return null;
   if(e.tagName==='SELECT'){const selected=[...e.selectedOptions].filter(o=>!o.disabled&&!o.closest('optgroup[disabled]')&&o.value&&!/^(?:select|choose)\b/i.test(o.textContent.trim())).map(o=>o.textContent.trim());return selected.length?(e.multiple?JSON.stringify(selected):selected[0]):null;}
   return e.type==='radio'?null:e.value;
  });
  const question=descriptor.label||descriptor.ariaLabel||'',answer=descriptor.type==='radio'?await control.isChecked()?descriptor.optionLabel:null:await control.getAttribute('role')==='combobox'?descriptor.populated?descriptor.selectedValue:null:value;
  if(question&&answer&&!protectedHostedQuestion(question+' '+(descriptor.description||'')))fields.push({question,answer});
 }

 captureAnswers(db,job,fields.filter(field=>!hasResearchDraftForQuestion(db,job.id,field.question)));
}
async function humanPause(job,page,p){
 // Fill only accessible fields. Playwright respects overlays and actionability.
 const filled=await fill(page,p).catch(()=>0);if(filled)event(job.id,'filled',`Filled ${filled} contact fields before human handoff`);
 try{const upload=await attachHostedResume(page,p);if(upload.attached)event(job.id,'upload','Resume selected before human handoff');}catch{}
 await recordFormProgress(page,job).catch(()=>{});
 set(job,'paused','Human verification required','CAPTCHA');
}
let handoffs,resumeQueue=[];
async function run(job,browser,resumed=null){const held=employerHold(db,job);if(held)return set(job,'needs_review',held.message,'Employer application limit');let p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(job.applicant_id,job.user_id);if(p)p={...p,employment_context:employmentContext(p,job,currentSearchScope(db,job)),answers_json:JSON.stringify({...reusableAnswers(db,p),...JSON.parse(job.answers_json||'{}')})};if(!p?.consent||!p.email||!p.resume_path)return set(job,'needs_review','Profile needs consent, email and resume');if(researchConsentWithdrawn(db,job.id,p.id))return set(job,'needs_review','Google public job-page drafting consent was withdrawn','Research consent withdrawn');if(!hostAllowed(job.url))return set(job,'needs_review','Use a supported direct employer application link');let context=resumed?.context||await browser.newContext({acceptDownloads:false,locale:'en-CA',viewport:{width:1100,height:800}});let page=resumed?.page||await context.newPage();const browserPage=page;browserPage.setDefaultTimeout(5000);if(!resumed&&!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type='completion_tracking'").get(job.id))event(job.id,'completion_tracking','Hosted form tracking started before application preparation.');try{if(!resumed){const navigation=await page.goto(job.url,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1200);const issue=await pageIssue(page,navigation?.status());if(issue)return set(job,'needs_review',issue.message+' The application was not submitted. Try this employer later.','Employer site unavailable');}if(applicationLimit(await page.locator('body').innerText())){recordEmployerLimit(db,job.user_id,job.id,await page.locator('body').innerText(),{source:'Employer page observed by hosted worker'});return set(job,'needs_review','Employer application limit reached. Other employers can continue.','Employer application limit');}if(!sameApplication(page.url(),job.url))return set(job,'needs_review','Employer redirected to a different or unsupported application','Application identity changed');let check=await review(page);db.prepare('UPDATE jobs SET required_fields_json=? WHERE id=?').run(JSON.stringify(check.missing),job.id);if(check.captcha)return await humanPause(job,page,p);if(check.signIn)return set(job,'paused','Sign-in required','Sign-in');const landing=await page.locator('input:visible,textarea:visible,select:visible,[role="combobox"]:visible').count()===0;let apply=page.getByRole('button',{name:/^(apply|apply now|apply for this job)$/i});let applyLink=page.getByRole('link',{name:/^apply for this job$/i});if(!resumed&&landing&&await apply.count()===1){await apply.click();await page.waitForTimeout(800);if(!sameApplication(page.url(),job.url))return set(job,'needs_review','Application redirected to a different or unsupported job','Application identity changed')}else if(!resumed&&landing&&await applyLink.count()){let urls=await applyLink.evaluateAll(links=>[...new Set(links.map(link=>link.href))]);if(urls.length!==1||!sameApplication(urls[0],job.url))return set(job,'needs_review','Application link needs review');await applyLink.first().click();await page.waitForTimeout(800);if(!sameApplication(page.url(),job.url))return set(job,'needs_review','Application redirected to a different or unsupported job','Application identity changed')}
// Locate an application embedded in a supported employer frame.
const scopes=[];for(const frame of browserPage.frames()){
 if(!sameApplication(frame.url(),job.url))continue;
 const inputs=await frame.locator('input[type="email"]:visible,input[name*="first" i]:visible,input[name*="name" i]:visible').count();
 const uploads=await frame.locator('input[type="file"]').count();
 if(inputs&&uploads)scopes.push(frame);
}
if(scopes.length>1)return set(job,'needs_review','Several application forms were found. Open the employer form to choose the correct one.','Ambiguous form');
if(scopes.length===1){page=scopes[0];if(page!==browserPage.mainFrame())event(job.id,'form','Located embedded employer application');}
check=await review(page);db.prepare('UPDATE jobs SET required_fields_json=? WHERE id=?').run(JSON.stringify(check.missing),job.id);if(check.captcha)return await humanPause(job,page,p);if(check.signIn)return set(job,'paused','Sign-in required','Sign-in');
for(let step=0;step<15;step++){
if(!inActiveBatch(db,job)||db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id)?.status==='archived')return;
const focusedNow=db.prepare('SELECT job_id FROM work_focus WHERE user_id=? AND enabled=1').get(job.user_id);if(focusedNow&&focusedNow.job_id!==job.id)return set(job,'needs_review','Parked while the selected application completes.','Parked');
const heldNow=employerHold(db,job);if(heldNow)return set(job,'needs_review',heldNow.message,'Employer application limit');
const limitText=await page.locator('body').innerText();if(applicationLimit(limitText)){recordEmployerLimit(db,job.user_id,job.id,limitText,{source:'Employer page observed by hosted worker'});return set(job,'needs_review','Employer application limit reached. Other employers can continue.','Employer application limit');}
const issue=await pageIssue(page);if(issue)return set(job,'needs_review',issue.message+' Review this employer page before continuing.','Employer site unavailable');
const freshResearch=db.prepare('SELECT google_research_consent FROM applicants WHERE id=? AND user_id=?').get(p.id,job.user_id);p.google_research_consent=freshResearch?.google_research_consent?1:0;
if(researchConsentWithdrawn(db,job.id,p.id))return set(job,'needs_review','Google public job-page drafting consent was withdrawn','Research consent withdrawn');
if(!sameApplication(page.url(),job.url))return set(job,'needs_review','Application redirected to a different or unsupported job','Application identity changed');
if(await page.locator('input[autocomplete=one-time-code]:visible,input[type=password]:visible').count())return set(job,'paused','Sign-in or MFA requires you','Sign-in');
const preparation=await prepareHostedFields(page,p,job,ms=>browserPage.waitForTimeout(ms));
if(preparation.identityChanged)return set(job,'needs_review','Application redirected to a different or unsupported job','Application identity changed');
if(preparation.withdrawn)return set(job,'needs_review','Google public job-page drafting consent was withdrawn','Research consent withdrawn');
if(preparation.uploadIssue)return set(job,'needs_review',preparation.uploadIssue,'Upload needs review');
event(job.id,'filled',`Filled ${preparation.filled} standard fields`);
let unknown=preparation.unknown;check=preparation.check;const requiredMissing=[...new Set([...check.missing,...unknown])];await recordFormProgress(page,job);db.prepare('UPDATE jobs SET required_fields_json=? WHERE id=?').run(JSON.stringify(requiredMissing),job.id);if(check.captcha)return await humanPause(job,page,p);if(check.signIn)return set(job,'paused','Sign-in required','Sign-in');if(check.pending)return set(job,'needs_review','The employer form is still validating. Review it before continuing.','Form validation');if(requiredMissing.length){const protectedMissing=requiredMissing.filter(protectedHostedQuestion);return set(job,'needs_review',`${protectedMissing.length?'Protected questions need you':'Missing required fields'}: ${requiredMissing.slice(0,8).join('; ')}`,protectedMissing.length?'Sensitive action':'Missing answers');}const radioState=await page.locator('input[type=radio]:visible').evaluateAll(radios=>radios.map(r=>({form:[...document.forms].indexOf(r.form),name:r.name||'',question:r.closest('fieldset')?.querySelector('legend')?.innerText||'',required:r.required||r.getAttribute('aria-required')==='true'||r.closest('fieldset')?.getAttribute('aria-required')==='true',checked:r.checked}))),unanswered=requiredUnansweredRadioGroups(radioState);if(unanswered.length)return set(job,'needs_review',`Unanswered selection questions: ${unanswered.slice(0,8).join('; ')}`,'Missing answers');let submit=page.getByRole('button',{name:/^(submit application|submit|send application|complete application)$/i});const next=page.getByRole('button',{name:/^(next|next step|continue|continue application|save (?:and|&) continue|review|review application|proceed)$/i});
if(await next.count()===1&&await submit.count()===0){
 if(researchConsentWithdrawn(db,job.id,p.id))return set(job,'needs_review','Google public job-page drafting consent was withdrawn','Research consent withdrawn');
 await rememberForm(page,job);const before=await page.locator('body').innerText();await next.click();let advanced=false;for(let settle=0;settle<8;settle++){await browserPage.waitForTimeout(300);if(await page.locator('body').innerText()!==before){advanced=true;break;}}
 if(!advanced)return set(job,'needs_review','Application did not advance; check validation','Form validation');
 event(job.id,'step','Completed application step '+(step+1));continue;
}
if(await submit.count()!==1||await next.count()>0)return set(job,'needs_review',`Submit button not recognized${unknown.length?`; required questions: ${unknown.slice(0,4).join('; ')}`:''}`,'Unfamiliar form');if(!await submit.isEnabled()&&!focusAllowsSubmit(db,job))return set(job,'needs_review','The employer has not enabled Submit. Review the form validation before continuing.','Form validation');if(researchConsentWithdrawn(db,job.id,p.id))return set(job,'needs_review','Google public job-page drafting consent was withdrawn','Research consent withdrawn');const current=db.prepare('SELECT consent FROM applicants WHERE id=?').get(p.id);if(!current?.consent)return set(job,'needs_review','Consent was withdrawn');await rememberForm(page,job);const finalHold=employerHold(db,job);if(finalHold)return set(job,'needs_review',finalHold.message,'Employer application limit');if(focusAllowsSubmit(db,job)){
 const result=await submitHostedApplication({page,job,submit,review,
  reserve:()=>reserveAutonomousAttempt(db,job.id,job.user_id,'hosted-worker'),
  wait:ms=>browserPage.waitForTimeout(ms),
  recordLimit:text=>recordEmployerLimit(db,job.user_id,job.id,text,{source:'Employer response after automatic attempt'}),
  recordDiagnostic:message=>event(job.id,'submission_diagnostic',message)});
 if(result.status==='submitted')confirmLibrary(db,job);
 return set(job,result.status,result.message,result.challenge||null,result.confirmation||null);
}
event(job.id,'prepared','All supported fields are filled. The applicant must make the final submission.');return set(job,'needs_review','Ready to submit — review the filled application and click Submit.','Ready to submit');
}
return set(job,'needs_review','Application exceeded the 15-step limit','Step limit');
}catch(e){set(job,'needs_review',`Worker stopped: ${String(e.message).slice(0,350)}`,db.prepare('SELECT challenge FROM jobs WHERE id=?').get(job.id)?.challenge==='Submission in progress'?'Unconfirmed submission':e.code==='HOSTED_INPUT_NOT_RETAINED'?'Form validation':'Worker error')}finally{
 const state=db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
 const focus=db.prepare('SELECT skip_blocked FROM work_focus WHERE user_id=? AND enabled=1 AND auto_submit=1').get(job.user_id);
 const attempted=!!state?.local_attempt_at||!!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submission_started','manual_submission','applicant_reported_submission') LIMIT 1").get(job.id);
 if(retainBlockedSession({...state,attempted,skipBlocked:!!focus?.skip_blocked})&&!browserPage.isClosed()){
  const held=await handoffs.hold({...job,...state},context,browserPage);db.prepare('UPDATE jobs SET handoff_available=? WHERE id=?').run(held===false?0:1,job.id);
  if(held!==false)event(job.id,'handoff','Live browser ready. Take over to continue in the same form.');
 }else{
  await context.close();db.prepare('UPDATE jobs SET handoff_available=0 WHERE id=?').run(job.id);
  if(focus?.skip_blocked&&!attempted&&['paused','needs_review'].includes(state?.status))event(job.id,'handoff_closed','Blocked before submission. Browser closed so other jobs can continue; resolve saved blockers before preparing again.');
 }
}}
async function main(){recoverWorkerJobs();let browser=await chromium.launch({headless:true});console.log('ApplyPilot worker running');
 db.prepare('UPDATE jobs SET handoff_available=0').run();
 handoffs=new Handoffs({
  onDiagnostic:(job,message)=>event(job.id,'submission_diagnostic',message),
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
 });serveHandoffs(handoffs,8081,token=>readToken(token,db));const heartbeat=()=>db.prepare('INSERT INTO worker_status VALUES(1,?) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat').run(now());heartbeat();setInterval(heartbeat,10000);let discoveryBusy=false;async function discoveryTick(){if(discoveryBusy)return;discoveryBusy=true;try{await runDueSearches()}catch(e){console.error('Discovery:',e)}finally{discoveryBusy=false}}setInterval(discoveryTick,60000);discoveryTick();process.on('SIGTERM',async()=>{await browser.close();process.exit(0)});for(;;){await handoffs.expire();await releaseSkippedHandoffs(handoffs,job=>{
 const focus=db.prepare('SELECT skip_blocked FROM work_focus WHERE user_id=? AND enabled=1 AND auto_submit=1').get(job.user_id);
 if(!focus?.skip_blocked)return false;
 const state=db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
 if(!state||!['paused','needs_review'].includes(state.status))return false;
 const attempted=!!state.local_attempt_at||!!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submission_started','manual_submission','applicant_reported_submission') LIMIT 1").get(job.id);
 return !retainBlockedSession({...state,attempted,skipBlocked:true});
 });const resume=resumeQueue.shift();if(resume){await run(resume.job,browser,resume.session);continue}let j=claim();if(j)await run(j,browser);else await sleep(3000)}}main().catch(e=>{console.error(e);process.exit(1)});
