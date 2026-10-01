import {installLibrary,reusableAnswers,captureAnswers,confirmLibrary} from './answer-library.js';
import {draftForJob,installDrafts} from './answer-drafts.js';
import {supported as hostAllowed,sensitive,savedAnswer} from './local-policy.js';
import {requiresHumanReview} from './review-policy.js';
import {recoverWorkerJobs} from './local-state.js';
import {Handoffs,serveHandoffs} from './handoff.js';
import {pickResumeField,approvedRadioIndex} from './form-policy.js';
import {chromium} from 'playwright';import {db,event,now} from './db.js';
import {runDueSearches} from './discovery.js';
installLibrary(db);
installDrafts(db);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function set(job,status,message,challenge=null,confirmation=null){db.prepare('UPDATE jobs SET status=?,challenge=?,confirmation=?,updated_at=? WHERE id=?').run(status,challenge,confirmation,now(),job.id);event(job.id,status,message)}
function claim(){db.exec('BEGIN IMMEDIATE');try{let j=db.prepare("SELECT * FROM jobs WHERE status='queued' AND applicant_id IN (SELECT id FROM applicants WHERE execution_mode='cloud') ORDER BY discovery_priority,created_at LIMIT 1").get();if(j){db.prepare("UPDATE jobs SET status='running',attempts=attempts+1,lease_at=?,updated_at=? WHERE id=?").run(now(),now(),j.id);event(j.id,'running','Opening employer application')}db.exec('COMMIT');return j}catch(e){db.exec('ROLLBACK');throw e}}
async function field(page,labels){
 const controls=page.locator('input:visible,textarea:visible');
 const candidates=await controls.evaluateAll(xs=>xs.map(e=>[(e.labels?.[0]?.innerText||e.getAttribute('aria-label')||e.name||e.placeholder||'')]));
 const norm=s=>String(s).trim().replace(/\s*[*✱]$/,'').replace(/\s+/g,' ').toLowerCase();
 const hits=candidates.map((values,i)=>values.some(v=>labels.some(l=>norm(v)===norm(l)))?i:-1).filter(i=>i>=0);
 return hits.length===1?controls.nth(hits[0]):null;
}
async function fill(page,p){let n=0;for(let [labels,value] of [[['First name','first_name','firstName'],p.name.split(/\s+/)[0]],[['Last name','last_name','lastName'],p.name.split(/\s+/).slice(1).join(' ')],[['Full name','Your name','Name'],p.name],[['Email','email'],p.email],[['Phone','phone'],p.phone],[['Location','Current location'],p.location]]){if(!value)continue;let l=await field(page,labels);if(!l)continue;let type=await l.getAttribute('type');if(['file','radio','checkbox','hidden'].includes(type))continue;if(await l.inputValue().catch(()=>'')!=='')continue;await l.fill(value);n++}return n}
async function review(page){return page.evaluate(()=>{let captcha=[...document.querySelectorAll('iframe[src*="captcha"],iframe[title*="challenge" i],.g-recaptcha,.h-captcha')].some(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>5&&r.height>5&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'});if([...document.querySelectorAll('[name="g-recaptcha-response"],[name="h-captcha-response"]')].some(e=>e.value?.trim()))captcha=false;let signIn=!!document.querySelector('input[type="password"]');let missing=[...document.querySelectorAll('input:required,textarea:required,select:required,[aria-required="true"]')].filter(e=>{if(!e.getClientRects().length)return false;if(e.type==='file')return !e.files?.length;if(e.type==='radio')return ![...document.querySelectorAll('input[type="radio"]')].some(other=>other.name===e.name&&other.form===e.form&&other.checked);if(e.type==='checkbox')return !e.checked;return !e.value}).map(e=>(e.type==='radio'?e.closest('fieldset')?.querySelector('legend')?.innerText:null)||e.labels?.[0]?.innerText?.trim()||e.getAttribute('aria-label')||e.name||'Required field');return {captcha,signIn,missing:[...new Set(missing)]}})}
async function custom(page,p,j){let answers=JSON.parse(p.answers_json||'{}'),inputs=page.locator('textarea:visible,input[type="text"]:visible,input:not([type]):visible'),n=await inputs.count(),unresolved=[];for(let i=0;i<Math.min(n,50);i++){let l=inputs.nth(i);if(await l.inputValue().catch(()=>'')!=='')continue;let q=await l.evaluate(e=>(e.labels?.[0]?.innerText||e.getAttribute('aria-label')||e.placeholder||'').trim().replace(/\s+/g,' ').slice(0,240));if(!q)continue;let a=savedAnswer(q,answers);if((a===null||a===undefined||a==='')&&p.ai_consent){try{const draft=await draftForJob(db,j.user_id,j.id,q);if(draft.answer?.trim()){a=draft.answer.trim();event(j.id,'ai_draft',`AI filled a fact-grounded draft for: ${q}`)}}catch{}}if(a!==null&&a!==undefined&&a!==''){await l.fill(String(a));event(j.id,'answer',`Answered: ${q}`)}else unresolved.push(q)}return unresolved}
async function selections(page,p){
 const answers=JSON.parse(p.answers_json||'{}');
 const normalize=s=>String(s).trim().replace(/\s+/g,' ').replace(/\s*\*$/,'').toLowerCase();
 const selects=page.locator('select:visible');
 for(let i=0;i<await selects.count();i++){
  const el=selects.nth(i),q=await el.evaluate(e=>e.labels?.[0]?.innerText||e.getAttribute('aria-label')||'');
  const key=Object.keys(answers).find(k=>normalize(k)===normalize(q));if(!key||sensitive(q))continue;
  const options=await el.locator('option').evaluateAll(xs=>xs.map(x=>({label:x.textContent,value:x.value,disabled:x.disabled})));
  const choices=options.filter(x=>!x.disabled&&(normalize(x.label)===normalize(answers[key])||x.value===String(answers[key])));
  if(choices.length===1)await el.selectOption(choices[0].value);
 }
}
async function radios(page,p){
 const fields=page.locator('input[type="radio"]:visible');
 const descriptors=await fields.evaluateAll(xs=>xs.map(e=>({name:e.name,form:[...document.forms].indexOf(e.form),question:e.closest('fieldset')?.querySelector('legend')?.innerText?.trim()||'',label:e.labels?.[0]?.innerText?.trim()||e.getAttribute('aria-label')||'',checked:e.checked})));
 const groups=new Map();descriptors.forEach((o,index)=>{const key=o.form+':'+o.name;if(!groups.has(key))groups.set(key,[]);groups.get(key).push({...o,index})});
 const answers=JSON.parse(p.answers_json||'{}');for(const options of groups.values()){
  if(options.some(o=>o.checked||sensitive(o.question)))continue;const selected=approvedRadioIndex(options,answers);
  if(selected>=0)await fields.nth(options[selected].index).check();
 }
}
async function rememberForm(page,job){
 const fields=await page.locator('input:visible,textarea:visible,select:visible').evaluateAll(xs=>xs.filter(e=>!['password','hidden','file','checkbox','submit','button'].includes(e.type)&&(e.type!=='radio'||e.checked)).map(e=>({question:(e.type==='radio'?e.closest('fieldset')?.querySelector('legend')?.innerText:null)||e.labels?.[0]?.innerText||e.getAttribute('aria-label')||'',answer:e.tagName==='SELECT'?e.selectedOptions?.[0]?.textContent:e.type==='radio'?(e.labels?.[0]?.innerText||''):e.value})).filter(f=>f.question&&f.answer).slice(0,120));
 captureAnswers(db,job,fields);
}
async function humanPause(job,page,p){
 // Fill only accessible fields. Playwright respects overlays and actionability.
 const filled=await fill(page,p).catch(()=>0);if(filled)event(job.id,'filled',`Filled ${filled} contact fields before human handoff`);
 try{const files=page.locator('input[type="file"]');const fields=await files.evaluateAll(xs=>xs.map(e=>({label:[...e.labels||[]].map(l=>l.innerText).join(' '),id:e.id.replace(/[_-]/g,' '),name:e.name.replace(/[_-]/g,' ')})));const selected=pickResumeField(fields);if(selected>=0){await files.nth(selected).setInputFiles(p.resume_path);event(job.id,'upload','Resume attached before human handoff');}}catch{}
 set(job,'paused','Human verification required','CAPTCHA');
}
let handoffs,resumeQueue=[];
async function run(job,browser,resumed=null){let p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(job.applicant_id,job.user_id);if(p)p={...p,answers_json:JSON.stringify({...reusableAnswers(db,p),...JSON.parse(job.answers_json||'{}')})};if(!p?.consent||!p.email||!p.resume_path)return set(job,'needs_review','Profile needs consent, email and resume');if(!hostAllowed(job.url))return set(job,'needs_review','Use a supported direct employer application link');let context=resumed?.context||await browser.newContext({acceptDownloads:false,locale:'en-CA',viewport:{width:1100,height:800}});let page=resumed?.page||await context.newPage();const browserPage=page;browserPage.setDefaultTimeout(5000);try{if(!resumed){await page.goto(job.url,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1200);}if(!hostAllowed(page.url()))return set(job,'needs_review','Employer redirected to a website that needs review');let check=await review(page);db.prepare('UPDATE jobs SET required_fields_json=? WHERE id=?').run(JSON.stringify(check.missing),job.id);if(check.captcha)return await humanPause(job,page,p);if(check.signIn)return set(job,'paused','Sign-in required','Sign-in');if(requiresHumanReview(await page.locator('body').innerText()))return set(job,'needs_review','Sensitive statement requires your interaction','Sensitive action');const landing=await page.locator('input:visible,textarea:visible,select:visible').count()===0;let apply=page.getByRole('button',{name:/^(apply|apply now|apply for this job)$/i});let applyLink=page.getByRole('link',{name:/^apply for this job$/i});if(!resumed&&landing&&await apply.count()===1){await apply.click();await page.waitForTimeout(800);if(!hostAllowed(page.url()))return set(job,'needs_review','Application redirected to an unsupported site')}else if(!resumed&&landing&&await applyLink.count()){let urls=await applyLink.evaluateAll(links=>[...new Set(links.map(link=>link.href))]);if(urls.length!==1||!hostAllowed(urls[0]))return set(job,'needs_review','Application link needs review');await applyLink.first().click();await page.waitForTimeout(800);if(!hostAllowed(page.url()))return set(job,'needs_review','Application redirected to an unsupported site')}
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
if(!hostAllowed(page.url()))return set(job,'needs_review','Application redirected outside supported employers','Unsupported redirect');
if(await page.locator('[role=combobox]:not(select):not(input):visible,[role=checkbox]:not(input):visible').count())return set(job,'needs_review','Custom controls require review','Unfamiliar form');
if(requiresHumanReview(await page.locator('body').innerText()))return set(job,'needs_review','Sensitive statement, payment or legal attestation requires your interaction','Sensitive action');
if(await page.locator('input[autocomplete=one-time-code]:visible,input[type=password]:visible').count())return set(job,'paused','Sign-in or MFA requires you','Sign-in');
let filled=await fill(page,p);event(job.id,'filled',`Filled ${filled} standard fields`);let file=page.locator('input[type="file"]'),count=await file.count();if(count){
const fields=await file.evaluateAll(xs=>xs.map(e=>({label:[...e.labels||[]].map(l=>l.innerText).join(' '),id:e.id.replace(/[_-]/g,' '),name:e.name.replace(/[_-]/g,' '),context:(e.closest('fieldset')?.querySelector('legend')?.innerText||e.parentElement?.querySelector('label')?.innerText||'')})));
const selected=pickResumeField(fields);
if(selected<0)return set(job,'needs_review','Cannot identify a unique resume upload. Fields: '+fields.map(f=>f.label||f.id||f.name||'unlabelled upload').join('; '),'Upload needs review');
await file.nth(selected).setInputFiles(p.resume_path);uploaded=true;event(job.id,'upload','Resume attached to identified resume field');
}await selections(page,p);await radios(page,p);let unknown=await custom(page,p,job);check=await review(page);db.prepare('UPDATE jobs SET required_fields_json=? WHERE id=?').run(JSON.stringify(check.missing),job.id);if(check.captcha)return await humanPause(job,page,p);if(check.signIn)return set(job,'paused','Sign-in required','Sign-in');if(check.missing.length)return set(job,'needs_review',`Missing required fields: ${check.missing.slice(0,8).join('; ')}`,'Missing answers');let unanswered=await page.locator('input[type=radio]:visible').evaluateAll(radios=>[...new Set(radios.filter(r=>!document.querySelector(`input[type=radio][name=\"${CSS.escape(r.name)}\"]:checked`)).map(r=>r.name||'Radio question'))]);if(unanswered.length)return set(job,'needs_review',`Unanswered selection questions: ${unanswered.slice(0,8).join('; ')}`,'Missing answers');let submit=page.getByRole('button',{name:/^(submit application|submit|send application)$/i});const next=page.getByRole('button',{name:/^(next|continue|save and continue|review application)$/i});
if(await next.count()===1&&await submit.count()===0){
 await rememberForm(page,job);const before=await page.locator('body').innerText();await next.click();await browserPage.waitForTimeout(1200);
 if(await page.locator('body').innerText()===before)return set(job,'needs_review','Application did not advance; check validation','Form validation');
 event(job.id,'step','Completed application step '+(step+1));continue;
}
if(!uploaded&&!resumed)return set(job,'needs_review','Resume upload was not identified','Upload needs review');
if(await submit.count()!==1||await next.count()>0)return set(job,'needs_review',`Submit button not recognized${unknown.length?`; questions: ${unknown.slice(0,4).join('; ')}`:''}`);if(requiresHumanReview(await page.locator('body').innerText()))return set(job,'needs_review','Legal or sensitive statement requires you','Sensitive action');const current=db.prepare('SELECT consent FROM applicants WHERE id=?').get(p.id);if(!current?.consent)return set(job,'needs_review','Consent was withdrawn');set(job,'running','About to submit; automatic retry disabled','Submission in progress');const receiptPattern=/thank you for (applying|your application)|application (has been )?(submitted|received)|successfully applied/i;
await rememberForm(page,job);const before=(await page.locator('body').innerText()).slice(0,20000);await submit.click();
let confirmed=false;for(let attempt=0;attempt<10;attempt++){
 await browserPage.waitForTimeout(1000);
 const content=await page.locator('body').innerText({timeout:3000}).catch(()=>'');
 if(hostAllowed(page.url())&&!receiptPattern.test(before)&&receiptPattern.test(content)){confirmed=true;break;}
}
if(confirmed){confirmLibrary(db,job);return set(job,'submitted','Employer confirmed receipt',null,'Confirmation page');}return set(job,'needs_review','Submit clicked but receipt was not confirmed. Check employer site before retrying.','Unconfirmed submission');
}
return set(job,'needs_review','Application exceeded the 15-step limit','Step limit');
}catch(e){set(job,'needs_review',`Worker stopped: ${String(e.message).slice(0,350)}`,db.prepare('SELECT challenge FROM jobs WHERE id=?').get(job.id)?.challenge==='Submission in progress'?'Unconfirmed submission':'Worker error')}finally{
 const state=db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id);
 if(['paused','needs_review'].includes(state?.status)&&!browserPage.isClosed()){
  const held=await handoffs.hold({...job,...db.prepare('SELECT challenge FROM jobs WHERE id=?').get(job.id)},context,browserPage);db.prepare('UPDATE jobs SET handoff_available=? WHERE id=?').run(held===false?0:1,job.id);event(job.id,'handoff','Live browser ready. Take over to continue in the same form.');
 }else await context.close();
}}
async function main(){recoverWorkerJobs();let browser=await chromium.launch({headless:true});console.log('ApplyPilot worker running');
 db.prepare('UPDATE jobs SET handoff_available=0').run();
 handoffs=new Handoffs({
  onClose:(job,message)=>{db.prepare('UPDATE jobs SET handoff_available=0 WHERE id=?').run(job.id);event(job.id,'handoff_closed',message)},
  onPossibleSubmit:job=>{db.prepare("UPDATE jobs SET challenge='Unconfirmed submission',updated_at=? WHERE id=?").run(now(),job.id)},
  onSubmitted:job=>{set(job,'submitted','Employer confirmed receipt during human handoff',null,'Employer confirmation in live browser');db.prepare('UPDATE jobs SET handoff_available=0 WHERE id=?').run(job.id)},
  onResume:async(job,session)=>{
   const current=db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
   if(!['paused','needs_review'].includes(current?.status)||['Unconfirmed submission','Submission in progress'].includes(current.challenge))throw Error('Check the employer receipt before resuming. A submission may already have occurred.');
   const applicant=db.prepare('SELECT consent FROM applicants WHERE id=?').get(job.applicant_id);if(!applicant?.consent)throw Error('Applicant consent is required');
   db.prepare("UPDATE jobs SET status='running',handoff_available=0,challenge=NULL,updated_at=? WHERE id=?").run(now(),job.id);
   event(job.id,'resumed','Applicant returned the same browser to the worker');resumeQueue.push({job:current,session});
  }
 });serveHandoffs(handoffs);const heartbeat=()=>db.prepare('INSERT INTO worker_status VALUES(1,?) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat').run(now());heartbeat();setInterval(heartbeat,10000);let discoveryBusy=false;async function discoveryTick(){if(discoveryBusy)return;discoveryBusy=true;try{await runDueSearches()}catch(e){console.error('Discovery:',e)}finally{discoveryBusy=false}}setInterval(discoveryTick,60000);discoveryTick();process.on('SIGTERM',async()=>{await browser.close();process.exit(0)});for(;;){await handoffs.expire();const resume=resumeQueue.shift();if(resume){await run(resume.job,browser,resume.session);continue}let j=claim();if(j)await run(j,browser);else await sleep(3000)}}main().catch(e=>{console.error(e);process.exit(1)});
