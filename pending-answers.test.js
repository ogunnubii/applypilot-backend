import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {resolvePendingAnswers} from './pending-answers.js';
import {installLibrary} from './answer-library.js';
import {installDrafts} from './answer-drafts.js';
import {installResearch} from './google-research.js';
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id DEFAULT 'u',applicant_id DEFAULT 'p',status DEFAULT 'needs_review',local_phase DEFAULT 'ready',local_attempt_at,confirmation,handoff_available DEFAULT 0,challenge DEFAULT 'Missing answers',required_fields_json DEFAULT '[]',answers_json DEFAULT '{}',job_metadata_json DEFAULT '{"location":"Remote Canada"}',updated_at DEFAULT '2026',title DEFAULT 'Engineer',company DEFAULT 'Fixture',url DEFAULT 'https://jobs.lever.co/fixture/role');
 CREATE TABLE applicants(id,user_id,consent,answers_json,resume_path,ai_consent,gemini_facts_consent,google_research_consent);
 CREATE TABLE events(job_id,at,type,message);CREATE TABLE autonomous_attempts(job_id,owner,started_at);
 CREATE TABLE searches(id,user_id,applicant_id,enabled,instruction,created_at,scope_json);
 INSERT INTO applicants VALUES('p','u',1,'{"Work authorization - Canada":"No","Start-up environment experience":"Yes"}',NULL,0,0,0);`);
 installLibrary(db);installDrafts(db);installResearch(db);
 const add=(id,questions)=>db.prepare('INSERT INTO jobs(id,required_fields_json) VALUES(?,?)').run(id,JSON.stringify(questions));
 return {db,add,run:options=>resolvePendingAnswers(db,{check:()=>'',...options}),answers:id=>JSON.parse(db.prepare('SELECT answers_json FROM jobs WHERE id=?').get(id).answers_json)};
}
test('server resolves a fictional applicant’s approved eligibility and experience facts without a dashboard or model',async()=>{
 const f=fixture(),questions=['Are you authorized to work in Canada?','Do you have experience working in a start-up environment?✱','What are your salary expectations?'];
 f.add('hosted',questions);f.add('local',questions);f.db.exec("UPDATE jobs SET status='local_browser',local_phase='blocked' WHERE id='local'");
 const r=await f.run();assert.equal(r.filled,4);for(const id of ['hosted','local'])assert.deepEqual(f.answers(id),{[questions[0]]:'No',[questions[1]]:'Yes'});
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type='submission_started' OR type='human_assistance'").get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM draft_usage').get().n,0);
 assert.equal(f.db.prepare("SELECT state FROM pending_answer_attempts WHERE job_id='hosted' AND question=?").get(questions[2]).state,'deferred');f.db.close();
});
test('pending answer recovery never touches attempted, confirmed, live or excluded applications',async()=>{
 for(const mutation of ["UPDATE jobs SET local_attempt_at='2026'","INSERT INTO autonomous_attempts VALUES('j','worker','2026')","INSERT INTO events VALUES('j','2026','applicant_reported_submission','Clicked')","UPDATE jobs SET status='submitted',confirmation='Thank you for applying'","UPDATE jobs SET handoff_available=1","UPDATE jobs SET local_phase='uncertain'","UPDATE jobs SET status='archived'"]){
  const f=fixture();f.add('j',['Describe your experience']);f.db.exec(mutation);let called=0;await f.run({answer:async()=>{called++;return {answer:'should never save'};}});assert.equal(called,0,mutation);assert.deepEqual(f.answers('j'),{});f.db.close();
 }
 const f=fixture();f.add('j',['Describe your experience']);await f.run({check:()=> 'Employer security hold',answer:()=>{throw Error('must not call')}});assert.deepEqual(f.answers('j'),{});f.db.close();
});

test('background contact answers use verified profile fields and never send contact conflicts to AI',async()=>{
 const f=fixture();f.db.exec("ALTER TABLE applicants ADD COLUMN name; ALTER TABLE applicants ADD COLUMN email; ALTER TABLE applicants ADD COLUMN phone; ALTER TABLE applicants ADD COLUMN location; UPDATE applicants SET name='Fictional Example',email='fictional@example.invalid',phone='+442079460000',location='London, UK'");
 f.add('j',['Full name','Email','Phone','Current location']);let calls=0;
 const answer=async()=>{calls++;return {answer:'must not be used'};};
 assert.equal((await f.run({answer})).filled,4);assert.equal(calls,0);
 assert.deepEqual(f.answers('j'),{'Full name':'Fictional Example',Email:'fictional@example.invalid',Phone:'+442079460000','Current location':'London, UK'});
 f.db.exec("UPDATE applicants SET answers_json='{\"Email\":\"conflict@example.invalid\"}'");f.add('conflict',['Email']);
 assert.equal((await f.run({answer})).filled,0);assert.equal(calls,0);assert.deepEqual(f.answers('conflict'),{});
 f.db.exec("UPDATE applicants SET email='conflict@example.invalid'");
 assert.equal((await f.run({answer})).filled,1,'profile correction invalidates the deferred answer fingerprint');assert.equal(calls,0);
 assert.equal(f.answers('conflict').Email,'conflict@example.invalid');f.db.close();
});
test('provider failures are bounded and do not stop supported jobs; edits and new attempts win over AI',async()=>{
 const f=fixture();f.add('bad',['Describe your skills']);f.add('good',['Explain your background']);let calls=0;
 const answer=async input=>{assert.equal(input.persist,false);calls++;if(input.job.id==='bad')throw Error('Provider offline');return {answer:'Saved professional experience.',source:'approved_facts'};};
 assert.equal((await f.run({answer})).filled,1);await f.run({answer});assert.equal(calls,2);assert.deepEqual(f.answers('bad'),{});assert.equal(f.answers('good')['Explain your background'],'Saved professional experience.');f.db.close();
 for(const mutation of ["UPDATE applicants SET consent=0","UPDATE jobs SET local_attempt_at='2026'","UPDATE jobs SET answers_json='{\"Describe your skills\":\"My correction\"}'"]){
  const f=fixture();f.add('j',['Describe your skills']);const result=await f.run({answer:async()=>{f.db.exec(mutation);return {answer:'Stale AI answer',source:'approved_facts'};}});assert.equal(result.filled,0);assert.notEqual(f.answers('j')['Describe your skills'],'Stale AI answer');f.db.close();
 }
});

test('an explicit saved annual CAD floor answers salary expectations without an active legacy batch',async()=>{
 const f=fixture(),question='What are your salary expectations?';f.add('j',[question]);
 f.db.exec("UPDATE applicants SET answers_json='{\"Minimum annual salary target (CAD)\":\"87000\"}'");
 assert.equal((await f.run()).filled,1);assert.equal(f.answers('j')[question],'At least CAD 87,000 per year, depending on the role and total compensation.');
 for(const value of ['87000 USD','-87000','not supplied']){
  f.add(value,[question]);f.db.prepare('UPDATE applicants SET answers_json=?').run(JSON.stringify({'Minimum annual salary target (CAD)':value}));
  await f.run();assert.deepEqual(f.answers(value),{});
 }
 f.db.close();
});
