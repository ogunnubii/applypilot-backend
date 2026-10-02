import {reusableAnswers,canReuse} from './answer-library.js';
import {savedAnswer} from './local-policy.js';
import {hostedFieldAnswer,protectedHostedQuestion} from './hosted-form.js';
import {requestContinuation} from './continuation-queue.js';
import {employerHold} from './employer-limits.js';
import {companyApplicationPolicy} from './company-application-policy.js';
import {researchConsentWithdrawn} from './research-consent.js';
const parse=(s,f)=>{try{return JSON.parse(s||'')??f;}catch{return f;}};
export function installSavedRecovery(db){
 db.exec("CREATE TABLE IF NOT EXISTS saved_answer_recovery(job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,user_id TEXT NOT NULL,filled INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,message TEXT NOT NULL)");
}
const event=(db,id,type,message)=>db.prepare('INSERT INTO events(job_id,at,type,message) VALUES(?,?,?,?)').run(id,new Date().toISOString(),type,message);
function policyProblem(db,j){
 return employerHold(db,j)?.message||(!companyApplicationPolicy(db,j.applicant_id,j).allowed?'Company application policy holds this form.':'')||(researchConsentWithdrawn(db,j.id,j.applicant_id)?'Drafting consent changed.':'');
}
export function recoverSavedAnswers(db,{userId=null,check=policyProblem,continueJob=requestContinuation}={}){
 const summary={filled:0,applications:0,queued:0};
 const rows=db.prepare(`SELECT j.* FROM jobs j JOIN applicants p ON p.id=j.applicant_id AND p.user_id=j.user_id
 JOIN pipeline_preferences pp ON pp.user_id=j.user_id AND pp.auto_queue_found=1
 WHERE (? IS NULL OR j.user_id=?) AND j.status='local_browser' AND j.local_phase='blocked'
 AND j.local_attempt_at IS NULL AND j.handoff_available=0 AND p.consent=1 AND p.email!='' AND p.resume_path IS NOT NULL
 AND COALESCE(j.challenge,'') IN ('','Missing answers','Required custom form control requires review','Unfamiliar form')
 AND NOT EXISTS(SELECT 1 FROM events e WHERE e.job_id=j.id AND e.type IN ('submission_started','manual_submission','automatic_submission','submitted','manual_confirmation'))
 AND NOT EXISTS(SELECT 1 FROM continuation_requests r WHERE r.job_id=j.id AND r.state IN ('queued','dispatching'))
 ORDER BY j.updated_at,j.id LIMIT 100`).all(userId,userId);
 for(const j of rows){
  if(check(db,j))continue;
  const questions=parse(j.required_fields_json,[]);if(!Array.isArray(questions)||!questions.length)continue;
  const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,j.user_id);
  const facts=reusableAnswers(db,p),answers=parse(j.answers_json,{});if(!answers||typeof answers!=='object'||Array.isArray(answers))continue;
  let filled=0;
  for(const q of [...new Set(questions)]){
   if(typeof q!=='string'||q.length>240||protectedHostedQuestion(q)||String(answers[q]??'').trim())continue;
   const fact=hostedFieldAnswer({label:q},p,facts);
   const answer=fact?.answer??(canReuse(q)?savedAnswer(q,facts):null);
   if(typeof answer!=='string'||!answer.trim()||answer.length>4000)continue;
   Object.defineProperty(answers,q,{value:answer,enumerable:true,writable:true,configurable:true});filled++;
  }
  if(!filled)continue;
  const at=new Date().toISOString();
  // This synchronous transaction contains no network or model calls.
  db.exec('BEGIN IMMEDIATE');
  try{
   const changed=db.prepare("UPDATE jobs SET answers_json=?,updated_at=? WHERE id=? AND user_id=? AND status='local_browser' AND local_phase='blocked' AND local_attempt_at IS NULL").run(JSON.stringify(answers),at,j.id,j.user_id);
   if(!changed.changes){db.exec('ROLLBACK');continue;}
   db.prepare(`INSERT INTO saved_answer_recovery VALUES(?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET filled=saved_answer_recovery.filled+excluded.filled,updated_at=excluded.updated_at,message=excluded.message`).run(j.id,j.user_id,filled,at,'Saved profile facts recovered; preparation is not a submission.');
   event(db,j.id,'saved_answer_recovered','Reused '+filled+' saved profile answer(s). No AI call or submission was made.');
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  summary.filled+=filled;summary.applications++;
  try{continueJob(db,j.user_id,j.id,job=>check(db,job));summary.queued++;event(db,j.id,'saved_answer_continuation','All recorded missing answers are available. Queued one browser preparation continuation. Final Submit remains manual.');}
  catch{/* Incomplete answers or employer-only steps stay paused; never retry a submission. */}
 }
 return summary;
}
export function savedRecoveryStatus(db,userId){
 const total=db.prepare('SELECT COALESCE(SUM(filled),0) AS filled,COUNT(*) AS applications FROM saved_answer_recovery WHERE user_id=?').get(userId);
 const recent=db.prepare('SELECT r.filled,r.updated_at,r.message,j.company,j.title FROM saved_answer_recovery r JOIN jobs j ON j.id=r.job_id AND j.user_id=r.user_id WHERE r.user_id=? ORDER BY r.updated_at DESC LIMIT 5').all(userId);
 return {enabled:!!db.prepare('SELECT auto_queue_found FROM pipeline_preferences WHERE user_id=?').get(userId)?.auto_queue_found,...total,recent};
}
