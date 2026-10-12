import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {employerSecurityRejection} from './employer-rejection.js';
import {installEmployerLimits,recordEmployerLimit,employerHold,employerQuotas} from './employer-limits.js';
import {receipt} from './local-policy.js';
import {submitHostedApplication} from './hosted-submission.js';
import {readFileSync} from 'node:fs';

const refusal="We couldn't submit your application. Your application submission was flagged as possible spam. If you believe this was a mistake, please submit your application again.";
const url='https://jobs.ashbyhq.com/fixture/role';
test('the exact security refusal never becomes a receipt or a retry instruction',()=>{
 assert(employerSecurityRejection(refusal,url));
 assert(employerSecurityRejection("We couldn’t submit your application\nYour application submission was flagged as possible spam. If you believe this was a mistake, please submit your application again.",url));
 assert.equal(employerSecurityRejection(refusal,'https://other.test/role'),null);
 for(const text of ['Check your spam folder for the receipt.','We help detect possible spam.','If your application submission was flagged as possible spam, contact support.'])assert.equal(employerSecurityRejection(text,url),null);
 for(const text of ["If we couldn't submit your application because your application submission was flagged as possible spam, please contact support.",'Example error: '+refusal,'Example error:\n'+refusal])assert.equal(employerSecurityRejection(text,url),null);
 assert.equal(receipt(refusal),'');
 assert.equal(receipt('Thank you for applying.\nYour application submission was flagged as possible spam.'),'');
 assert.equal(receipt('Your application has been received. Check your spam folder.'),'Your application has been received.');
});

test('a security hold is durable, tenant/account scoped and never mutates old attempts or receipts',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id,applicant_id,company,url,status,challenge,local_attempt_at,confirmation);CREATE TABLE events(id INTEGER PRIMARY KEY,job_id,at,type,message);');
 installEmployerLimits(db);
 const put=(id,board='fixture',user='u',applicant='p',status='saved')=>db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,NULL,NULL,NULL)').run(id,user,applicant,board,'https://jobs.ashbyhq.com/'+board+'/'+id,status);
 put('attempt');put('old');put('next');put('other','another');put('profile','fixture','u','q');put('account','fixture','other');
 db.exec("UPDATE jobs SET status='needs_review',challenge='Unconfirmed submission',local_attempt_at='2026' WHERE id='attempt';UPDATE jobs SET status='submitted',confirmation='Your application has been received.' WHERE id='old';INSERT INTO events(job_id,at,type,message) VALUES('attempt','2026','submission_started','Reserved');");
 const get=id=>db.prepare('SELECT * FROM jobs WHERE id=?').get(id),before=db.prepare('SELECT * FROM jobs ORDER BY id').all();
 const result=recordEmployerLimit(db,'u','attempt',refusal);
 assert.equal(result.security,true);assert.deepEqual(db.prepare('SELECT * FROM jobs ORDER BY id').all(),before);
 assert.equal(employerHold(db,get('next'),'2200').kind,'security');
 for(const id of ['other','profile','account']){assert.equal(employerHold(db,get(id)),null);db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(id);}
 for(const status of ['queued','running'])assert.throws(()=>db.prepare('UPDATE jobs SET status=? WHERE id=?').run(status,'next'),/Employer security rejection/);
 assert.throws(()=>put('inserted','fixture','u','p','queued'),/Employer security rejection/);
 installEmployerLimits(db);recordEmployerLimit(db,'u','attempt',refusal);
 assert.equal(db.prepare("SELECT count(*) n FROM events WHERE type='employer_submission_rejected'").get().n,1);
 assert.equal(db.prepare("SELECT count(*) n FROM events WHERE type='submission_started'").get().n,1);
 assert.equal(employerQuotas(db,'u').filter(q=>q.kind==='security').length,1);
 assert.throws(()=>recordEmployerLimit(db,'other','attempt',refusal),/not found/);
 db.close();
});

test('the hosted refusal records the blocker after one click while keeping the protected challenge',async()=>{
 let clicked=0,reserved=0,recorded=0,text='Name Email Resume Submit application';
 const page={url:()=>url,locator:()=>({innerText:async()=>text})};
 const input={page,job:{url},submit:{isEnabled:async()=>true,click:async options=>{if(!options?.trial)clicked++;}},review:async()=>({missing:[]}),reserve:()=>{assert.equal(reserved,0);reserved++;},wait:async()=>{if(clicked)text=refusal;},recordRejection:value=>{assert.equal(value,refusal);recorded++;}};
 const result=await submitHostedApplication(input);
 assert.equal(result.challenge,'Unconfirmed submission');assert.match(result.message,/possible spam/);assert.equal(recorded,1);assert.equal(reserved,1);assert.equal(clicked,1);assert.equal(result.confirmation,undefined);
 await submitHostedApplication(input);assert.equal(reserved,1);assert.equal(clicked,1);
});

test('read-only retained-browser inspection records a refusal once and never confirms mixed failure text',async()=>{
 process.env.SESSION_SECRET||='0123456789abcdef0123456789abcdef';
 const {Handoffs}=await import('./handoff.js');
 let text='Application form',rejections=0,submissions=0,actions=0;
 const page={url:()=>url,isClosed:()=>false,frames:()=>[page],locator:()=>({innerText:async()=>text}),screenshot:async()=>Buffer.from('image'),evaluate:async()=>({missing:[]})};
 const context={pages:()=>[page],close:async()=>{actions++;}};
 const handoffs=new Handoffs({onResume:()=>{actions++;},onClose:()=>{},onSubmitted:()=>{submissions++;},onPossibleSubmit:()=>{actions++;},onRejection:()=>{rejections++;}});
 await handoffs.hold({id:'j',user_id:'u',url,challenge:'Unconfirmed submission'},context,page);
 text='Thank you for applying. '+refusal;
 await handoffs.command('u','j','view');await handoffs.command('u','j','view');
 assert.equal(rejections,1);assert.equal(submissions,0);assert.equal(actions,0);assert.equal(handoffs.sessions.get('j').attempted,true);
});

test('legacy worker claim skips already-queued held employers and continues the independent queue',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id,applicant_id,company,url,status,job_metadata_json DEFAULT '{}',local_owner,match_score DEFAULT 90,discovery_priority DEFAULT 0,created_at DEFAULT '2026',attempts DEFAULT 0,lease_at,updated_at);
 CREATE TABLE events(job_id,at,type,message);
 CREATE TABLE applicants(id,execution_mode);INSERT INTO applicants VALUES('p','cloud');
 CREATE TABLE automatic_campaigns(user_id,enabled);CREATE TABLE work_focus(user_id,enabled,job_id);
 CREATE TABLE application_batch_preferences(user_id,enabled,current_batch);CREATE TABLE application_batch_members(job_id,user_id,batch_id);`);
 installEmployerLimits(db);
 db.exec("INSERT INTO jobs(id,user_id,applicant_id,company,url,status) VALUES('held','u','p','fixture','https://jobs.ashbyhq.com/fixture/held','queued'),('allowed','u','p','different','https://jobs.ashbyhq.com/different/allowed','queued');");
 recordEmployerLimit(db,'u','held',refusal);
 const source=readFileSync(new URL('./worker.js',import.meta.url),'utf8'),code=source.slice(source.indexOf('function claim(){'),source.indexOf('\nasync function pageIssue'));
 const claim=new Function('handoffs','db','ensureFocusedJob','prioritizeApplications','now','event','savedSearchClaimProblem','populateAutomaticCampaign','automaticMember','employerHold',code+';return claim;')({full:()=>false},db,()=>{},(_db,_uid,jobs)=>jobs,()=>new Date().toISOString(),()=>{},()=>'',()=>{},()=>null,employerHold);
 assert.equal(claim().id,'allowed');assert.equal(claim(),undefined);
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id='held'").get().status,'queued');
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id='allowed'").get().status,'running');
 db.close();
});

test('a held employer permits only reopening an existing browser view, never preparation or input',()=>{
 const source=readFileSync(new URL('./server.js',import.meta.url),'utf8'),code=source.slice(source.indexOf('const heldRoute=path.match'),source.indexOf("if(path==='/api/language-preference'"));
 const route=new Function('path','req','uid','db','ownJob','employerHold','excludesFrench','frenchApplication','send','res','companyTransitionCheck',code);
 const job={id:'abc',handoff_available:1},invoke=action=>route('/api/jobs/abc/'+action,{method:'POST'},'u',{},()=>job,()=>({kind:'security',message:'Security refusal'}),()=>false,()=>false,(_res,status,result)=>({status,...result}),{},()=>{throw Error('Mutating transition must not run');});
 assert.deepEqual(invoke('handoff/open'),{status:200,available:true,readOnly:true});
 for(const action of ['queue','continue','continuation','local/claim','local/attempt','handoff/click','handoff/drag','handoff/text','handoff/key','handoff/upload','handoff/resume'])assert.equal(invoke(action).status,409,action);
 job.handoff_available=0;assert.equal(invoke('handoff/open').status,409);
});
