import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installUnresolvedAttempts,unresolvedAttemptEligibility,unresolvedAttemptState,unresolvedAttemptQuarantined,parkUnresolvedAttempt} from '../unresolved-attempts.js';
import {applicationEvidence} from '../operation-evidence.js';
import {inFlightApplication} from '../single-application.js';
function fixture(path=':memory:'){
 const db=new DatabaseSync(path);db.exec("PRAGMA foreign_keys=ON; CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id,applicant_id,status,challenge,local_phase,local_attempt_at,attempts,local_owner,lease_at,handoff_available,confirmation,updated_at);CREATE TABLE events(job_id,at,type,message);CREATE TABLE work_focus(user_id PRIMARY KEY,enabled,auto_submit,skip_blocked,job_id);CREATE TABLE continuation_requests(user_id,job_id,state);INSERT INTO jobs VALUES('j','u','p','submitted','Applicant reported submission','verifying','2026-10-05T04:00:44Z',1,'original-browser',NULL,0,NULL,'2026-10-05T04:00:44Z');INSERT INTO events VALUES('j','2026-10-05T04:00:44Z','applicant_reported_submission','Reported without receipt');INSERT INTO work_focus VALUES('u',1,1,1,'j'),('other',1,1,1,'other-job');");installUnresolvedAttempts(db);return db;
}
const row=db=>db.prepare("SELECT * FROM jobs WHERE id='j'").get();
test('a stopped hosted attempt can stay unresolved without losing counts or permitting retries',()=>{
 const db=fixture();db.exec("CREATE TABLE autonomous_attempts(job_id,owner,created_at);INSERT INTO autonomous_attempts VALUES('j','hosted-worker','2026');DELETE FROM events;UPDATE jobs SET status='needs_review',challenge='Unconfirmed submission',local_owner=NULL;INSERT INTO events VALUES('j','2026','submission_started','Intent'),('j','2026','automatic_submission','Reserved'),('j','2026','needs_review','No receipt')");
 const before=row(db),state=unresolvedAttemptEligibility(db,before);assert.equal(state.eligible,true);
 parkUnresolvedAttempt(db,'u','j',state.evidence);assert.deepEqual(row(db),before);assert(unresolvedAttemptQuarantined(db,row(db)));assert.equal(inFlightApplication(db,'u'),undefined);
 assert(applicationEvidence({...row(db),attempt_event:true}).awaiting);assert(!applicationEvidence(row(db)).confirmed);
 assert.throws(()=>db.exec("UPDATE jobs SET status='queued' WHERE id='j'"),/retries/);db.close();
});
test('hosted unresolved parking refuses an active browser, missing reservation or unfinished worker',()=>{
 for(const mutation of ["UPDATE jobs SET handoff_available=1","DELETE FROM autonomous_attempts","INSERT INTO events VALUES('j','2026','running','Restarted')","UPDATE jobs SET local_owner='browser'"]){
  const db=fixture();db.exec("CREATE TABLE autonomous_attempts(job_id,owner,created_at);INSERT INTO autonomous_attempts VALUES('j','hosted-worker','2026');UPDATE jobs SET status='needs_review',challenge='Unconfirmed submission',local_owner=NULL;INSERT INTO events VALUES('j','2026','needs_review','No receipt')");
  db.exec(mutation);assert.equal(unresolvedAttemptEligibility(db,row(db)).eligible,false,mutation);db.close();
 }
});
test('explicit owner-bound marker preserves uncertain outcome and job evidence, pauses only owner and never repeats execution',()=>{
 const db=fixture(),before=row(db),other=db.prepare("SELECT * FROM work_focus WHERE user_id='other'").get(),evidence=unresolvedAttemptEligibility(db,before).evidence;
 assert.throws(()=>parkUnresolvedAttempt(db,'other','j',evidence),/not found/);assert.throws(()=>unresolvedAttemptState(db,'other','j'),/not found/);assert.equal(db.prepare('SELECT COUNT(*) n FROM unresolved_attempt_quarantines').get().n,0);
 const result=parkUnresolvedAttempt(db,'u','j',evidence);assert(result.parked);assert.deepEqual(row(db),before);assert.deepEqual(db.prepare("SELECT * FROM work_focus WHERE user_id='other'").get(),other);assert.deepEqual(db.prepare("SELECT enabled,auto_submit,job_id FROM work_focus WHERE user_id='u'").get(),Object.assign(Object.create(null),{enabled:0,auto_submit:0,job_id:null}));
 assert(unresolvedAttemptQuarantined(db,row(db)));assert.equal(inFlightApplication(db,'u'),undefined);const counts=job=>applicationEvidence({...job,reported_event:true,attempt_event:true});assert.deepEqual(counts(row(db)),counts(before));assert.equal(counts(row(db)).confirmed,false);assert.equal(counts(row(db)).awaiting,true);
 for(const change of ["status='queued'","status='running'","status='local_browser'","local_phase='ready'","local_owner='new-browser'","local_attempt_at='new-attempt'","attempts=attempts+1","lease_at='new-lease'","handoff_available=1"])assert.throws(()=>db.exec('UPDATE jobs SET '+change+" WHERE id='j'"),/execution and retries/);
 db.close();
});
test('atomic idempotency across connections never clears a later different focus or creates duplicate park events',()=>{
 const dir=mkdtempSync(join(tmpdir(),'unresolved-test-')),path=join(dir,'fixture.sqlite'),a=fixture(path),b=new DatabaseSync(path);try{
 const evidence=unresolvedAttemptEligibility(a,row(a)).evidence;parkUnresolvedAttempt(a,'u','j',evidence);a.exec("UPDATE work_focus SET enabled=1,auto_submit=1,job_id='different' WHERE user_id='u'");const replay=parkUnresolvedAttempt(b,'u','j',evidence);assert(replay.alreadyParked);assert.match(replay.message,/No new execution.*settings changed/);assert.equal(a.prepare("SELECT job_id FROM work_focus WHERE user_id='u'").get().job_id,'different');assert.equal(a.prepare("SELECT auto_submit FROM work_focus WHERE user_id='u'").get().auto_submit,1);assert.equal(a.prepare("SELECT COUNT(*) n FROM events WHERE type='unresolved_attempt_parked'").get().n,1);
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test('unknown/live states and stale evidence fail closed, including changed evidence after parking',()=>{
 for(const sql of ["UPDATE jobs SET status='running'","UPDATE jobs SET status='local_browser'","UPDATE jobs SET challenge='Submission in progress'","UPDATE jobs SET challenge=NULL","UPDATE jobs SET handoff_available=1","UPDATE jobs SET local_attempt_at=NULL","DELETE FROM events","INSERT INTO continuation_requests VALUES('u','j','dispatching')"]){const db=fixture();db.exec(sql);const state=unresolvedAttemptEligibility(db,row(db));assert.equal(state.eligible,false,sql);assert(state.reason);assert.throws(()=>parkUnresolvedAttempt(db,'u','j','a'.repeat(64)));assert.equal(db.prepare('SELECT COUNT(*) n FROM unresolved_attempt_quarantines').get().n,0);db.close();}
 const db=fixture(),old=unresolvedAttemptEligibility(db,row(db)).evidence;db.exec("INSERT INTO events VALUES('j','2026-10-06T00:00:00Z','manual_submission_retry','New evidence')");assert.throws(()=>parkUnresolvedAttempt(db,'u','j',old),/evidence changed/);const fresh=unresolvedAttemptEligibility(db,row(db)).evidence;parkUnresolvedAttempt(db,'u','j',fresh);db.exec("INSERT INTO events VALUES('j','2026-10-07T00:00:00Z','submission_started','Late evidence')");assert.equal(unresolvedAttemptQuarantined(db,row(db)),false);assert.equal(inFlightApplication(db,'u').id,'j');assert.throws(()=>parkUnresolvedAttempt(db,'u','j',unresolvedAttemptEligibility(db,row(db)).evidence),/evidence changed/);db.close();
});
test('a genuine later receipt reconciles the outcome without removing the future-execution fence',()=>{
 const db=fixture();parkUnresolvedAttempt(db,'u','j',unresolvedAttemptEligibility(db,row(db)).evidence);db.exec("UPDATE jobs SET confirmation='Thank you for applying',challenge=NULL WHERE id='j';INSERT INTO events VALUES('j','2026-10-08T00:00:00Z','manual_confirmation','Employer receipt verified')");const state=unresolvedAttemptState(db,'u','j');assert.equal(state.receipt_confirmed,true);assert.equal(state.parked,true);assert.equal(state.quarantined,false);assert.equal(inFlightApplication(db,'u'),undefined);assert.throws(()=>db.exec("UPDATE jobs SET status='queued' WHERE id='j'"),/retries are blocked/);db.close();
});
