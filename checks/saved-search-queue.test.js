import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installBatches} from '../application-batches.js';
import {installSingleApplication,inFlightApplication,receiptConfirmed,startOneApplication,ensureFocusedJob,useSavedSearchQueue,savedSearchQueueState,setWorkFocus,focusSnapshot,savedSearchClaimProblem,reserveAutonomousAttempt} from '../single-application.js';
import {normalizeSearchScope,scopeIntent} from '../search-scope.js';
import {jobIntelligence} from '../job-intelligence.js';
const scope=normalizeSearchScope({roles:['Platform Engineer'],localPlaces:['ontario'],remotePlaces:['canada'],remoteFromCountry:'canada',authorizedCountries:['canada'],allowEmploymentFallback:true,preferRemote:true});
test('one-job preparation cannot reserve a Submit and remains selected for applicant review',()=>{
 const {db,add}=fixture();useSavedSearchQueue(db,'u',{applicant_id:'p'});add('manual');add('later');
 const f=startOneApplication(db,'u','manual',{auto_submit:false});assert.equal(f.enabled,true);assert.equal(f.auto_submit,false);assert.equal(f.stop_after_receipt,true);
 db.exec("UPDATE jobs SET status='running' WHERE id='manual'");
 assert.throws(()=>reserveAutonomousAttempt(db,'manual','u','hosted-worker'),/not enabled/);
 db.exec("UPDATE jobs SET status='needs_review',challenge='Ready to submit',handoff_available=1 WHERE id='manual'");
 assert.equal(ensureFocusedJob(db,'u').job_id,'manual');assert.equal(ensureFocusedJob(db,'u').auto_submit,false);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM autonomous_attempts').get().n,0);db.close();
});
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id,applicant_id,company,title,url,normalized_url,status,local_owner,local_attempt_at,local_phase,challenge,confirmation,attempts DEFAULT 0,handoff_available DEFAULT 0,match_score DEFAULT 90,created_at,updated_at,job_metadata_json DEFAULT '{}');CREATE TABLE applicants(id,user_id,consent,email,resume_path,execution_mode,focus);CREATE TABLE events(job_id,at,type,message);CREATE TABLE external_application_history(id,user_id,company,title,status,company_key,title_key);CREATE TABLE research_draft_usage(job_id,question);CREATE TABLE searches(id,user_id,applicant_id,enabled,instruction,created_at,scope_json);CREATE TABLE employer_limits(user_id,applicant_id,employer_key,hold_until,message);INSERT INTO applicants VALUES('p','u',1,'fixture@example.test','fixture.pdf','cloud','Platform Engineer'),('p2','u2',1,'other@example.test','other.pdf','cloud','Platform Engineer');`);
 installBatches(db);installSingleApplication(db);
 db.prepare('INSERT INTO searches VALUES(?,?,?,?,?,?,?)').run('s','u','p',1,'Grouped roles','2026',JSON.stringify(scope));
 db.exec("INSERT INTO application_batch_preferences VALUES('u','p',1,'old',120000,'','2026'),('u2','p2',1,'other',120000,'','2026');INSERT INTO work_focus(user_id,enabled,job_id,auto_submit,skip_blocked) VALUES('u',1,'old0',0,1),('u2',1,'other',0,1)");
 function add(id,extra={}){const j={user_id:'u',applicant_id:'p',status:'saved',location:'Toronto, Ontario',remote:false,description:'Full-time employment.',...extra};const m=jobIntelligence({title:'Platform Engineer',...j},scopeIntent(scope));db.prepare("INSERT INTO jobs(id,user_id,applicant_id,company,title,url,normalized_url,status,created_at,job_metadata_json) VALUES(?,?,?,?,'Platform Engineer',?,?,?,'2026',?)").run(id,j.user_id,j.applicant_id,id,'https://jobs.lever.co/'+id+'/role','https://jobs.lever.co/'+id+'/role',j.status,JSON.stringify(m));}
 for(let n=0;n<20;n++){add('old'+n,{status:n<9?'needs_review':'submitted'});db.prepare('INSERT INTO application_batch_members VALUES(?,?,?,?)').run('old','old'+n,'u',n);if(n<9)db.prepare("UPDATE jobs SET attempts=1,local_attempt_at='2026',local_phase='uncertain',challenge='Unconfirmed submission' WHERE id=?").run('old'+n);else {db.prepare("UPDATE jobs SET confirmation='Employer received application' WHERE id=?").run('old'+n);db.prepare("INSERT INTO events VALUES(?,'2026','submitted','Receipt')").run('old'+n);}}
 add('other',{user_id:'u2',applicant_id:'p2'});return {db,add};
}

test('queue preflight ranks fresh matches without starting work or exposing foreign records or profile answers',()=>{
 const {db,add}=fixture();useSavedSearchQueue(db,'u',{applicant_id:'p'});
 add('onsite');add('remote',{remote:true,location:'Canada',description:'Remote within Canada. Full-time employment.'});add('stale');add('attempted');add('outside',{location:'Vancouver, Canada'});add('foreign',{user_id:'u2',applicant_id:'p2'});
 db.exec("UPDATE jobs SET job_metadata_json=json_set(job_metadata_json,'$.checkedAt','2020-01-01') WHERE id='stale'; UPDATE jobs SET attempts=1 WHERE id='attempted'");
 const before=db.prepare('SELECT total_changes() n').get().n,state=savedSearchQueueState(db,'u',{applicant_id:'p'}),r=state.readiness;
 assert.equal(r.checked,5);assert.equal(r.eligible,2);assert.equal(r.held,3);assert.deepEqual(r.candidates.map(j=>j.id),['remote','onsite']);assert(r.candidates.every(j=>j.automatic_submission_supported));
 assert.match(r.held_jobs.find(j=>j.id==='stale').reason,/fresh employer posting/);assert.match(r.held_jobs.find(j=>j.id==='attempted').reason,/untouched/);assert.match(r.held_jobs.find(j=>j.id==='outside').reason,/scope/);
 assert.equal(state.auto_submit,false);assert.equal(db.prepare('SELECT total_changes() n').get().n,before);assert.equal(focusSnapshot(db,'u').job_id,null);
 for(const secret of ['foreign','fixture@example.test','fixture.pdf'])assert(!JSON.stringify(r).includes(secret));
 assert.throws(()=>savedSearchQueueState(db,'u',{applicant_id:'p2'}),/saved applicant/);db.close();
});

test('queue preflight preserves uncertain and completed protections and distinguishes forms requiring manual review',()=>{
 const {db,add}=fixture();useSavedSearchQueue(db,'u',{applicant_id:'p'});add('reserved');add('manual');
 db.exec("INSERT INTO autonomous_attempts VALUES('reserved','hosted-worker','2026'); UPDATE jobs SET job_metadata_json=json_set(job_metadata_json,'$.manualReview',json('true')) WHERE id='manual'");
 const r=savedSearchQueueState(db,'u',{applicant_id:'p'}).readiness;
 assert.equal(r.checked,2);assert.equal(r.eligible,1);assert.equal(r.candidates[0].id,'manual');assert.equal(r.candidates[0].automatic_submission_supported,false);assert.match(r.held_jobs[0].reason,/previous submission/);assert.equal(db.prepare('SELECT COUNT(*) n FROM autonomous_attempts').get().n,1);db.close();
});

test('one-job run parks a pre-submit blocker, targets only the named fresh job and stops after a genuine receipt',()=>{
 const {db,add}=fixture();useSavedSearchQueue(db,'u',{applicant_id:'p'});add('blocked',{status:'needs_review'});add('selected');add('next');
 db.exec("UPDATE jobs SET attempts=1,challenge='Missing personal fact' WHERE id='blocked';UPDATE work_focus SET enabled=1,job_id='blocked' WHERE user_id='u'");
 const blocked=db.prepare("SELECT * FROM jobs WHERE id='blocked'").get();let f=startOneApplication(db,'u','selected');assert.equal(f.job_id,'selected');assert(f.auto_submit&&f.stop_after_receipt);assert.equal(f.skip_blocked,false);assert.deepEqual(db.prepare("SELECT * FROM jobs WHERE id='blocked'").get(),blocked);
 db.exec("UPDATE jobs SET status='needs_review',local_attempt_at='2026',local_phase='verifying',challenge='Unconfirmed submission' WHERE id='selected'");
 f=ensureFocusedJob(db,'u');assert.equal(f.job_id,'selected');assert.equal(f.auto_submit,true);assert.equal(f.confirmed,false);assert.throws(()=>startOneApplication(db,'u','next'),/awaiting submission verification/);
 db.exec("UPDATE jobs SET status='submitted',challenge=NULL,confirmation='Thank you for applying' WHERE id='selected';INSERT INTO events VALUES('selected','2026','submitted','Employer receipt')");
 f=ensureFocusedJob(db,'u');assert(f.confirmed);assert.equal(f.enabled,false);assert.equal(f.auto_submit,false);assert.equal(f.job_id,'selected');assert.equal(db.prepare("SELECT status FROM jobs WHERE id='next'").get().status,'saved');assert.equal(db.prepare('SELECT COUNT(*) n FROM autonomous_attempts').get().n,0);db.close();
});

test('one-job run rejects foreign, attempted, unsupported, stale, unconsented and manual-review candidates atomically',()=>{
 for(const mutation of ["UPDATE jobs SET user_id='u2',applicant_id='p2' WHERE id='fresh'","UPDATE jobs SET attempts=1 WHERE id='fresh'","UPDATE jobs SET local_attempt_at='2026' WHERE id='fresh'","UPDATE jobs SET job_metadata_json=json_set(job_metadata_json,'$.checkedAt','2020-01-01') WHERE id='fresh'","UPDATE jobs SET job_metadata_json=json_set(job_metadata_json,'$.manualReview',json('true')) WHERE id='fresh'","UPDATE applicants SET consent=0 WHERE id='p'","UPDATE applicants SET execution_mode='local' WHERE id='p'","UPDATE jobs SET url='https://example.test/unknown' WHERE id='fresh'"]){
  const {db,add}=fixture();useSavedSearchQueue(db,'u',{applicant_id:'p'});add('fresh');db.exec(mutation);const before=db.prepare('SELECT total_changes() n').get().n;assert.throws(()=>startOneApplication(db,'u','fresh'));assert.equal(db.prepare('SELECT total_changes() n').get().n,before);assert.equal(focusSnapshot(db,'u').auto_submit,false);db.close();
 }
});

test('both dashboards show the preflight without sending a mutation and render employer names as text',async()=>{
 const {readFileSync}=await import('node:fs'),{JSDOM}=await import('jsdom');
 for(const client of ['assistant-client.js','web/progress.js']){
  const source=readFileSync(new URL('../'+client,import.meta.url),'utf8'),dom=new JSDOM('<div id="home-summary"></div>',{url:'https://example.test/?view=settings',runScripts:'outside-only'}),w=dom.window,calls=[];
  w.$=s=>w.document.querySelector(s);w.el=(tag,text)=>{const node=w.document.createElement(tag);if(text)node.textContent=text;return node;};w.field=(form)=>{const node=w.document.createElement('input');form.append(node);return node;};
  w.api=async(path,method)=>{calls.push({path,method});return path==='/applicants'?{applicants:[{id:'p',name:'Profile'}]}:{mode:'saved-search',applicant_id:'p',batch_enabled:false,paused:true,readiness:{eligible:1,held:1,candidates:[{title:'Platform Engineer',company:'<img src=x onerror=alert(1)>',url:'https://jobs.lever.co/example/role',remote:true,location:'Canada',automatic_submission_supported:true}],held_jobs:[{title:'Older role',company:'Other',reason:'A fresh employer posting check is required.'}]}};};
  w.eval(source.slice(source.indexOf('function renderBatchControl('),source.indexOf('function automaticSubmissionEnabled')));w.renderBatchControl();await new Promise(r=>setTimeout(r,0));
  const panel=w.document.querySelector('[aria-label="Fresh application queue"]');assert.match(panel.textContent,/1 eligible for preparation/);assert.match(panel.textContent,/Remote.*Canada/);assert.match(panel.textContent,/fresh employer posting/);assert.equal(panel.querySelectorAll('img').length,0);assert(calls.every(c=>!c.method));assert.equal(panel.querySelector('a').href,'https://jobs.lever.co/example/role');dom.window.close();
 }
});
test('explicit transition preserves nine uncertain and eleven completed jobs, membership, searches and other accounts',()=>{
 const {db,add}=fixture();add('fresh');const snapshot=()=>JSON.stringify({jobs:db.prepare('SELECT * FROM jobs ORDER BY id').all(),members:db.prepare('SELECT * FROM application_batch_members').all(),events:db.prepare('SELECT * FROM events').all(),searches:db.prepare('SELECT * FROM searches').all()});const before=snapshot(),other=JSON.stringify(db.prepare("SELECT * FROM work_focus WHERE user_id='u2'").get());
 const result=useSavedSearchQueue(db,'u',{applicant_id:'p'});assert.equal(result.focus.enabled,false);assert.equal(result.focus.auto_submit,false);assert.equal(result.focus.job_id,null);assert.equal(result.focus.search_queue_only,true);assert.equal(snapshot(),before);assert.equal(JSON.stringify(db.prepare("SELECT * FROM work_focus WHERE user_id='u2'").get()),other);assert.equal(db.prepare("SELECT enabled FROM application_batch_preferences WHERE user_id='u'").get().enabled,0);
 assert.match(savedSearchClaimProblem(db,db.prepare("SELECT * FROM jobs WHERE id='fresh'").get()),/paused/);
 const active=setWorkFocus(db,'u',{enabled:true,auto_submit:true,skip_blocked:true});assert.equal(active.job_id,'fresh');assert.equal(active.auto_submit,true);assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE local_phase='uncertain'").get().n,9);assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='submitted'").get().n,11);db.close();
});
test('in-flight work blocks transition atomically and cannot be bypassed by reactivation or reservation',()=>{
 const {db,add}=fixture();add('running',{status:'running'});const before=JSON.stringify(focusSnapshot(db,'u'));assert.throws(()=>useSavedSearchQueue(db,'u',{applicant_id:'p'}),/running or verifying/);assert.equal(JSON.stringify(focusSnapshot(db,'u')),before);assert.equal(db.prepare("SELECT enabled FROM application_batch_preferences WHERE user_id='u'").get().enabled,1);
 db.exec("DELETE FROM jobs WHERE id='running'");add('fresh');useSavedSearchQueue(db,'u',{applicant_id:'p'});setWorkFocus(db,'u',{enabled:true,auto_submit:true});add('verifying');db.exec("UPDATE jobs SET local_phase='verifying',challenge='Submission in progress' WHERE id='verifying'");assert.throws(()=>setWorkFocus(db,'u',{enabled:true,auto_submit:true}),/running or verifying/);db.exec("UPDATE jobs SET status='running',attempts=1 WHERE id='fresh'");assert.throws(()=>reserveAutonomousAttempt(db,'fresh','u','hosted-worker'),/running or verifying/);assert.equal(db.prepare('SELECT COUNT(*) n FROM autonomous_attempts').get().n,0);db.close();
});
test('missing scope, foreign profiles, stale, legacy, unrelated and outside-location jobs fail closed',()=>{
 const {db,add}=fixture();assert.throws(()=>useSavedSearchQueue(db,'u',{applicant_id:'p2'}),/saved applicant/);db.exec("UPDATE searches SET enabled=0");assert.throws(()=>useSavedSearchQueue(db,'u',{applicant_id:'p'}),/structured search/);db.exec("UPDATE searches SET enabled=1");
 for(const id of ['stale','legacy','unrelated','outside'])add(id,id==='outside'?{location:'Vancouver, Canada'}:{});
 db.exec("UPDATE jobs SET job_metadata_json=json_set(job_metadata_json,'$.checkedAt','2020-01-01') WHERE id='stale';UPDATE jobs SET job_metadata_json=json_remove(job_metadata_json,'$.searchScopeSignature') WHERE id='legacy';UPDATE jobs SET title='Nurse' WHERE id='unrelated'");
 useSavedSearchQueue(db,'u',{applicant_id:'p'});assert.equal(setWorkFocus(db,'u',{enabled:true,auto_submit:true}).job_id,null);db.exec('UPDATE searches SET enabled=0');assert.throws(()=>setWorkFocus(db,'u',{enabled:true,auto_submit:true}),/structured search/);db.close();
});
test('both dashboards expose the explicit transition and retain receipt-pending cards during saved-search focus',async()=>{
 const {readFileSync}=await import('node:fs'),{JSDOM}=await import('jsdom');
 for(const client of ['assistant-client.js','web/progress.js']){
  const source=readFileSync(new URL('../'+client,import.meta.url),'utf8');
  const dom=new JSDOM('<div id="home-summary"></div><p id="notice"></p>',{url:'https://example.test/?view=settings',runScripts:'outside-only'}),w=dom.window,calls=[];
  w.$=s=>w.document.querySelector(s);w.el=(tag,text)=>{const el=w.document.createElement(tag);if(text)el.textContent=text;return el;};w.field=(form,label)=>{const x=w.document.createElement('input');form.append(x);return x;};w.refresh=async()=>{};let switched=false;w.api=async(path,method,data)=>{calls.push({path,method,data});if(path==='/applicants')return {applicants:[{id:'p',name:'Fixture'}]};if(path==='/application-batch'){switched=true;return {message:'Saved search queue selected. Automation is paused.'};}return {mode:switched?'saved-search':'legacy',batch_enabled:!switched,applicant_id:switched?'p':null,paused:true,active_structured_search:true};};
  w.eval(source.slice(source.indexOf('function renderBatchControl('),source.indexOf('function automaticSubmissionEnabled')));w.renderBatchControl({enabled:true,selected:20,completed:11});await new Promise(r=>setTimeout(r,0));
  const button=[...w.document.querySelectorAll('button')].find(x=>x.textContent==='Use saved search queue');assert(button);await button.onclick();assert.deepEqual(JSON.parse(JSON.stringify(calls.find(x=>x.path==='/application-batch').data)),{action:'saved-search',applicant_id:'p'});assert.match(w.document.querySelector('#notice').textContent,/paused/);assert(source.includes("activeFocus.search_queue_only&&(state==='awaiting'||card.dataset.confirmed==='true')"));dom.window.close();
 }
});

test('historical verified receipts with residual verifying phase do not block or alter queue transition',()=>{
 const {db}=fixture();db.exec("UPDATE jobs SET local_phase='verifying',confirmation='Thank you for applying' WHERE status='submitted'");
 assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='submitted' AND local_phase='verifying'").get().n,11);
 assert(receiptConfirmed(db,db.prepare("SELECT * FROM jobs WHERE id='old9'").get()));
 const before=JSON.stringify(db.prepare('SELECT * FROM jobs ORDER BY id').all());assert.equal(inFlightApplication(db,'u'),undefined);
 const result=useSavedSearchQueue(db,'u',{applicant_id:'p'});assert.equal(result.focus.enabled,false);assert.equal(JSON.stringify(db.prepare('SELECT * FROM jobs ORDER BY id').all()),before);db.close();
});

test('an actual sent-to receipt clears a historical verification blocker without erasing attempts',()=>{
 const {db,add}=fixture();add('sent',{status:'submitted'});
 db.exec("UPDATE jobs SET local_phase='verifying',local_attempt_at='2026',attempts=1,confirmation='Your job application has been sent to Randstad Canada.' WHERE id='sent';INSERT INTO events VALUES('sent','2026','manual_confirmation','Recorded employer email');");
 assert.equal(inFlightApplication(db,'u'),undefined);
 assert.equal(useSavedSearchQueue(db,'u',{applicant_id:'p'}).focus.auto_submit,false);
 const job=db.prepare("SELECT * FROM jobs WHERE id='sent'").get();
 assert.equal(job.attempts,1);assert.equal(job.local_attempt_at,'2026');assert(receiptConfirmed(db,job));db.close();
});
test('residual phase exemptions require genuine receipt evidence and never mask running or uncertain work',()=>{
 const {db,add}=fixture();db.exec("UPDATE jobs SET local_phase='verifying',confirmation='Thank you for applying' WHERE status='submitted'");
 add('reported',{status:'submitted'});db.exec("UPDATE jobs SET local_phase='verifying',challenge='Applicant reported submission',confirmation='Thank you for applying',local_attempt_at='2026' WHERE id='reported';INSERT INTO events VALUES('reported','2026','applicant_reported_submission','Reported only')");
 assert.equal(inFlightApplication(db,'u').id,'reported','receipt-looking text plus reported event is not a receipt');assert.throws(()=>useSavedSearchQueue(db,'u',{applicant_id:'p'}),/running or verifying/);
 db.exec("INSERT INTO events VALUES('reported','2026','manual_confirmation','Employer receipt');UPDATE jobs SET confirmation='Unconfirmed submission' WHERE id='reported'");assert.equal(inFlightApplication(db,'u').id,'reported','receipt event without recognized non-placeholder text is insufficient');
 db.exec("UPDATE jobs SET confirmation='Thank you for applying',challenge=NULL WHERE id='reported'");assert.equal(inFlightApplication(db,'u'),undefined);
 add('live',{status:'running'});db.exec("UPDATE jobs SET confirmation='Thank you for applying' WHERE id='live';INSERT INTO events VALUES('live','2026','submitted','Old receipt')");assert.equal(inFlightApplication(db,'u').id,'live','running remains protected even with anomalous historical receipt evidence');
 db.exec("UPDATE jobs SET status='submitted',challenge='Submission in progress' WHERE id='live'");assert.equal(inFlightApplication(db,'u').id,'live');
 db.exec("UPDATE jobs SET status='needs_review',challenge='Unconfirmed submission',local_phase='verifying' WHERE id='live'");assert.equal(inFlightApplication(db,'u').id,'live','nonterminal uncertain verifying remains protected');
 db.close();
});

test('legacy focus migration preserves records and readback is strictly read-only and owner-scoped',()=>{
 const {db,add}=fixture();db.exec('ALTER TABLE work_focus DROP COLUMN search_queue_only; ALTER TABLE work_focus DROP COLUMN queue_applicant_id');
 const before=JSON.stringify({jobs:db.prepare('SELECT * FROM jobs').all(),members:db.prepare('SELECT * FROM application_batch_members').all(),searches:db.prepare('SELECT * FROM searches').all()});installSingleApplication(db);installSingleApplication(db);
 assert.equal(JSON.stringify({jobs:db.prepare('SELECT * FROM jobs').all(),members:db.prepare('SELECT * FROM application_batch_members').all(),searches:db.prepare('SELECT * FROM searches').all()}),before);
 add('foreign-live',{user_id:'u2',applicant_id:'p2',status:'running'});add('own-live',{status:'running'});
 const dbBefore=JSON.stringify(db.prepare("SELECT * FROM work_focus ORDER BY user_id").all()),changes=db.prepare('SELECT total_changes() n').get().n;
 const state=savedSearchQueueState(db,'u',{applicant_id:'p'});assert.equal(state.mode,'legacy');assert.equal(state.blocker.id,'own-live');assert.equal(state.blocker.title,'Platform Engineer');assert.equal(state.active_structured_search,true);assert(!JSON.stringify(state).includes('foreign-live'));assert(!JSON.stringify(state).includes('fixture@example.test'));assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);assert.equal(JSON.stringify(db.prepare('SELECT * FROM work_focus ORDER BY user_id').all()),dbBefore);
 assert.throws(()=>savedSearchQueueState(db,'u',{applicant_id:'p2'}),/saved applicant/);db.exec("DELETE FROM jobs WHERE id='own-live'");useSavedSearchQueue(db,'u',{applicant_id:'p'});const applied=savedSearchQueueState(db,'u',{applicant_id:'p'});assert.equal(applied.mode,'saved-search');assert.equal(applied.batch_enabled,false);assert.equal(applied.paused,true);db.close();
});
test('blocker details expose bounded safe evidence even outside the active batch, never raw owners or event messages',()=>{
 const {db,add}=fixture();db.exec('ALTER TABLE jobs ADD COLUMN lease_at TEXT');add('outside-batch',{status:'local_browser'});
 db.exec("UPDATE jobs SET local_phase='verifying',challenge='Submission in progress',local_owner='secret-device-owner',updated_at='2026-10-11T06:00:00+02:00',local_attempt_at='2026-10-11T03:59:00Z',lease_at='2026-10-11T03:58:00Z' WHERE id='outside-batch'");
 db.prepare('INSERT INTO autonomous_attempts VALUES(?,?,?)').run('outside-batch','secret-device-owner','2026-10-11T03:59:00Z');
 for(let i=0;i<7;i++)db.prepare('INSERT INTO events VALUES(?,?,?,?)').run('outside-batch','2026-10-11T03:5'+i+':00Z',i%2?'manual_submission':'submission_started','Private question and answer: private@example.test secret-token');
 db.prepare('INSERT INTO events VALUES(?,?,?,?)').run('outside-batch','2026-10-11T03:59:00Z','private@example.test','Secret');
 db.prepare('INSERT INTO events VALUES(?,?,?,?)').run('other','2026-10-11T04:00:00Z','manual_submission','Other account');
 assert.equal(db.prepare("SELECT COUNT(*) n FROM application_batch_members WHERE job_id='outside-batch'").get().n,0);
 const before=db.prepare('SELECT total_changes() n').get().n,state=savedSearchQueueState(db,'u',{applicant_id:'p'}),b=state.blocker;
 assert.equal(b.id,'outside-batch');assert.equal(b.status,'local_browser');assert.equal(b.phase,'verifying');assert.equal(b.updated_at,'2026-10-11T04:00:00.000Z');assert.equal(b.attempt_at,'2026-10-11T03:59:00.000Z');assert.equal(b.worker_claim_at,'2026-10-11T03:58:00.000Z');assert.equal(b.profile_execution_mode,'cloud');assert.equal(b.recorded_execution_source,'local-browser');assert.equal(b.recent_events.length,5);assert.deepEqual(Object.keys(b.recent_events[0]).sort(),['at','type']);
 for(const secret of ['secret-device-owner','private@example.test','secret-token','Private question','Other account'])assert(!JSON.stringify(state).includes(secret),secret);
 assert.equal(db.prepare('SELECT total_changes() n').get().n,before);db.exec("UPDATE jobs SET updated_at=NULL,lease_at='invalid',local_attempt_at='2026' WHERE id='outside-batch'");const missing=savedSearchQueueState(db,'u',{applicant_id:'p'}).blocker;assert.equal(missing.updated_at,null);assert.equal(missing.attempt_at,null);assert.equal(missing.worker_claim_at,null);db.close();
});
test('durably archived uncertain attempts permit unrelated fresh work while remaining unconfirmed and duplicate-protected',async()=>{
 const {installArchive}=await import('../application-archive.js'),{installRepeatGuard,priorApplication}=await import('../application-dedup.js');
 const {db,add}=fixture();installArchive(db);add('archived-attempt',{status:'archived'});db.exec("UPDATE jobs SET local_attempt_at='2026-10-01T19:39:37.926Z',local_phase='verifying',challenge='Submission in progress',local_owner='original-browser',attempts=1,updated_at='2026-10-07T00:34:35.629Z' WHERE id='archived-attempt';INSERT INTO application_archive VALUES('archived-attempt','local_browser','2026-10-07T00:34:35.629Z');INSERT INTO events VALUES('archived-attempt','2026-10-01T19:39:37.926Z','submission_started','Attempt retained');INSERT INTO events VALUES('archived-attempt','2026-10-07T00:34:35.629Z','archived','Queue reset');");
 const original=db.prepare("SELECT * FROM jobs WHERE id='archived-attempt'").get(),events=JSON.stringify(db.prepare("SELECT * FROM events WHERE job_id='archived-attempt'").all());assert.equal(receiptConfirmed(db,original),false);assert.equal(inFlightApplication(db,'u'),undefined);
 installRepeatGuard(db);add('fresh-unrelated');useSavedSearchQueue(db,'u',{applicant_id:'p'});const next=setWorkFocus(db,'u',{enabled:true,auto_submit:true,skip_blocked:true});assert.equal(next.job_id,'fresh-unrelated');assert.deepEqual(db.prepare("SELECT * FROM jobs WHERE id='archived-attempt'").get(),original);assert.equal(JSON.stringify(db.prepare("SELECT * FROM events WHERE job_id='archived-attempt'").all()),events);assert.equal(receiptConfirmed(db,original),false);assert.equal(priorApplication(db,'u',{...original,id:'repeat'}).id,'archived-attempt');
 db.prepare("INSERT INTO jobs(id,user_id,applicant_id,company,title,url,normalized_url,status,job_metadata_json) VALUES('repeat',?,?,?,?,?,?,'saved',?)").run(original.user_id,original.applicant_id,original.company,original.title,original.url,original.normalized_url,original.job_metadata_json);assert.equal(db.prepare("SELECT status FROM jobs WHERE id='repeat'").get().status,'duplicate');assert.throws(()=>db.exec("UPDATE jobs SET status='queued' WHERE id='repeat'"),/repeat application blocked/);assert.throws(()=>reserveAutonomousAttempt(db,'archived-attempt','u','hosted-worker'),/not enabled/);db.close();
});
test('archive exemption fails closed without provenance, with live handoff, with dispatching continuation, or after restoration',async()=>{
 const {installArchive}=await import('../application-archive.js'),{db,add}=fixture();installArchive(db);add('archived-attempt',{status:'archived'});db.exec("UPDATE jobs SET local_phase='verifying',challenge='Submission in progress',local_attempt_at='2026' WHERE id='archived-attempt'");assert.equal(inFlightApplication(db,'u').id,'archived-attempt');
 db.exec("INSERT INTO application_archive VALUES('archived-attempt','local_browser','2026');INSERT INTO events VALUES('archived-attempt','2026','archived','Archived');UPDATE jobs SET handoff_available=1 WHERE id='archived-attempt'");assert.equal(inFlightApplication(db,'u').id,'archived-attempt');
 db.exec("UPDATE jobs SET handoff_available=0 WHERE id='archived-attempt';CREATE TABLE continuation_requests(user_id,job_id,state);INSERT INTO continuation_requests VALUES('u','archived-attempt','dispatching')");assert.equal(inFlightApplication(db,'u').id,'archived-attempt');
 db.exec("UPDATE continuation_requests SET state='cancelled'");assert.equal(inFlightApplication(db,'u'),undefined);db.exec("UPDATE jobs SET status='local_browser' WHERE id='archived-attempt'");assert.equal(inFlightApplication(db,'u').id,'archived-attempt');db.exec("UPDATE jobs SET status='running' WHERE id='archived-attempt'");assert.equal(inFlightApplication(db,'u').id,'archived-attempt');db.close();
});


test('explicit pre-submit takeover can reopen the selected form without clearing preparation history',()=>{
 const {db,add}=fixture();add('fresh');useSavedSearchQueue(db,'u',{applicant_id:'p'});setWorkFocus(db,'u',{enabled:true,auto_submit:false});
 db.exec("UPDATE jobs SET status='queued',attempts=2 WHERE id='fresh';INSERT INTO events VALUES('fresh','2026','running','Opening employer application')");
 const job=()=>db.prepare("SELECT * FROM jobs WHERE id='fresh'").get();
 assert.match(savedSearchClaimProblem(db,job()),/untouched/);
 db.exec("INSERT INTO events VALUES('fresh','2026','queued','Preparing a live application browser for applicant takeover')");
 assert.equal(savedSearchClaimProblem(db,job()),'');assert.equal(job().attempts,2);assert.equal(focusSnapshot(db,'u').auto_submit,false);
 db.exec("INSERT INTO events VALUES('fresh','2026','running','Opening employer application')");
 assert.match(savedSearchClaimProblem(db,job()),/untouched/,'old takeover request cannot replay after a crash');db.close();
});

test('takeover permission never admits uncertain submissions, stale matches, changed scope or another selected job',()=>{
 for(const mutation of [
  "UPDATE jobs SET local_attempt_at='2026' WHERE id='fresh'",
  "INSERT INTO events VALUES('fresh','2026','submission_started','Intent')",
  "INSERT INTO autonomous_attempts VALUES('fresh','hosted-worker','2026')",
  "UPDATE jobs SET challenge='Unconfirmed submission' WHERE id='fresh'",
  "UPDATE jobs SET local_owner='browser' WHERE id='fresh'",
  "UPDATE jobs SET handoff_available=1 WHERE id='fresh'",
  "UPDATE jobs SET job_metadata_json=json_set(job_metadata_json,'$.checkedAt','2020-01-01') WHERE id='fresh'",
  "UPDATE applicants SET consent=0 WHERE id='p'",
  "UPDATE work_focus SET job_id='old0' WHERE user_id='u'",
  "UPDATE searches SET enabled=0 WHERE user_id='u'"
 ]){
  const {db,add}=fixture();add('fresh');useSavedSearchQueue(db,'u',{applicant_id:'p'});setWorkFocus(db,'u',{enabled:true,auto_submit:false});
  db.exec("UPDATE jobs SET status='queued',attempts=1 WHERE id='fresh';INSERT INTO events VALUES('fresh','2026','queued','Preparing a live application browser for applicant takeover')");
  db.exec(mutation);assert(savedSearchClaimProblem(db,db.prepare("SELECT * FROM jobs WHERE id='fresh'").get()),mutation);db.close();
 }
});
