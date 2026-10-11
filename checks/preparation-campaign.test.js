import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installBatches} from '../application-batches.js';
import {installSingleApplication,focusAllowsSubmit,reserveAutonomousAttempt,setWorkFocus,savedSearchClaimProblem} from '../single-application.js';
import {installPreparationCampaign,startPreparationCampaign,populatePreparationCampaign,preparationSnapshot,preparationCandidateProblem,preparationClaimProblem,recordPreparationProgress,rotateTitles,titleGroup} from '../preparation-campaign.js';
import {normalizeSearchScope,scopeIntent} from '../search-scope.js';
import {jobIntelligence} from '../job-intelligence.js';
const roles=['AI Support Engineer','Platform Engineer','DevOps Engineer'];
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id,applicant_id,company,title,url,normalized_url,status,local_owner,local_attempt_at,local_phase,challenge,confirmation,attempts DEFAULT 0,handoff_available DEFAULT 0,match_score DEFAULT 90,created_at,updated_at,job_metadata_json DEFAULT '{}');
 CREATE TABLE applicants(id,user_id,consent,email,resume_path,execution_mode,focus);
 CREATE TABLE events(job_id,at,type,message);
 CREATE TABLE external_application_history(id,user_id,company,title,status,company_key,title_key);
 CREATE TABLE research_draft_usage(job_id,question);
 CREATE TABLE searches(id,user_id,applicant_id,enabled,instruction,created_at,scope_json);
 CREATE TABLE employer_limits(user_id,applicant_id,employer_key,hold_until,message);
 INSERT INTO applicants VALUES('p','u',1,'test@example.test','fixture.pdf','cloud','AI Support Engineer Platform Engineer DevOps Engineer');
 `);
 installBatches(db);installSingleApplication(db);installPreparationCampaign(db);
 const scope=normalizeSearchScope({roles,localPlaces:[],remotePlaces:['canada'],remoteWorldwide:true,remoteFromCountry:'canada',authorizedCountries:['canada'],allowEmploymentFallback:true,preferBusinessContract:true,preferRemote:true});
 db.prepare('INSERT INTO searches VALUES(?,?,?,?,?,?,?)').run('s','u','p',1,'Role rotation','2026',JSON.stringify(scope));
 db.exec("INSERT INTO work_focus(user_id,enabled,job_id,auto_submit,skip_blocked) VALUES('u',1,NULL,1,1);INSERT INTO application_batch_preferences VALUES('u','p',1,'old',120000,'','2026')");
 function add(id,title=roles[0],company=id){const url='https://jobs.lever.co/'+id+'/role',m=jobIntelligence({title,location:'Remote Canada',remote:true,description:'Fully remote within Canada. Full-time employment.'},scopeIntent(scope));db.prepare("INSERT INTO jobs(id,user_id,applicant_id,company,title,url,normalized_url,status,created_at,job_metadata_json) VALUES(?,'u','p',?,?,?,?,'saved','2026',?)").run(id,company,title,url,url,JSON.stringify(m));return get(id);}
 const get=id=>db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
 return {db,add,get,start:(options={})=>startPreparationCampaign(db,'u',{applicant_id:'p',...options})};
}
test('title rotation persists across batches and prioritizes distinct requested titles',()=>{
 const jobs=[{id:1,title:'AI Support Engineer'},{id:2,title:'AI Support Engineer'},{id:3,title:'Platform Engineer'},{id:4,title:'DevOps Engineer'}];
 assert.deepEqual(rotateTitles(jobs,roles).map(j=>j.id),[1,3,4,2]);
 assert.deepEqual(rotateTitles(jobs,roles,[{title_group:roles[0]}]).map(j=>j.id),[3,4,1,2]);
 assert.equal(titleGroup('Staff Platform Engineer',roles),'Platform Engineer');
 assert.equal(titleGroup('Senior SRE',['Site Reliability Engineer']),'Site Reliability Engineer');
});
test('200 campaign selects 20 at a time, never submits, and preserves the title wheel on refill',()=>{
 const f=fixture();for(let n=0;n<210;n++)f.add('j'+n,roles[n%3]);
 let c=f.start();assert.equal(c.selected,20);assert.equal(c.prepared,0);assert.equal(c.ready,0);assert.equal(c.completed,0);
 assert.deepEqual(c.members.slice(0,3).map(j=>j.title_group),roles);
 const selected=f.get(c.members[0].job_id);assert.equal(focusAllowsSubmit(f.db,selected),false);
 assert.match(savedSearchClaimProblem(f.db,selected),/Chrome preparation/);assert.equal(preparationClaimProblem(f.db,selected),'');
 assert.throws(()=>setWorkFocus(f.db,'u',{enabled:true,auto_submit:true}),/preparation campaign/);
 assert.throws(()=>reserveAutonomousAttempt(f.db,selected.id,'u','local-browser'));
 assert.equal(f.db.prepare('SELECT auto_submit FROM work_focus').get().auto_submit,0);
 assert.equal(populatePreparationCampaign(f.db,'u').selected,20);
 for(let batch=0;batch<10;batch++){
  f.db.exec("UPDATE jobs SET status='submitted',confirmation='Thank you for applying' WHERE id IN (SELECT job_id FROM preparation_members)");
  c=populatePreparationCampaign(f.db,'u');
 }
 assert.equal(c.selected,200);assert.equal(c.completed,200);assert.equal(c.prepared,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='saved'").get().n,10);
 f.db.exec("UPDATE preparation_campaigns SET enabled=0;UPDATE work_focus SET enabled=1,auto_submit=1");
 assert.equal(focusAllowsSubmit(f.db,f.get(selected.id)),false,'campaign membership stays manual-submit after pausing');
 c=f.start();assert.equal(c.selected,200);assert.equal(f.db.prepare('SELECT auto_submit FROM work_focus').get().auto_submit,0);f.db.close();
});
test('receipt history, interviews, holds, stale postings, other accounts and possible attempts are excluded',()=>{
 const f=fixture();f.add('good');
 f.add('interview','AI Support Engineer','OpenAI');f.db.exec("INSERT INTO external_application_history VALUES('interview','u','OpenAI','AI Support Engineer (Weekend Shift)','interview','openai','aisupportengineerweekendshift')");
 f.add('attempt');f.db.exec("INSERT INTO autonomous_attempts VALUES('attempt','local-browser','2026')");
 f.add('stale');f.db.exec("UPDATE jobs SET job_metadata_json=json_set(job_metadata_json,'$.checkedAt','2020-01-01') WHERE id='stale'");
 f.add('foreign');f.db.exec("UPDATE jobs SET user_id='other' WHERE id='foreign'");
 f.add('previous');f.db.exec("UPDATE jobs SET status='submitted',confirmation='Thank you for applying' WHERE id='previous'");
 const before=f.get('previous'),c=f.start();assert.deepEqual(c.members.map(m=>m.job_id),['good']);assert.deepEqual(f.get('previous'),before);
 assert.match(preparationCandidateProblem(f.db,f.get('interview')),/interview/);
 assert.match(preparationClaimProblem(f.db,f.get('attempt')),/outside/);
 f.db.close();
});
test('ready counts need a final form signal, complete required fields, live heartbeat and correct employer identity',()=>{
 const f=fixture();f.add('good');let c=f.start();f.db.exec("UPDATE jobs SET status='local_browser',local_phase='blocked' WHERE id='good'");
 const j=f.get('good'),input={blocked:true,fields:[],readyForSubmit:true,progress:{required:3,filled:3},url:j.url};
 for(const change of [{readyForSubmit:false},{fields:['Unknown fact']},{progress:{required:0,filled:0}},{progress:{required:3,filled:2}},{url:'https://jobs.lever.co/else/role'},{blocked:false}]){recordPreparationProgress(f.db,j,{...input,...change});assert.equal(preparationSnapshot(f.db,'u').prepared,0);}
 recordPreparationProgress(f.db,j,input);c=preparationSnapshot(f.db,'u');assert.equal(c.ready,1);assert.equal(c.prepared,1);assert.equal(c.completed,0);
 f.db.exec("UPDATE preparation_members SET ready_at='2020'");assert.equal(preparationSnapshot(f.db,'u').ready,0);assert.equal(preparationSnapshot(f.db,'u').prepared,1);
 f.db.exec("UPDATE jobs SET local_attempt_at='2026' WHERE id='good'");recordPreparationProgress(f.db,f.get('good'),input);assert.equal(preparationSnapshot(f.db,'u').ready,0);
 f.db.close();
});
test('switching or resuming is blocked while a hosted form is executing without changing state',()=>{
 const f=fixture();f.add('running');f.db.exec("UPDATE jobs SET status='running'");assert.throws(()=>f.start(),/hosted form/);assert.equal(preparationSnapshot(f.db,'u').enabled,false);f.db.close();
});

