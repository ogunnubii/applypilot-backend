import {randomUUID} from 'node:crypto';
import {canCapture} from './answer-library.js';
const humanSteps=new Set(['Employer application limit','CAPTCHA','Sign-in','Unconfirmed submission','Submission in progress','Sensitive action','Upload needs review']);
const parse=(value,fallback)=>{try{return JSON.parse(value||'')??fallback;}catch{return fallback;}};
export function continuationProblem(job){
 if(!job)return 'Application not found';
 if(job.local_attempt_at||job.attempt_event||['submitted','interview','rejected','offer'].includes(job.status))return 'A submission may already have occurred. Check the employer receipt.';
 if(job.status!=='local_browser'||job.local_phase!=='blocked'||job.handoff_available)return 'This application is not waiting for saved answers in your browser.';
 if(!job.consent||!job.email||!job.has_resume)return 'Applicant consent, email and resume are required.';
 if(humanSteps.has(job.challenge)||/captcha|sign[- ]?in|log[- ]?in|verification|declaration|signature|consent|arbitrat|upload.*(?:review|fail)/i.test(job.progress_message||''))return 'Complete the employer-site step before continuing.';
 const questions=parse(job.required_fields_json,[]),answers=parse(job.answers_json,{});
 if(!Array.isArray(questions)||!questions.length||questions.some(q=>!canCapture(q)||/^required field\s*[*?]?$/i.test(q.trim())))return 'An employer-site question or declaration still needs review.';
 if(questions.some(q=>!Object.hasOwn(answers,q)||typeof answers[q]!=='string'||!answers[q].trim()))return 'Save all missing answers before continuing.';
 return '';
}
function signature(job){return JSON.stringify([job.url,job.required_fields_json,job.answers_json]);}
function jobFor(db,uid,id){return db.prepare(`SELECT j.*,p.consent,p.email,p.resume_path IS NOT NULL AS has_resume,
 EXISTS(SELECT 1 FROM events e WHERE e.job_id=j.id AND e.type='submission_started') AS attempt_event,
 (SELECT message FROM events e WHERE e.job_id=j.id AND e.type='local_browser' ORDER BY id DESC LIMIT 1) AS progress_message
 FROM jobs j JOIN applicants p ON p.id=j.applicant_id AND p.user_id=j.user_id WHERE j.user_id=? AND j.id=?`).get(uid,id);}
export function installContinuations(db){db.exec(`CREATE TABLE IF NOT EXISTS continuation_requests(
 job_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,state TEXT NOT NULL,signature TEXT NOT NULL,
 requested_at TEXT NOT NULL,claim_id TEXT,claimed_at TEXT,message TEXT NOT NULL DEFAULT ''
 )`);}
export function requestContinuation(db,uid,id,check=()=> ''){
 const job=jobFor(db,uid,id),problem=continuationProblem(job)||check(job);if(problem)throw Error(problem);
 const old=db.prepare('SELECT * FROM continuation_requests WHERE job_id=? AND user_id=?').get(id,uid);
 if(old&&['queued','dispatching'].includes(old.state))return {state:old.state};
 if(old?.signature===signature(job)&&old.state!=='cancelled')throw Error('A continuation was already requested for these answers. Check the employer tab before requesting another.');
 db.prepare(`INSERT INTO continuation_requests(job_id,user_id,state,signature,requested_at) VALUES(?,?,'queued',?,?)
 ON CONFLICT(job_id) DO UPDATE SET state='queued',signature=excluded.signature,requested_at=excluded.requested_at,claim_id=NULL,claimed_at=NULL,message=''`).run(id,uid,signature(job),new Date().toISOString());
 return {state:'queued'};
}
function expireDispatches(db,uid){db.prepare("UPDATE continuation_requests SET state='review',message='Browser response was not recorded. Check the employer tab; this request will not restart automatically.' WHERE user_id=? AND state='dispatching' AND claimed_at<?").run(uid,new Date(Date.now()-60000).toISOString());}
export function listContinuations(db,uid){
 expireDispatches(db,uid);
 return db.prepare(`SELECT r.job_id,r.state,r.message,j.company,j.title FROM continuation_requests r JOIN jobs j ON j.id=r.job_id
 WHERE r.user_id=? AND j.user_id=? AND r.state IN ('queued','dispatching','review')
 AND j.status NOT IN ('archived','duplicate','submitted','interview','rejected','offer') ORDER BY r.requested_at,r.job_id`).all(uid,uid);
}
export function claimContinuation(db,uid,check=()=> ''){
 // A lost browser acknowledgement is never a reason to dispatch the same request again.
 db.exec('BEGIN IMMEDIATE');
 try{
  expireDispatches(db,uid);
  if(db.prepare("SELECT 1 FROM continuation_requests WHERE user_id=? AND state='dispatching'").get(uid)){db.exec('COMMIT');return null;}
  const focus=db.prepare('SELECT job_id FROM work_focus WHERE user_id=? AND enabled=1').get(uid);
  const requests=db.prepare("SELECT * FROM continuation_requests WHERE user_id=? AND state='queued' ORDER BY requested_at,job_id").all(uid);
  for(const request of requests){
   if(focus&&focus.job_id!==request.job_id)continue;
   const job=jobFor(db,uid,request.job_id),problem=continuationProblem(job)||(signature(job)!==request.signature?'The form or saved answers changed. Review this application before continuing.':check(job));
   if(problem){db.prepare("UPDATE continuation_requests SET state='review',message=? WHERE job_id=?").run(problem,request.job_id);continue;}
   const claimId=randomUUID();
   db.prepare("UPDATE continuation_requests SET state='dispatching',claim_id=?,claimed_at=?,message='' WHERE job_id=?").run(claimId,new Date().toISOString(),request.job_id);
   db.exec('COMMIT');return {jobId:request.job_id,claimId};
  }
  db.exec('COMMIT');return null;
 }catch(error){db.exec('ROLLBACK');throw error;}
}
export function settleContinuation(db,uid,id,claimId,result){
 if(!['started','busy','review'].includes(result))throw Error('Unknown continuation result');
 const state=result==='started'?'done':result==='busy'?'queued':'review';
 const message=result==='busy'?'Waiting for the current browser application to finish.':result==='review'?'Check the employer tab and browser connection. Answers are saved; automatic restart is held.':'';
 const changed=db.prepare("UPDATE continuation_requests SET state=?,message=? WHERE user_id=? AND job_id=? AND claim_id=? AND state='dispatching'").run(state,message,uid,id,claimId);
 if(!changed.changes)throw Error('This continuation is no longer pending');
 return {state};
}
export function cancelContinuation(db,uid,id){
 const changed=db.prepare("UPDATE continuation_requests SET state='cancelled',message='' WHERE job_id=? AND user_id=? AND state IN ('queued','review')").run(id,uid);
 if(!changed.changes)throw Error('The browser may already be starting this form. Check its employer tab.');
 return {state:'cancelled'};
}
