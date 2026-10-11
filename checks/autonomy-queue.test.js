import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {installResearch} from '../google-research.js';
import {installArchive} from '../application-archive.js';
import {installLanguagePolicy} from '../language-policy.js';
import {queueFoundApplications} from '../application-pipeline.js';
import {populateBatch} from '../application-batches.js';
import {installContinuations,requestContinuation,claimContinuation,settleContinuation,listContinuations} from '../continuation-queue.js';
import {ensureFocusedJob,focusSnapshot} from '../single-application.js';
const directory=mkdtempSync(join(tmpdir(),'applypilot-autonomy-queue-'));
process.env.DATABASE_PATH=join(directory,'test.sqlite');
const {db}=await import('../db.js');installResearch(db);installArchive(db);installLanguagePolicy(db);installContinuations(db);
after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
function account(){const uid=randomUUID(),profile=randomUUID();db.prepare("INSERT INTO users VALUES(?,?,'fixture','2026')").run(uid,uid+'@example.test');db.prepare("INSERT INTO applicants(id,user_id,name,email,resume_path,consent,execution_mode,created_at) VALUES(?,?,'Fixture',?,'fixture.pdf',1,'local','2026')").run(profile,uid,uid+'@example.test');return {uid,profile};}
function job({uid,profile},status='saved',extra={}){const id=randomUUID(),url='https://jobs.lever.co/'+id+'/role';db.prepare("INSERT INTO jobs(id,user_id,applicant_id,company,title,url,normalized_url,status,created_at,updated_at,local_owner,local_phase,required_fields_json,answers_json,job_metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,'browser',?,?,?,?)").run(id,uid,profile,id,'Cloud Support Engineer',url,url,status,'2026','2026',status==='local_browser'?'blocked':'ready','["Country"]','{"Country":"Canada"}',JSON.stringify(extra));return id;}
function batch(a,id){db.prepare("INSERT INTO application_batch_preferences VALUES(?,?,1,?,120000,'','2026')").run(a.uid,a.profile,id);}

test('pipeline and batch admission retain durable attempt records even when editable job flags were reset',()=>{
 const a=account(),b=account();const ids=[];
 for(const event of ['submission_started','automatic_submission','manual_submission','applicant_reported_submission','submitted','manual_confirmation']){const id=job(a);db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,'2026',?,'durable evidence')").run(id,event);ids.push(id);}
 const reserved=job(a);db.prepare("INSERT INTO autonomous_attempts VALUES(?,'browser','2026')").run(reserved);ids.push(reserved);
 const ineligible=job(a,'saved',{eligibility:{eligible:false}}),outside=job(b);
 const result=queueFoundApplications(db,a.uid);assert.equal(result.queued,0);assert.equal(result.held,ids.length+1);
 for(const id of [...ids,ineligible])assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(id).status,'needs_review');
 assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(outside).status,'saved');
 const c=account();batch(c,'batch-'+c.uid);const metadata={available:true,supportCareer:{strong:true},salaryTarget:{eligible:true,minimum:120000},eligibility:{eligible:true}};
 const blocked=job(c,'saved',metadata);db.prepare("INSERT INTO autonomous_attempts VALUES(?,'browser','2026')").run(blocked);db.prepare('UPDATE jobs SET local_owner=NULL WHERE id=?').run(blocked);
 assert.equal(populateBatch(db,c.uid).selected,0,'durable reservations are never admitted into a fresh batch');
});

test('continuations recheck permanent attempt evidence and active batch membership before dispatch',()=>{
 const a=account();const id=job(a,'local_browser');requestContinuation(db,a.uid,id);db.prepare("INSERT INTO autonomous_attempts VALUES(?,'browser','2026')").run(id);
 assert.equal(claimContinuation(db,a.uid),null);assert.match(listContinuations(db,a.uid)[0].message,/already/);
 const b=account(),foreignBatch=job(b,'local_browser');batch(b,'batch-'+b.uid);assert.throws(()=>requestContinuation(db,b.uid,foreignBatch),/outside your active batch/);
 const c=account(),claimed=job(c,'local_browser');requestContinuation(db,c.uid,claimed);db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,'2026','applicant_reported_submission','Reported')").run(claimed);assert.equal(claimContinuation(db,c.uid),null);
});

test('a saved-answer continuation can claim idle best-effort focus once, with bounded dispatch protection',()=>{
 const a=account(),id=job(a,'local_browser');db.prepare('INSERT INTO work_focus(user_id,enabled,job_id,auto_submit,skip_blocked) VALUES(?,1,NULL,1,1)').run(a.uid);
 requestContinuation(db,a.uid,id);assert.equal(ensureFocusedJob(db,a.uid).job_id,null);
 const claim=claimContinuation(db,a.uid);assert.equal(claim.jobId,id);assert.equal(focusSnapshot(db,a.uid).job_id,id);
 assert.equal(ensureFocusedJob(db,a.uid).job_id,id,'do not park the form while its continuation is in flight');assert.equal(claimContinuation(db,a.uid),null);
 db.prepare("UPDATE continuation_requests SET claimed_at='2000-01-01' WHERE job_id=?").run(id);
 assert.equal(ensureFocusedJob(db,a.uid).job_id,null);assert.equal(claimContinuation(db,a.uid),null,'uncertain dispatch is never replayed');
 assert.throws(()=>settleContinuation(db,a.uid,id,claim.claimId,'busy'),/no longer pending/);
 assert.equal(listContinuations(db,a.uid)[0].state,'review');
});
