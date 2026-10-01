import {canResearchQuestion,researchForJob,markResearchDraftUsed} from './google-research.js';
import {requestContinuation} from './continuation-queue.js';
import {researchConsentWithdrawn} from './research-consent.js';
const parse=(s,f)=>{try{return JSON.parse(s||'')||f}catch{return f}};
export function installPublicFill(db){db.exec("CREATE TABLE IF NOT EXISTS public_fill_attempts(job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,question TEXT NOT NULL,attempted_at TEXT NOT NULL,state TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',PRIMARY KEY(job_id,question))");}
function waiting(job){return job?.status==='local_browser'&&job.local_phase==='blocked'&&!job.local_attempt_at&&!job.handoff_available&&job.consent&&job.google_research_consent;}
function readJob(db,id){return db.prepare('SELECT j.*,p.consent,p.google_research_consent FROM jobs j JOIN applicants p ON p.id=j.applicant_id AND p.user_id=j.user_id WHERE j.id=?').get(id);}
export async function fillPublicQuestions(db,id,{research=researchForJob,continueJob=requestContinuation,withdrawn=researchConsentWithdrawn,env=process.env,clock=()=>Date.now()}={}){
 if(!env.GEMINI_API_KEY)return {filled:0};let job=readJob(db,id);if(!waiting(job))return {filled:0};
 const fields=parse(job.required_fields_json,[]);if(!Array.isArray(fields))return {filled:0};
 let filled=0;
 for(const question of [...new Set(fields)].filter(q=>typeof q==='string'&&q.length<=240&&canResearchQuestion(q)).slice(0,4)){
  job=readJob(db,id);if(!waiting(job))break;
  if(parse(job.answers_json,{})[question]?.trim())continue;
  const at=new Date(clock()).toISOString(),cutoff=new Date(clock()-3600000).toISOString();
  const claimed=db.prepare("INSERT INTO public_fill_attempts(job_id,question,attempted_at,state,message) VALUES(?,?,?,'working','Reading the public employer page') ON CONFLICT(job_id,question) DO UPDATE SET attempted_at=excluded.attempted_at,state='working',message=excluded.message WHERE public_fill_attempts.attempted_at<?").run(id,question,at,cutoff);
  if(!claimed.changes)continue;
  let state='needs_review',message='';
  try{
   const result=await research(db,job.user_id,id,question);
   job=readJob(db,id);
   if(!waiting(job)||!parse(job.required_fields_json,[]).includes(question)){message='The application changed while drafting. Saved user answers were preserved.';}
   else if(!result.answer?.trim()){message=result.reason||'The employer page has no supported answer.';}
   else {
    const answers=parse(job.answers_json,{});
    if(typeof answers[question]==='string'&&answers[question].trim()){message='Your saved answer was preserved.';}
    else {
     Object.defineProperty(answers,question,{value:result.answer.trim(),enumerable:true,configurable:true,writable:true});
     db.prepare('UPDATE jobs SET answers_json=?,updated_at=? WHERE id=? AND status=\'local_browser\' AND local_attempt_at IS NULL').run(JSON.stringify(answers),at,id);
     markResearchDraftUsed(db,id,question);
     filled++;state='saved';message='Cited Gemini answer saved for this application.';
     db.prepare('INSERT INTO events(job_id,at,type,message) VALUES(?,?,?,?)').run(id,at,'public_page_draft','Gemini prepared a cited answer: '+question);
    }
   }
  }catch(error){message=String(error.message||'Gemini could not complete the answer').slice(0,400);}
  db.prepare('UPDATE public_fill_attempts SET state=?,message=? WHERE job_id=? AND question=?').run(state,message,id,question);
 }
 if(filled){
  job=readJob(db,id);if(waiting(job)){
   try{continueJob(db,job.user_id,id,j=>withdrawn(db,j.id,j.applicant_id)?'Google drafting consent changed.':'');}
   catch{/* Remaining facts, CAPTCHA, legal steps, or a prior continuation keep the existing form paused. */}
  }
 }
 return {filled};
}
export async function fillPendingPublicQuestions(db,options={}){
 if(!(options.env||process.env).GEMINI_API_KEY)return;
 const rows=db.prepare("SELECT j.id FROM jobs j JOIN applicants p ON p.id=j.applicant_id AND p.user_id=j.user_id WHERE j.status='local_browser' AND j.local_phase='blocked' AND j.local_attempt_at IS NULL AND p.consent=1 AND p.google_research_consent=1 AND EXISTS(SELECT 1 FROM json_each(j.required_fields_json)) ORDER BY j.updated_at DESC LIMIT 20").all();
 for(const row of rows)await fillPublicQuestions(db,row.id,options);
}
export function publicFillStatus(db,uid,env=process.env){
 const profiles=db.prepare('SELECT id,name,google_research_consent,ai_consent,answers_json FROM applicants WHERE user_id=?').all(uid).map(p=>({id:p.id,name:p.name,googleConsent:!!p.google_research_consent,personalDraftConsent:!!p.ai_consent,hasBackground:!!parse(p.answers_json,{})['Professional background']?.trim()}));
 const attempts=db.prepare('SELECT f.question,f.state,f.message,f.attempted_at,j.company,j.title FROM public_fill_attempts f JOIN jobs j ON j.id=f.job_id WHERE j.user_id=? ORDER BY f.attempted_at DESC LIMIT 5').all(uid);
 return {googleConfigured:!!env.GEMINI_API_KEY,personalDraftsConfigured:!!(env.OPENAI_API_KEY&&env.OPENAI_MODEL),profiles,attempts};
}

const diagnosticRuns=new Map();
export async function testPublicDrafting(db,uid,{research=researchForJob,env=process.env,clock=()=>Date.now()}={}){
 if(!String(env.GEMINI_API_KEY||'').trim())throw Error('Gemini has no server key. Configure GEMINI_API_KEY in Railway and deploy the change.');
 const time=clock();
 for(const [user,at] of diagnosticRuns)if(time-at>60000)diagnosticRuns.delete(user);
 if(diagnosticRuns.has(uid))throw Error('Wait one minute before testing Gemini again.');
 const job=db.prepare("SELECT j.id,j.company,j.title FROM jobs j JOIN applicants p ON p.id=j.applicant_id AND p.user_id=j.user_id WHERE j.user_id=? AND p.google_research_consent=1 AND j.status!='archived' ORDER BY CASE WHEN j.url LIKE '%greenhouse.io/%' THEN 0 ELSE 1 END,j.updated_at DESC LIMIT 1").get(uid);
 if(!job)throw Error('Enable Google public-page drafting for a profile with a saved job, then test again.');
 diagnosticRuns.set(uid,time);
 let result;
 try{result=await research(db,uid,job.id,'What are the responsibilities of this role?',{env});}
 catch(error){throw Error(job.company+' · '+job.title+': '+error.message);}
 if(!result.answer?.trim())throw Error(result.reason||'Gemini responded, but this public job page does not contain enough information for a verified draft.');
 return {ok:true,model:String(env.GEMINI_MODEL||'').trim()||'gemini-3.5-flash-lite',checkedAt:new Date(clock()).toISOString(),company:job.company,title:job.title,answer:result.answer,citations:result.citations};
}
