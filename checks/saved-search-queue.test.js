import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installBatches} from '../application-batches.js';
import {installSingleApplication,inFlightApplication,receiptConfirmed,useSavedSearchQueue,setWorkFocus,focusSnapshot,savedSearchClaimProblem,reserveAutonomousAttempt} from '../single-application.js';
import {normalizeSearchScope,scopeIntent} from '../search-scope.js';
import {jobIntelligence} from '../job-intelligence.js';
const scope=normalizeSearchScope({roles:['Platform Engineer'],localPlaces:['ontario'],remotePlaces:['canada'],remoteFromCountry:'canada',authorizedCountries:['canada'],allowEmploymentFallback:true});
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id,applicant_id,company,title,url,normalized_url,status,local_owner,local_attempt_at,local_phase,challenge,confirmation,attempts DEFAULT 0,handoff_available DEFAULT 0,match_score DEFAULT 90,created_at,updated_at,job_metadata_json DEFAULT '{}');CREATE TABLE applicants(id,user_id,consent,email,resume_path,execution_mode,focus);CREATE TABLE events(job_id,at,type,message);CREATE TABLE external_application_history(id,user_id,company,title,status,company_key,title_key);CREATE TABLE research_draft_usage(job_id,question);CREATE TABLE searches(id,user_id,applicant_id,enabled,instruction,created_at,scope_json);CREATE TABLE employer_limits(user_id,applicant_id,employer_key,hold_until,message);INSERT INTO applicants VALUES('p','u',1,'fixture@example.test','fixture.pdf','cloud','Platform Engineer'),('p2','u2',1,'other@example.test','other.pdf','cloud','Platform Engineer');`);
 installBatches(db);installSingleApplication(db);
 db.prepare('INSERT INTO searches VALUES(?,?,?,?,?,?,?)').run('s','u','p',1,'Grouped roles','2026',JSON.stringify(scope));
 db.exec("INSERT INTO application_batch_preferences VALUES('u','p',1,'old',120000,'','2026'),('u2','p2',1,'other',120000,'','2026');INSERT INTO work_focus(user_id,enabled,job_id,auto_submit,skip_blocked) VALUES('u',1,'old0',0,1),('u2',1,'other',0,1)");
 function add(id,extra={}){const j={user_id:'u',applicant_id:'p',status:'saved',location:'Toronto, Ontario',remote:false,description:'Full-time employment.',...extra};const m=jobIntelligence({title:'Platform Engineer',...j},scopeIntent(scope));db.prepare("INSERT INTO jobs(id,user_id,applicant_id,company,title,url,normalized_url,status,created_at,job_metadata_json) VALUES(?,?,?,?,'Platform Engineer',?,?,?,'2026',?)").run(id,j.user_id,j.applicant_id,id,'https://jobs.lever.co/'+id+'/role','https://jobs.lever.co/'+id+'/role',j.status,JSON.stringify(m));}
 for(let n=0;n<20;n++){add('old'+n,{status:n<9?'needs_review':'submitted'});db.prepare('INSERT INTO application_batch_members VALUES(?,?,?,?)').run('old','old'+n,'u',n);if(n<9)db.prepare("UPDATE jobs SET attempts=1,local_attempt_at='2026',local_phase='uncertain',challenge='Unconfirmed submission' WHERE id=?").run('old'+n);else {db.prepare("UPDATE jobs SET confirmation='Employer received application' WHERE id=?").run('old'+n);db.prepare("INSERT INTO events VALUES(?,'2026','submitted','Receipt')").run('old'+n);}}
 add('other',{user_id:'u2',applicant_id:'p2'});return {db,add};
}
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
  w.$=s=>w.document.querySelector(s);w.el=(tag,text)=>{const el=w.document.createElement(tag);if(text)el.textContent=text;return el;};w.field=(form,label)=>{const x=w.document.createElement('input');form.append(x);return x;};w.refresh=async()=>{};w.api=async(path,method,data)=>{calls.push({path,method,data});return path==='/applicants'?{applicants:[{id:'p',name:'Fixture'}]}:{message:'Saved search queue selected. Automation is paused.'};};
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
