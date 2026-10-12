import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {applicationLimit,applicationQuota,installEmployerLimits,recordEmployerLimit,employerHold,employerQuotas} from './employer-limits.js';
import {receipt} from './local-policy.js';

const notice='Heads up on application limits. You can submit up to 3 applications within a 60-day period with us.';
const refusal="We couldn't submit your application. Thanks for your interest in Camunda! We limit submissions to 2 per person within a 30-day period.";
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,company TEXT,title TEXT,url TEXT,status TEXT,local_phase TEXT,challenge TEXT,local_attempt_at TEXT,confirmation TEXT,updated_at TEXT);
 CREATE TABLE events(id INTEGER PRIMARY KEY,job_id TEXT,at TEXT,type TEXT,message TEXT);`);
 installEmployerLimits(db);
 const put=(id,board='camunda',extra={})=>{
  const j={id,user_id:'u',applicant_id:'p',company:board,title:id,url:'https://jobs.ashbyhq.com/'+board+'/'+id,status:'saved',local_phase:'ready',challenge:null,local_attempt_at:null,confirmation:null,updated_at:null,...extra};
  db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(j));return j;
 };
 const event=(id,at,type='submitted',message='Your application was successfully submitted.')=>{db.prepare('INSERT INTO events(job_id,at,type,message) VALUES(?,?,?,?)').run(id,at,type,message);if(type==='submitted'||type==='manual_confirmation')db.prepare("UPDATE jobs SET confirmation=?,status='submitted' WHERE id=?").run(message,id);};
 return {db,put,event};
}
test('quota notice is not a refusal; Camunda 2/30 refusal is recognized and never a receipt',()=>{
 assert.deepEqual(applicationQuota(notice),{count:3,days:60});assert.equal(applicationLimit(notice),null);
 assert.deepEqual(applicationQuota(refusal),{count:2,days:30});assert.equal(applicationLimit(refusal).count,2);assert.equal(receipt(refusal),'');
 assert.equal(receipt('Success\nYour application was successfully submitted.'),'Your application was successfully submitted.');
 assert.equal(applicationQuota('We support 3 applications. Employee benefits start within 60 days.'),null);
});
test('policy notice alone does not block; only distinct receipts exhaust the rolling quota',()=>{
 const {db,put,event}=fixture(),j=put('next');put('first');put('second');put('duplicate','camunda',{url:'https://jobs.ashbyhq.com/camunda/first/application?source=x'});
 const policy='We limit submissions to 2 per person within a 30-day period.';
 const at='2099-02-01T00:00:00.000Z';
 event('first','2099-01-15T12:00:00.000Z');event('first','2099-01-16T12:00:00.000Z','manual_confirmation');event('duplicate','2099-01-16T12:00:00.000Z');
 let result=recordEmployerLimit(db,'u',j.id,policy,{at});assert.equal(result.held,0);assert.equal(employerHold(db,j,at),null);
 let audit=employerQuotas(db,'u',at)[0];assert.equal(audit.confirmed_in_window,1);assert.equal(audit.remaining_from_records,1);
 event('second','2099-01-20T12:00:00.000Z');
 db.prepare("UPDATE jobs SET status='interview',updated_at='2099-01-30' WHERE id='first'").run();
 let hold=employerHold(db,j,at);assert.equal(hold.hold_until,'2099-02-14T12:00:00.000Z');assert.equal(hold.confirmed_in_window,2);assert.equal(hold.basis,'recorded-receipts');
 assert.throws(()=>db.prepare("UPDATE jobs SET status='queued' WHERE id='next'").run(),/Employer application limit/);
 assert.equal(employerHold(db,j,'2099-02-14T12:00:00.000Z'),null);
 assert.equal(employerQuotas(db,'u','2099-02-14T12:00:00.000Z')[0].remaining_from_records,1);
 db.prepare("UPDATE jobs SET status='queued' WHERE id='next'").run();db.close();
});
test('known receipts shorten an explicit hold; missing history retains the original conservative date',()=>{
 const {db,put,event}=fixture(),j=put('next');put('first');put('second');
 event('first','2099-01-15T12:00:00.000Z');event('second','2099-01-20T12:00:00.000Z');
 let r=recordEmployerLimit(db,'u',j.id,refusal,{at:'2099-02-01T00:00:00.000Z'});assert.equal(r.holdUntil,'2099-02-14T12:00:00.000Z');
 r=recordEmployerLimit(db,'u',j.id,refusal,{at:'2099-02-02T00:00:00.000Z'});assert.equal(r.holdUntil,'2099-02-14T12:00:00.000Z');
 assert.equal(employerHold(db,j,'2099-02-14T12:00:00.000Z'),null);
 const other=put('other','another');r=recordEmployerLimit(db,'u',other.id,refusal,{at:'2099-02-01T00:00:00.000Z'});assert.equal(r.holdUntil,'2099-03-03T00:00:00.000Z');
 r=recordEmployerLimit(db,'u',other.id,refusal,{at:'2099-02-02T00:00:00.000Z'});assert.equal(r.holdUntil,'2099-03-03T00:00:00.000Z');
 assert.equal(employerHold(db,other,'2099-03-03T00:00:00.000Z'),null);db.close();
});
test('attempts, placeholders, queued jobs and other applicants cannot consume confirmed places',()=>{
 const {db,put,event}=fixture(),j=put('next');
 put('attempt','camunda',{local_attempt_at:'2099-01-30T00:00:00.000Z'});event('attempt','2099-01-30T00:00:00.000Z','submission_started');
 put('placeholder');event('placeholder','2099-01-30T00:00:00.000Z','submitted','Your application was submitted. Test receipt');
 put('foreign-profile','camunda',{applicant_id:'q'});event('foreign-profile','2099-01-30T00:00:00.000Z');
 put('foreign-user','camunda',{user_id:'other'});event('foreign-user','2099-01-30T00:00:00.000Z');
 put('queued','camunda',{status:'queued'});put('different-company','supabase');event('different-company','2099-01-30T00:00:00.000Z');
 recordEmployerLimit(db,'u',j.id,notice,{at:'2099-02-01T00:00:00.000Z'});
 const audit=employerQuotas(db,'u','2099-02-01T00:00:00.000Z')[0];assert.equal(audit.confirmed_in_window,0);assert.equal(audit.uncertain_attempts,1);assert.equal(audit.remaining_from_records,3);
 assert.equal(employerHold(db,j,'2099-02-01T00:00:00.000Z'),null);db.close();
});
