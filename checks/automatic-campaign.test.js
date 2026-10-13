import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {employerHold} from '../employer-limits.js';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installBatches} from '../application-batches.js';
import {installSingleApplication,focusAllowsSubmit,reserveAutonomousAttempt,savedSearchClaimProblem} from '../single-application.js';
import {installPreparationCampaign} from '../preparation-campaign.js';
import {installAutomaticCampaign,automaticCampaign,startManualBatch,startAutomaticCampaign,stopAutomaticCampaign,populateAutomaticCampaign,automaticSnapshot,automaticMember,recoverAutomaticPreparation,transientPreparationFailure} from '../automatic-campaign.js';
import {prioritizeApplications} from '../application-diversity.js';
import {normalizeSearchScope,scopeIntent} from '../search-scope.js';
import {jobIntelligence} from '../job-intelligence.js';

const roles=['AI Support Engineer','Platform Engineer','DevOps Engineer'];
function fixture(path=':memory:'){
 const db=new DatabaseSync(path);
 db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id,applicant_id,company,title,url,normalized_url,status,local_owner,local_attempt_at,local_phase TEXT NOT NULL DEFAULT 'ready',challenge,confirmation,attempts DEFAULT 0,handoff_available DEFAULT 0,match_score DEFAULT 90,created_at,updated_at,job_metadata_json DEFAULT '{}');
 CREATE TABLE applicants(id,user_id,consent,email,resume_path,execution_mode,focus);
 CREATE TABLE events(job_id,at,type,message);CREATE TABLE answer_history(job_id);
 CREATE TABLE external_application_history(id,user_id,company,title,status,company_key,title_key);
 CREATE TABLE research_draft_usage(job_id,question);
 CREATE TABLE searches(id,user_id,applicant_id,enabled,instruction,created_at,scope_json);
 CREATE TABLE employer_limits(user_id,applicant_id,employer_key,hold_until,message);
 INSERT INTO applicants VALUES('p','u',1,'test@example.test','fixture.pdf','cloud','AI Support Engineer Platform Engineer DevOps Engineer');`);
 installBatches(db);installSingleApplication(db);installPreparationCampaign(db);installAutomaticCampaign(db);
 const scope=normalizeSearchScope({roles,localPlaces:[],remotePlaces:['canada'],remoteWorldwide:true,remoteFromCountry:'canada',authorizedCountries:['canada'],allowEmploymentFallback:true,preferBusinessContract:true,preferRemote:true});
 db.prepare('INSERT INTO searches VALUES(?,?,?,?,?,?,?)').run('s','u','p',1,'Role rotation','2026',JSON.stringify(scope));
 db.exec("INSERT INTO work_focus(user_id,enabled,job_id,auto_submit,skip_blocked) VALUES('u',1,NULL,1,1);INSERT INTO application_batch_preferences VALUES('u','p',1,'old',120000,'','2026');INSERT INTO preparation_campaigns VALUES('u','manual','p',200,20,'[]',1,'2026')");
 function add(id,title=roles[0],company=id){const url='https://jobs.lever.co/'+id+'/role',m=jobIntelligence({title,location:'Remote Canada',remote:true,description:'Fully remote within Canada. Full-time employment.'},scopeIntent(scope));db.prepare("INSERT INTO jobs(id,user_id,applicant_id,company,title,url,normalized_url,status,created_at,job_metadata_json) VALUES(?,'u','p',?,?,?,?,'saved','2026',?)").run(id,company,title,url,url,JSON.stringify(m));return get(id);}
 const get=id=>db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
 return {db,add,get,start:(options={})=>startAutomaticCampaign(db,'u',{applicant_id:'p',mode:'automatic',auto_submit:true,batch_size:20,...options})};
}

function failBeforeSubmit(f,{message='Worker stopped: locator.evaluate: Target crashed',closed=true}={}){
 f.db.prepare("UPDATE jobs SET status='needs_review',challenge='Worker error',attempts=attempts+1 WHERE id='j'").run();
 f.db.prepare("INSERT INTO events VALUES('j',?,'needs_review',?)").run(new Date().toISOString(),message);
 if(closed)f.db.prepare("INSERT INTO events VALUES('j',?,'handoff_closed','Failed context closed before submission')").run(new Date().toISOString());
}

const preparationTimeouts=[
 'Worker stopped: locator.evaluate: Timeout 5000ms exceeded.\nCall log:\n - waiting for locator(\'input:not([role="combobox"]):visible\').nth(1)',
 'Worker stopped: locator.blur: Timeout 5000ms exceeded.\nCall log:\n - waiting for locator(\'input:not([role="combobox"]):visible\').nth(1)',
 "Worker stopped: locator.click: Timeout 5000ms exceeded.\nCall log:\n - waiting for getByRole('button', { name: /^(apply|apply now|apply for this job)$/i })",
 "Worker stopped: locator.click: Timeout 5000ms exceeded.\nCall log:\n - waiting for getByRole('link', { name: /^apply for this job$/i }).first()"
];
test('observed pre-submit read/open-link timeouts recover autonomously while manual batch Submit remains disabled',()=>{
 for(const message of preparationTimeouts){
  const f=fixture();f.add('j');f.add('next');f.start({mode:'prepare_only',auto_submit:false});failBeforeSubmit(f,{message});
  const before=f.get('j');let c=populateAutomaticCampaign(f.db,'u');assert.equal(c.members.find(x=>x.job_id==='j').outcome,'pending');assert.equal(f.get('j').status,'needs_review');
  f.db.exec("UPDATE automatic_preparation_recovery SET next_at='2000'");populateAutomaticCampaign(f.db,'u');
  assert.equal(f.get('j').status,'queued');assert.equal(f.get('j').attempts,before.attempts);assert.equal(focusAllowsSubmit(f.db,f.get('j')),false);assert.throws(()=>reserveAutonomousAttempt(f.db,'j','u','hosted-worker'));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type='human_assistance'").get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM autonomous_attempts').get().n,0);
  assert.equal(f.get('next').status,'queued');f.db.close();
 }
 for(const message of ["Worker stopped: locator.click: Timeout 5000ms exceeded.\nCall log:\n - waiting for getByRole('button', { name: /^submit application$/i })",'Worker stopped: locator.fill: Timeout 5000ms exceeded.','Worker stopped: locator.blur: Timeout 5000ms exceeded.\nCall log:\n - waiting for an unknown control','Worker stopped: locator.evaluate: Unrecognized page error'])assert.equal(transientPreparationFailure(message),'');
});
test('read/open-link timeout recovery never overrides attempts, employer holds, Stop or a live browser',()=>{
 for(const message of preparationTimeouts)for(const marker of ['intent','event','local','phase','receipt','handoff','owner','unclosed','stopped','hold']){
  const f=fixture();f.add('j');f.start({mode:'prepare_only',auto_submit:false});failBeforeSubmit(f,{message,closed:marker!=='unclosed'});
  if(marker==='intent')f.db.exec("INSERT INTO autonomous_attempts VALUES('j','hosted-worker','2026')");
  if(marker==='event')f.db.exec("INSERT INTO events VALUES('j','2026','submission_started','Possible attempt')");
  if(marker==='local')f.db.exec("UPDATE jobs SET local_attempt_at='2026' WHERE id='j'");
  if(marker==='phase')f.db.exec("UPDATE jobs SET local_phase='uncertain' WHERE id='j'");
  if(marker==='receipt')f.db.exec("UPDATE jobs SET confirmation='Recorded receipt' WHERE id='j'");
  if(marker==='handoff')f.db.exec("UPDATE jobs SET handoff_available=1 WHERE id='j'");
  if(marker==='owner')f.db.exec("UPDATE jobs SET local_owner='browser' WHERE id='j'");
  if(marker==='stopped')stopAutomaticCampaign(f.db,'u');
  if(marker==='hold')f.db.exec("INSERT INTO employer_limits VALUES('u','p','lever:j','9999','Employer hold')");
  const before=f.get('j');populateAutomaticCampaign(f.db,'u');assert.deepEqual(f.get('j'),before,marker);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM automatic_preparation_recovery').get().n,0,marker);f.db.close();
 }
});

test('automatic preparation recovery waits, respects Stop, preserves history and exhausts two durable retries',()=>{
 const f=fixture();f.add('j');f.add('other');f.start();failBeforeSubmit(f);
 const before=Date.now();let c=populateAutomaticCampaign(f.db,'u');
 let r=f.db.prepare("SELECT * FROM automatic_preparation_recovery WHERE job_id='j'").get();
 assert.equal(r.retries,0);assert(Date.parse(r.next_at)>=before+30000);assert.equal(f.get('j').status,'needs_review');
 assert.equal(c.members.find(m=>m.job_id==='j').outcome,'pending');
 populateAutomaticCampaign(f.db,'u');assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type='automatic_recovery_scheduled'").get().n,1);
 f.db.exec("UPDATE automatic_preparation_recovery SET next_at='2000'");stopAutomaticCampaign(f.db,'u');populateAutomaticCampaign(f.db,'u');assert.equal(f.get('j').status,'needs_review');
 f.start();assert.equal(f.get('j').status,'queued');assert.equal(f.get('j').attempts,1);assert.equal(f.db.prepare("SELECT retries FROM automatic_preparation_recovery WHERE job_id='j'").get().retries,1);
 failBeforeSubmit(f);const second=Date.now();populateAutomaticCampaign(f.db,'u');r=f.db.prepare("SELECT * FROM automatic_preparation_recovery WHERE job_id='j'").get();assert(Date.parse(r.next_at)>=second+120000);
 f.db.exec("UPDATE automatic_preparation_recovery SET next_at='2000'");populateAutomaticCampaign(f.db,'u');assert.equal(f.get('j').status,'queued');assert.equal(f.get('j').attempts,2);
 failBeforeSubmit(f);c=populateAutomaticCampaign(f.db,'u');assert.equal(f.get('j').status,'needs_review');assert.equal(c.members.find(m=>m.job_id==='j').outcome,'blocked');
 stopAutomaticCampaign(f.db,'u');f.start();populateAutomaticCampaign(f.db,'u');
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type='automatic_preparation_recovery'").get().n,2);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type='automatic_recovery_exhausted'").get().n,1);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type='human_assistance'").get().n,0);
 assert.equal(focusAllowsSubmit(f.db,f.get('other')),true);assert.equal(f.get('j').attempts,3);f.db.close();
});

test('recovery excludes unknown errors, validation, declarations, security and all submission or ownership evidence',()=>{
 for(const message of ['Worker stopped: locator.click: Timeout 5000ms exceeded.','Worker stopped: Target page, context or browser has been closed','Worker stopped: page.goto: net::ERR_CERT_AUTHORITY_INVALID','Worker stopped: page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE','Missing required fields: Salary','Your application submission was flagged as possible spam.'])assert.equal(transientPreparationFailure(message),'');
 assert(transientPreparationFailure('Worker stopped: page.goto: net::ERR_CONNECTION_RESET at https://example.test'));
 assert(transientPreparationFailure('Worker stopped: page.goto: Timeout 45000ms exceeded.\nCall log:'));
 for(const marker of ['unclosed','intent','receipt','local','phase','event','owner','handoff','hold','stopped','old-batch','consent','local-mode','scope','expired','unknown','declaration','missing-fact']){
  const f=fixture();f.add('j');f.start();failBeforeSubmit(f,{closed:marker!=='unclosed'});
  if(marker==='intent')f.db.exec("INSERT INTO autonomous_attempts VALUES('j','hosted-worker','2026')");
  if(marker==='receipt')f.db.exec("UPDATE jobs SET confirmation='Employer receipt' WHERE id='j'");
  if(marker==='local')f.db.exec("UPDATE jobs SET local_attempt_at='2026' WHERE id='j'");
  if(marker==='phase')f.db.exec("UPDATE jobs SET local_phase='uncertain' WHERE id='j'");
  if(marker==='event')f.db.exec("INSERT INTO events VALUES('j','2026','submission_started','Reserved')");
  if(marker==='owner')f.db.exec("UPDATE jobs SET local_owner='browser' WHERE id='j'");
  if(marker==='handoff')f.db.exec("UPDATE jobs SET handoff_available=1 WHERE id='j'");
  if(marker==='hold')f.db.exec("INSERT INTO employer_limits VALUES('u','p','lever:j','9999','Employer hold')");
  if(marker==='stopped')stopAutomaticCampaign(f.db,'u');
  if(marker==='old-batch')f.db.exec('UPDATE automatic_campaigns SET current_batch=2');
  if(marker==='consent')f.db.exec('UPDATE applicants SET consent=0');
  if(marker==='local-mode')f.db.exec("UPDATE applicants SET execution_mode='local'");
  if(marker==='scope')f.db.exec('UPDATE searches SET enabled=0');
  if(marker==='expired')f.db.exec("UPDATE jobs SET job_metadata_json=json_set(job_metadata_json,'$.checkedAt','2000')");
  if(marker==='unknown')f.db.exec("UPDATE events SET message='Worker stopped: unexpected exception' WHERE type='needs_review'");
  if(marker==='declaration')f.db.exec("UPDATE jobs SET challenge='Employer declaration' WHERE id='j'");
  if(marker==='missing-fact')f.db.exec("UPDATE jobs SET challenge='Missing answers' WHERE id='j'");
  const original=f.get('j');populateAutomaticCampaign(f.db,'u');assert.deepEqual(f.get('j'),original,marker);
  if(marker==='unclosed')assert.match(automaticMember(f.db,f.get('j')).reason,/closure of the failed browser/);
  if(marker==='scope')assert.match(automaticMember(f.db,f.get('j')).reason,/enabled structured search/);
  if(marker==='expired')assert.match(automaticMember(f.db,f.get('j')).reason,/fresh, available employer posting/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM automatic_preparation_recovery').get().n,0,marker);f.db.close();
 }
});

test('recovery survives process restarts without bypassing budget or abandoning pending batch work',()=>{
 const dir=mkdtempSync(join(tmpdir(),'applypilot-auto-recovery-')),path=join(dir,'db.sqlite');
 const f=fixture(path);f.db.exec('ALTER TABLE jobs ADD COLUMN lease_at');f.add('j');for(let n=0;n<19;n++)f.add('other'+n);f.start();
 f.db.exec("UPDATE jobs SET status='needs_review',challenge='Missing answers' WHERE id!='j';UPDATE jobs SET status='running',attempts=1 WHERE id='j'");
 const source=readFileSync('local-state.js','utf8'),code=source.slice(source.indexOf('export function recoverWorkerJobs'),source.indexOf('export function rememberAnswers')).replace('export ','');
 const recover=(db)=>new Function('db','event','now',code+';return recoverWorkerJobs;')(db,(id,type,message)=>db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(id,new Date().toISOString(),type,message),()=>new Date().toISOString())();
 recover(f.db);assert.equal(f.get('j').status,'needs_review');assert.equal(f.get('j').challenge,'Worker error');
 let c=populateAutomaticCampaign(f.db,'u');assert.equal(c.current_batch,1);assert.equal(c.settled,19);
 f.db.exec("UPDATE automatic_preparation_recovery SET next_at='2000'");populateAutomaticCampaign(f.db,'u');f.db.close();
 const db=new DatabaseSync(path);installAutomaticCampaign(db);assert.equal(db.prepare("SELECT retries FROM automatic_preparation_recovery WHERE job_id='j'").get().retries,1);
 db.exec("UPDATE jobs SET status='running',attempts=attempts+1 WHERE id='j'");recover(db);populateAutomaticCampaign(db,'u');db.exec("UPDATE automatic_preparation_recovery SET next_at='2000'");populateAutomaticCampaign(db,'u');
 assert.equal(db.prepare("SELECT retries FROM automatic_preparation_recovery WHERE job_id='j'").get().retries,2);
 db.exec("UPDATE jobs SET status='running',attempts=attempts+1 WHERE id='j'");recover(db);c=populateAutomaticCampaign(db,'u');assert.equal(c.current_batch,2);assert.equal(db.prepare("SELECT status FROM jobs WHERE id='j'").get().status,'needs_review');
 assert.equal(db.prepare("SELECT attempts FROM jobs WHERE id='j'").get().attempts,3);db.close();rmSync(dir,{recursive:true});
});

test('fresh metadata repairs only discovery-only eligibility blocks and retains their audit history',()=>{
 const f=fixture();f.start();
 for(const id of ['good','opened','selected','uncertain','other-reason','invalid','held','no-discovery','assisted']){
  f.add(id);f.db.prepare("UPDATE jobs SET status='needs_review',challenge='Pipeline needs attention' WHERE id=?").run(id);
  if(id!=='no-discovery')f.db.prepare("INSERT INTO events VALUES(?,'2026','discovered','Native source evidence')").run(id);
  f.db.prepare("INSERT INTO events VALUES(?,'2026','needs_review',?)").run(id,id==='other-reason'?'Consent required':'This job does not meet the saved work eligibility requirements.');
 }
 f.db.exec("UPDATE jobs SET attempts=1 WHERE id='opened';UPDATE jobs SET local_attempt_at='2026' WHERE id='uncertain';UPDATE jobs SET job_metadata_json=json_set(job_metadata_json,'$.eligibility.eligible',json('false')) WHERE id='invalid';INSERT INTO employer_limits VALUES('u','p','lever:held','9999','Employer hold');INSERT INTO events VALUES('assisted','2026','human_assistance','Reviewed form');");
 const c=f.db.prepare('SELECT * FROM automatic_campaigns').get();f.db.prepare("INSERT INTO automatic_members VALUES('selected','u',?,1,1,'DevOps Engineer','blocked','Existing blocker','2026','2026')").run(c.id);
 populateAutomaticCampaign(f.db,'u');assert.equal(f.get('good').status,'queued');assert(automaticMember(f.db,f.get('good')));
 for(const id of ['opened','selected','uncertain','other-reason','invalid','held','no-discovery','assisted'])assert.equal(f.get(id).status,'needs_review',id);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE job_id='good' AND type='needs_review'").get().n,1);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type='discovery_eligibility_recovered'").get().n,1);
 populateAutomaticCampaign(f.db,'u');assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type='discovery_eligibility_recovered'").get().n,1);f.db.close();
});

test('automatic authorization selects 20 fresh jobs and fences the manual and legacy queues',()=>{
 const f=fixture();for(let n=0;n<45;n++)f.add('j'+n,roles[n%3]);
 assert.throws(()=>f.start({mode:'manual'}),/Explicitly/);assert.throws(()=>f.start({auto_submit:false}),/Explicitly/);
 const c=f.start();assert.equal(c.selected,20);assert.equal(c.current_batch,1);assert.deepEqual(c.members.slice(0,3).map(m=>m.title_group),roles);
 assert.equal(f.db.prepare('SELECT enabled FROM preparation_campaigns').get().enabled,0);
 assert.equal(f.db.prepare('SELECT auto_submit FROM work_focus').get().auto_submit,0);
 assert.equal(focusAllowsSubmit(f.db,f.get(c.members[0].job_id)),true);
 const outside=f.db.prepare("SELECT * FROM jobs WHERE status='saved' LIMIT 1").get();assert.match(savedSearchClaimProblem(f.db,outside),/outside/);
 assert.equal(populateAutomaticCampaign(f.db,'u').selected,20);
 assert.equal(automaticSnapshot(f.db,'other').mode,'manual');f.db.close();
});

test('explicit preparation recovery preserves the member, records assistance and refuses every submission marker',()=>{
 for(const marker of ['none','queued','declaration','declaration-intent','queued-intent','intent','local','receipt','other-owner','held','running','stopped','wrong-user','old-batch']){
  const f=fixture();f.add('j');f.start();f.db.exec("UPDATE jobs SET status='needs_review',challenge='Form validation',attempts=1 WHERE id='j'");populateAutomaticCampaign(f.db,'u');
  if(marker.startsWith('queued'))f.db.exec("UPDATE jobs SET status='queued',challenge=NULL WHERE id='j'");
  if(marker.startsWith('declaration'))f.db.exec("UPDATE jobs SET challenge='Employer declaration' WHERE id='j'");
  if(marker==='intent'||marker.endsWith('-intent'))f.db.exec("INSERT INTO autonomous_attempts VALUES('j','hosted-worker','2026')");
  if(marker==='local')f.db.exec("UPDATE jobs SET local_attempt_at='2026' WHERE id='j'");
  if(marker==='receipt')f.db.exec("INSERT INTO events VALUES('j','2026','submitted','Employer confirmed')");
  if(marker==='other-owner')f.db.exec("UPDATE jobs SET local_owner='existing-browser' WHERE id='j'");
  if(marker==='held')f.db.exec("UPDATE jobs SET handoff_available=1 WHERE id='j'");
  if(marker==='running')f.db.exec("UPDATE jobs SET status='running' WHERE id='j'");
  if(marker==='stopped')stopAutomaticCampaign(f.db,'u');
  if(marker==='old-batch')f.db.exec('UPDATE automatic_campaigns SET current_batch=2');
  if(['none','queued','declaration'].includes(marker)){
   assert.deepEqual(recoverAutomaticPreparation(f.db,'u','j'),{ok:true});assert.equal(f.get('j').status,'queued');assert.equal(automaticMember(f.db,f.get('j')).outcome,'pending');assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE type='human_assistance'").get().n,1);assert.equal(automaticSnapshot(f.db,'u').totals.selected,1);
   assert.throws(()=>recoverAutomaticPreparation(f.db,'u','j'));
  }else{const before=f.get('j');assert.throws(()=>recoverAutomaticPreparation(f.db,marker==='wrong-user'?'other':'u','j'));assert.deepEqual(f.get('j'),before);}
  f.db.close();
 }
});

test('prior attempts, interviews, ineligible locations and other owners never enter; disabled legacy pay targets do not transfer',()=>{
 const f=fixture();f.add('good');f.add('interview','AI Support Engineer','OpenAI');
 f.db.exec("INSERT INTO external_application_history VALUES('interview','u','OpenAI','AI Support Engineer (Weekend Shift)','interview','openai','aisupportengineerweekendshift')");
 for(const id of ['attempt','clicked','old','local','foreign','low','wrong-country'])f.add(id);
 f.db.exec("INSERT INTO autonomous_attempts VALUES('attempt','hosted-worker','2026');UPDATE jobs SET local_attempt_at='2026' WHERE id='clicked';UPDATE jobs SET status='submitted',confirmation='Thank you for applying' WHERE id='old';UPDATE jobs SET local_owner='existing' WHERE id='local';UPDATE jobs SET user_id='other' WHERE id='foreign';UPDATE jobs SET job_metadata_json=json_set(job_metadata_json,'$.location','Germany','$.description','Remote within Germany only') WHERE id='wrong-country'");
 f.db.prepare("UPDATE jobs SET job_metadata_json=json_set(job_metadata_json,'$.pay',json(?)) WHERE id='low'").run(JSON.stringify([{currency:'CAD',annualMin:85000,annualMax:110000}]));
 const old=f.get('old');assert.deepEqual(f.start().members.map(m=>m.job_id).sort(),['good','low']);assert.deepEqual(f.get('old'),old);f.db.close();
});

test('twenty settled dispositions open the next twenty once, survive restart and keep uncertain attempts protected',()=>{
 const dir=mkdtempSync(join(tmpdir(),'applypilot-campaign-')),path=join(dir,'campaign.sqlite');
 const f=fixture(path);for(let n=0;n<45;n++)f.add('j'+n,roles[n%3]);let c=f.start();const first=c.members.map(m=>m.job_id);
 for(const [i,id] of first.entries()){
  if(i===0){f.db.prepare("UPDATE jobs SET status='needs_review',challenge='Unconfirmed submission',local_attempt_at=? WHERE id=?").run(new Date().toISOString(),id);f.db.prepare("INSERT INTO events VALUES(?,?,'submission_started','One attempt')").run(id,new Date().toISOString());}
  else if(i===1)f.db.prepare("UPDATE jobs SET status='needs_review',challenge='Missing personal fact' WHERE id=?").run(id);
  else if(i===2)f.db.prepare("UPDATE jobs SET job_metadata_json=json_set(job_metadata_json,'$.available',json('false')) WHERE id=?").run(id);
  else{f.db.prepare("UPDATE jobs SET status='submitted',confirmation='Thank you for applying' WHERE id=?").run(id);for(const type of ['completion_tracking','prepared','submission_started','automatic_submission','submitted'])f.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(id,new Date().toISOString(),type,'Employer confirmed receipt');}
 }
 c=populateAutomaticCampaign(f.db,'u');assert.equal(c.current_batch,2);assert.equal(c.selected,20);assert.equal(c.totals.confirmed,17);assert.equal(c.totals.automatic,17);assert.equal(c.totals.assisted,0);assert.equal(c.totals.prepared,17);assert.equal(c.totals.attempted,18);assert.equal(c.totals.unresolved,1);assert.equal(c.totals.blocked,1);assert.equal(c.totals.deferred,1);assert(c.batches[0].closed_at);
 assert.equal(c.members.filter(m=>m.batch_number===2&&first.includes(m.job_id)).length,0);
 f.db.close();const db=new DatabaseSync(path);installAutomaticCampaign(db);c=populateAutomaticCampaign(db,'u');assert.equal(c.current_batch,2);assert.equal(c.totals.selected,40);
 assert.throws(()=>reserveAutonomousAttempt(db,first[0],'u','hosted-worker'));
 db.prepare("UPDATE jobs SET status='submitted',confirmation='Thank you for applying' WHERE id=?").run(first[0]);db.prepare("INSERT INTO events VALUES(?,?,'manual_confirmation','Receipt found later')").run(first[0],new Date().toISOString());
 c=populateAutomaticCampaign(db,'u');assert.equal(c.totals.confirmed,18);assert.equal(c.totals.assisted,1);assert.equal(c.totals.unresolved,0);assert.equal(c.current_batch,2);db.close();rmSync(dir,{recursive:true});
});

test('Stop is checked before durable reservation; restart cannot grant another attempt or open a second running job',()=>{
 const f=fixture();for(let n=0;n<25;n++)f.add('j'+n,roles[n%3]);const c=f.start(),id=c.members[0].job_id,other=c.members[1].job_id;
 stopAutomaticCampaign(f.db,'u');assert.equal(focusAllowsSubmit(f.db,f.get(id)),false);assert.throws(()=>reserveAutonomousAttempt(f.db,id,'u','hosted-worker'));
 assert.equal(f.start().totals.selected,20);f.db.prepare("UPDATE jobs SET status='running',attempts=1 WHERE id=?").run(id);
 assert.match(savedSearchClaimProblem(f.db,f.get(other)),/Another hosted/);
 assert.equal(reserveAutonomousAttempt(f.db,id,'u','hosted-worker').permitted,true);
 assert.throws(()=>reserveAutonomousAttempt(f.db,id,'u','hosted-worker'));
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM autonomous_attempts').get().n,1);
 f.db.prepare("UPDATE jobs SET status='needs_review',challenge='Unconfirmed submission' WHERE id=?").run(id);
 populateAutomaticCampaign(f.db,'u');assert.equal(savedSearchClaimProblem(f.db,f.get(other)),'');
 stopAutomaticCampaign(f.db,'u');f.start();assert.throws(()=>reserveAutonomousAttempt(f.db,id,'u','hosted-worker'));f.db.close();
});

test('hosted claim progresses with full retained handoffs but never opens two active campaign jobs',()=>{
 const f=fixture();f.db.exec('ALTER TABLE jobs ADD COLUMN discovery_priority DEFAULT 0;ALTER TABLE jobs ADD COLUMN lease_at');for(let n=0;n<21;n++)f.add('j'+n,roles[n%3]);f.start();
 const source=readFileSync('worker.js','utf8'),code=source.slice(source.indexOf('function claim(){'),source.indexOf('\nasync function pageIssue'));
 const claim=new Function('handoffs','db','ensureFocusedJob','prioritizeApplications','now','event','savedSearchClaimProblem','populateAutomaticCampaign','automaticMember','employerHold','automaticCampaign',code+';return claim;')({full:()=>true},f.db,()=>{},prioritizeApplications,()=>new Date().toISOString(),()=>{},savedSearchClaimProblem,populateAutomaticCampaign,automaticMember,employerHold,automaticCampaign);
 const first=claim();assert(first);assert.equal(f.get(first.id).status,'running');assert.equal(claim(),undefined);
 f.db.prepare("UPDATE jobs SET status='needs_review',challenge='Missing personal fact' WHERE id=?").run(first.id);
 const second=claim();assert(second);assert.notEqual(second.id,first.id);assert.equal(f.get(first.id).status,'needs_review');
 f.db.prepare("UPDATE jobs SET status='needs_review',challenge='Missing personal fact' WHERE id=?").run(second.id);stopAutomaticCampaign(f.db,'u');assert.equal(claim(),undefined);f.db.close();
});


test('manual batch advances once, preserves prior uncertainty and cannot reserve an automatic Submit',()=>{
 const f=fixture();f.add('old');f.start();f.db.exec("UPDATE jobs SET status='needs_review',challenge='Unconfirmed submission',local_attempt_at='2026' WHERE id='old'");populateAutomaticCampaign(f.db,'u');stopAutomaticCampaign(f.db,'u');
 const old=f.get('old');for(let n=0;n<25;n++)f.add('fresh'+n,roles[n%3]);
 const input={applicant_id:'p',mode:'prepare_only',auto_submit:false,batch_size:20,expected_batch:1};
 let c=startManualBatch(f.db,'u',input);assert.equal(c.current_batch,2);assert.equal(c.mode,'prepare_only');assert.equal(c.selected,20);assert.deepEqual(f.get('old'),old);
 assert.throws(()=>startManualBatch(f.db,'u',input));const id=c.members.find(m=>m.batch_number===2).job_id;
 assert.equal(savedSearchClaimProblem(f.db,f.get(id)),'');assert.equal(focusAllowsSubmit(f.db,f.get(id)),false);
 f.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(id);assert.throws(()=>reserveAutonomousAttempt(f.db,id,'u','hosted-worker'));
 f.db.exec("UPDATE jobs SET status='needs_review',challenge='Ready to submit',handoff_available=1 WHERE id LIKE 'fresh%'");c=populateAutomaticCampaign(f.db,'u');assert.equal(c.current_batch,2);assert.equal(c.ready,20);assert.equal(c.totals.confirmed,0);assert.equal(c.totals.unresolved,1);
 stopAutomaticCampaign(f.db,'u');assert.throws(()=>f.start(),/existing batch mode/);c=f.start({mode:'prepare_only',auto_submit:false});assert.equal(c.current_batch,2);assert.equal(c.mode,'prepare_only');f.db.close();
});
