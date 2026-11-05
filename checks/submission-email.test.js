// Submission summary email: fixture database and a fake mail provider only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import '../local-policy.js';
import {installNotifications,sendSubmissionEmails,submissionRecipient,submissionEmailText} from '../notifications.js';

const env={RESEND_API_KEY:'test-only',BLOCKER_EMAIL_FROM:'applypilot@example.com',PUBLIC_ORIGIN:'https://example.com'};
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,created_at TEXT);
  CREATE TABLE applicants(id TEXT PRIMARY KEY,user_id TEXT,name TEXT,email TEXT,phone TEXT);
  CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,status TEXT,challenge TEXT,required_fields_json TEXT,local_phase TEXT,title TEXT,company TEXT,url TEXT,confirmation TEXT,job_metadata_json TEXT,local_attempt_at TEXT,updated_at TEXT);
  CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT,at TEXT,type TEXT,message TEXT);
  CREATE TABLE answer_history(job_id TEXT);
  INSERT INTO users VALUES('u','owner@example.com','2020-01-01');
  INSERT INTO applicants VALUES('p','u','Fixture Applicant','fixture@example.test','+1 416 555 0100');`);
 installNotifications(db);
 return db;
}
const add=(db,{id,url,title='Senior SRE',company='Acme Cloud',confirmation,at='2026-11-05T15:00:00.000Z',status='submitted',meta={}})=>{
 db.prepare("INSERT INTO jobs(id,user_id,applicant_id,status,title,company,url,confirmation,job_metadata_json,local_attempt_at,updated_at) VALUES(?,'u','p',?,?,?,?,?,?,?,?)").run(id,status,title,company,url,confirmation??null,JSON.stringify(meta),at,at);
 if(confirmation)db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'submitted',?)").run(id,at,'Employer receipt: '+confirmation);
};
const optIn=(db,email,since='2026-11-05T14:00:00.000Z')=>db.prepare("INSERT INTO submission_email_preferences(user_id,email,since) VALUES('u',?,?) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,since=excluded.since").run(email,since);

test('recipient address is validated and normalized',()=>{
 assert.equal(submissionRecipient(' JJWorks81@Gmail.com '),'jjworks81@gmail.com');
 assert.equal(submissionRecipient(''),'');
 for(const bad of ['not-an-email','a@b','x@example.com\nBcc: y@example.com'])assert.throws(()=>submissionRecipient(bad));
});

test('one email per confirmed application, direct and job-board, only after opt-in, never for unconfirmed outcomes',async()=>{
 const db=fixture(),sent=[];const fetchImpl=async(url,opts)=>{sent.push({url,opts});return {ok:true};};
 add(db,{id:'old',url:'https://boards.greenhouse.io/acme/jobs/1',confirmation:'Thank you for applying.',at:'2026-11-01T00:00:00.000Z'});
 add(db,{id:'gh',url:'https://boards.greenhouse.io/acme/jobs/2',title:'Platform Engineer',confirmation:'Thank you for applying.',meta:{foundVia:'direct-discovery',location:'Remote, Canada',remote:true,pay:[{min:120000,max:150000,currency:'CAD',period:'year'}],eligibility:{reason:'Explicit B2B or incorporated contractor terms'}}});
 add(db,{id:'li',url:'https://www.linkedin.com/jobs/view/4012345678',confirmation:'Your application was sent to Acme Cloud!',meta:{foundVia:'linkedin',native:{eligible:true,location:'Remote · Canada',hiring:{signals:[{kind:'posted',evidence:'2 days ago'},{kind:'applicants',evidence:'18 applicants'}]}}}});
 add(db,{id:'uncertain',url:'https://jobs.lever.co/acme/x',status:'local_browser'});
 add(db,{id:'placeholder',url:'https://jobs.ashbyhq.com/acme/y',confirmation:'Application not yet submitted'});
 // Not configured or not opted in: nothing is sent.
 assert.equal((await sendSubmissionEmails(db,{env:{},fetchImpl})).configured,false);
 await sendSubmissionEmails(db,{env,fetchImpl});assert.equal(sent.length,0);
 optIn(db,'jjworks81@gmail.com');
 await sendSubmissionEmails(db,{env,fetchImpl});await sendSubmissionEmails(db,{env,fetchImpl});
 const bodies=sent.map(s=>JSON.parse(s.opts.body));
 assert.deepEqual(bodies.map(b=>b.subject).sort(),['Applied: Platform Engineer — Acme Cloud','Applied: Senior SRE — Acme Cloud']);
 assert(bodies.every(b=>b.to.length===1&&b.to[0]==='jjworks81@gmail.com'));
 const gh=bodies.find(b=>b.subject.includes('Platform')).text,li=bodies.find(b=>b.subject.includes('Senior')).text;
 for(const fact of ['Job link: https://boards.greenhouse.io/acme/jobs/2','Applied through: Direct employer application','Found via: direct-discovery','Location: Remote, Canada','CAD 120,000 – 150,000 per year','Employer confirmation: Thank you for applying.','Applicant profile: Fixture Applicant, fixture@example.test','https://example.com/automate.html#job-gh'])assert(gh.includes(fact),fact+'\n'+gh);
 for(const fact of ['Applied through: LinkedIn Easy Apply','Hiring signals: 2 days ago; 18 applicants','Posted pay: Not published','Employer confirmation: Your application was sent to Acme Cloud!'])assert(li.includes(fact),fact+'\n'+li);
 assert(!JSON.stringify(bodies).includes('555 0100'),'no phone or form contents');
 // Retry uses the same payload and idempotency key; a sent email is never repeated.
 db.prepare("UPDATE submission_emails SET state='pending',next_attempt=0 WHERE job_id='gh'").run();
 const retry=[];await sendSubmissionEmails(db,{env,fetchImpl:async(u,o)=>{retry.push(o);return {ok:true};}});
 assert.equal(retry.length,1);assert.equal(retry[0].body,sent.find(s=>s.opts.body.includes('Platform')).opts.body);
 db.close();
});

test('failed delivery retries with the same key, and new public accounts cannot send',async()=>{
 const db=fixture();add(db,{id:'gh',url:'https://boards.greenhouse.io/acme/jobs/2',confirmation:'Thank you for applying.'});optIn(db,'jjworks81@gmail.com');
 const calls=[];const flaky=async(u,o)=>{calls.push(o);return {ok:calls.length>1,status:503};};
 await sendSubmissionEmails(db,{env,fetchImpl:flaky,time:1000000});await sendSubmissionEmails(db,{env,fetchImpl:flaky,time:1100000});
 assert.equal(calls.length,1,'waits before retrying');
 await sendSubmissionEmails(db,{env,fetchImpl:flaky,time:1400000});assert.equal(calls.length,2);
 assert.equal(calls[0].headers['Idempotency-Key'],calls[1].headers['Idempotency-Key']);
 assert.equal(db.prepare("SELECT state FROM submission_emails").get().state,'sent');
 db.close();
 const fresh=fixture();fresh.prepare("INSERT INTO public_account_security(user_id,email_verified_at) VALUES('u',NULL)").run();
 add(fresh,{id:'gh',url:'https://boards.greenhouse.io/acme/jobs/2',confirmation:'Thank you for applying.'});optIn(fresh,'jjworks81@gmail.com');
 const none=[];await sendSubmissionEmails(fresh,{env,fetchImpl:async(u,o)=>{none.push(o);return {ok:true};}});
 assert.equal(none.length,0,'unverified public account');fresh.close();
});

test('email text omits empty facts and contains no raw newlines from job data',()=>{
 const text=submissionEmailText({id:'x',title:'SRE\nBcc: evil@example.com',company:'Acme',url:'https://jobs.lever.co/acme/1',confirmation:'Thanks',job_metadata_json:'{}'},{origin:'https://example.com'});
 assert(!/\nBcc:/.test(text));assert(!/Location:/.test(text));assert(text.includes('Role: SRE Bcc: evil@example.com'));
});
