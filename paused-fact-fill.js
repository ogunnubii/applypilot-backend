import {canDraftProfessional} from './answer-drafts.js';
import {prepareFormAnswer} from './form-answer.js';
import {requestContinuation} from './continuation-queue.js';
import {employerHold} from './employer-limits.js';
import {companyApplicationPolicy} from './company-application-policy.js';
import {researchConsentWithdrawn} from './research-consent.js';
const parse=(s,f)=>{try{return JSON.parse(s)||f}catch{return f}};
export async function fillPendingFactQuestions(db,{prepare=prepareFormAnswer,env=process.env}={}){
 if(!env.GEMINI_API_KEY&&!env.OPENAI_API_KEY)return;
 const rows=db.prepare("SELECT j.* FROM jobs j JOIN applicants p ON p.id=j.applicant_id AND p.user_id=j.user_id WHERE j.status='local_browser' AND j.local_phase='blocked' AND j.local_attempt_at IS NULL AND j.handoff_available=0 AND p.consent=1 AND (p.gemini_facts_consent=1 OR p.ai_consent=1) ORDER BY j.updated_at DESC LIMIT 20").all();
 const check=j=>{const focus=db.prepare('SELECT job_id FROM work_focus WHERE user_id=? AND enabled=1').get(j.user_id);return focus&&focus.job_id!==j.id?'Application is parked.':employerHold(db,j)?.message||((policy=>policy.allowed?'':policy.message)(companyApplicationPolicy(db,j.applicant_id,j)))||'';};
 for(const job of rows){
  if(check(job)||researchConsentWithdrawn(db,job.id,job.applicant_id))continue;
  let filled=0;
  const questions=parse(job.required_fields_json,[]),answers=parse(job.answers_json,{});
  for(const question of [...new Set(Array.isArray(questions)?questions:[])].filter(q=>typeof q==='string'&&canDraftProfessional(q)&&!answers[q]?.trim()).slice(0,8)){
   const at=new Date().toISOString(),cutoff=new Date(Date.now()-3600000).toISOString();
   const claimed=db.prepare("INSERT INTO public_fill_attempts(job_id,question,attempted_at,state,message) VALUES(?,?,?,'working','Preparing an answer from approved professional facts') ON CONFLICT(job_id,question) DO UPDATE SET attempted_at=excluded.attempted_at,state='working',message=excluded.message WHERE public_fill_attempts.attempted_at<?").run(job.id,question,at,cutoff);if(!claimed.changes)continue;
   let state='needs_review',message='';
   try{const result=await prepare(db,job.user_id,job.id,question,{check});if(result.answer?.trim()){filled++;state='saved';message='Professional-fact answer saved for this application; final Submit remains yours.';}else message=result.reason||'Save the missing professional fact in your profile.';}
   catch(error){message=String(error.message||'AI could not prepare this answer').slice(0,400);}
   db.prepare('UPDATE public_fill_attempts SET state=?,message=? WHERE job_id=? AND question=?').run(state,message,job.id,question);
  }
  if(filled)try{requestContinuation(db,job.user_id,job.id,j=>check(j)|| (researchConsentWithdrawn(db,j.id,j.applicant_id)?'AI consent changed.':''));}catch{/* Partial answers and previous continuation requests stay paused. */}
 }
}
