import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {preparationPreferenceProblem} from '../preparation-campaign.js';
import {employmentContext,approvedEmploymentAnswer} from '../employment-answers.js';

function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE application_batch_preferences(user_id,applicant_id,enabled,minimum_cad);
 CREATE TABLE jobs(user_id,company,title,status);
 CREATE TABLE external_application_history(user_id,company,title,status);`);
 const job={user_id:'owner',applicant_id:'profile',company:'Example',title:'Platform Engineer',job_metadata_json:JSON.stringify({pay:[{currency:'CAD',annualMin:85000,annualMax:110000}]})};
 return {db,job,check:()=>preparationPreferenceProblem(db,job)};
}

test('campaign eligibility never invents a CAD120k floor without an active pay target',()=>{
 const f=fixture();try{assert.equal(f.check(),'');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM application_batch_preferences').get().n,0);}finally{f.db.close();}
});
test('disabled legacy support-batch target does not transfer into a new campaign',()=>{
 const f=fixture();try{f.db.exec("INSERT INTO application_batch_preferences VALUES('owner','profile',0,120000)");const before=f.db.prepare('SELECT * FROM application_batch_preferences').all();assert.equal(f.check(),'');assert.deepEqual(f.db.prepare('SELECT * FROM application_batch_preferences').all(),before);}finally{f.db.close();}
});
test('pay targets are isolated by both account and applicant',()=>{
 const f=fixture();try{f.db.exec("INSERT INTO application_batch_preferences VALUES('other','profile',1,120000),('owner','other-profile',1,120000)");assert.equal(f.check(),'');}finally{f.db.close();}
});
test('an explicitly active matching target remains enforced without inventing compensation for unknown ranges',()=>{
 const f=fixture();try{f.db.exec("INSERT INTO application_batch_preferences VALUES('owner','profile',1,120000)");assert.match(f.check(),/Published pay is below your CAD 120,000 target/);f.job.job_metadata_json=JSON.stringify({pay:[{currency:'CAD',annualMin:120000,annualMax:140000}]});assert.equal(f.check(),'');f.job.job_metadata_json='{}';assert.equal(f.check(),'');}finally{f.db.close();}
});
test('removing an implicit pay floor does not release an existing interview role',()=>{
 const f=fixture();try{f.db.exec("INSERT INTO external_application_history VALUES('owner','Example','Platform Engineer','interview')");assert.match(f.check(),/interview already exists/);}finally{f.db.close();}
});

test('hosted form construction cannot turn a disabled legacy target into an employer salary answer',async()=>{
 const f=fixture();try{
  f.db.exec("CREATE TABLE applicants(id,user_id,answers_json);INSERT INTO applicants VALUES('profile','owner','{}');INSERT INTO application_batch_preferences VALUES('owner','profile',0,120000)");
  const source=readFileSync(new URL('../worker.js',import.meta.url),'utf8');
  // Exercise the actual worker profile/context construction without opening
  // an employer page, starting its loop or reserving a submission.
  const prefix=source.slice(source.indexOf('async function run(job,browser,resumed=null){'),source.indexOf('if(!p?.consent||!p.email||!p.resume_path)return set(job'));
  assert(prefix.startsWith('async function run('));
  const profile=new Function('db','employmentContext','currentSearchScope','reusableAnswers','employerHold',prefix+'return p;}return run;')(f.db,employmentContext,()=>null,()=>({}),()=>null);
  f.job.job_metadata_json=JSON.stringify({location:'Toronto, Ontario, Canada'});f.job.answers_json='{}';
  const question={label:'What are your salary expectations?',type:'text'};
  assert.equal(approvedEmploymentAnswer(question,await profile(f.job)),null,'disabled filter must not become an unapproved salary statement');
  f.db.exec("UPDATE application_batch_preferences SET enabled=1");
  assert.match(approvedEmploymentAnswer(question,await profile(f.job)).answer,/At least CAD 120,000 per year/);
  f.db.exec("UPDATE application_batch_preferences SET applicant_id='another-profile'");
  assert.equal(approvedEmploymentAnswer(question,await profile(f.job)),null);
  f.db.exec('DELETE FROM application_batch_preferences');
  assert.equal(approvedEmploymentAnswer(question,await profile(f.job)),null);
  f.job.answers_json=JSON.stringify({'What are your salary expectations?':'My approved application-specific compensation answer.'});
  assert.equal(approvedEmploymentAnswer(question,await profile(f.job)).answer,'My approved application-specific compensation answer.');
 }finally{f.db.close();}
});
