import {createHash} from 'node:crypto';
import {automaticTextAnswer} from './automatic-answer.js';
import {hostedFieldAnswer,hostedFieldKind} from './hosted-form.js';
import {reusableAnswers} from './answer-library.js';
import {employmentContext} from './employment-answers.js';
import {currentSearchScope} from './search-scope.js';
import {employerHold} from './employer-limits.js';
import {priorApplication} from './application-dedup.js';
import {preparationPreferenceProblem} from './preparation-campaign.js';
import {researchConsentWithdrawn} from './research-consent.js';
const parse=(value,fallback)=>{try{return JSON.parse(value||'')??fallback;}catch{return fallback;}};
export function installPendingAnswers(db){db.exec(`CREATE TABLE IF NOT EXISTS pending_answer_attempts(job_id TEXT NOT NULL,question TEXT NOT NULL,fingerprint TEXT NOT NULL,checked_at TEXT NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(job_id,question))`);}
function waiting(db,id){
 const j=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
 if(!j||!['paused','needs_review','local_browser'].includes(j.status)||j.status==='local_browser'&&j.local_phase!=='blocked'||j.local_attempt_at||j.confirmation||j.handoff_available||['verifying','uncertain','submitted'].includes(j.local_phase))return null;
 if(!['Missing answers','Sensitive action','Worker error','Local browser','Required custom form control requires review','Unfamiliar form'].includes(j.challenge))return null;
 if(db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submission_started','automatic_submission','manual_submission','applicant_reported_submission','submitted','manual_confirmation')").get(id)||db.prepare('SELECT 1 FROM autonomous_attempts WHERE job_id=?').get(id))return null;
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='answer_save_state'").get()&&db.prepare('SELECT 1 FROM answer_save_state WHERE job_id=? AND editing=1').get(id))return null;
 return j;
}
function policy(db,j){return employerHold(db,j)?.message||preparationPreferenceProblem(db,j)||(priorApplication(db,j.user_id,j)?'Previous application protected.':'')||(researchConsentWithdrawn(db,j.id,j.applicant_id)?'Drafting consent changed.':'');}
function profileFor(db,j){const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,j.user_id);return p?.consent?p:null;}
function fingerprint(p,j){const metadata=parse(j.job_metadata_json,{});delete metadata.checkedAt;return createHash('sha256').update(JSON.stringify([j.user_id,j.applicant_id,j.url,j.title,j.company,p.name,p.email,p.phone,p.location,p.answers_json,p.resume_path,p.ai_consent,p.gemini_facts_consent,p.google_research_consent,j.required_fields_json,j.answers_json,metadata])).digest('hex');}
// Resolve saved questions independently of an open dashboard. This routine
// saves answers only: it never starts a browser, clicks Submit or retries jobs.
export async function resolvePendingAnswers(db,{answer=automaticTextAnswer,check=policy,clock=Date.now}={}){
 installPendingAnswers(db);let filled=0,checked=0;
 const rows=db.prepare("SELECT id FROM jobs WHERE status IN ('paused','needs_review','local_browser') AND local_attempt_at IS NULL ORDER BY updated_at DESC LIMIT 100").all();
 for(const row of rows){
  let j=waiting(db,row.id),p=j&&profileFor(db,j);if(!p||check(db,j))continue;
  const fields=parse(j.required_fields_json,[]);if(!Array.isArray(fields))continue;
  for(const question of [...new Set(fields)].filter(q=>typeof q==='string'&&q.trim()&&q.length<=4000)){
   j=waiting(db,row.id);p=j&&profileFor(db,j);if(!p||check(db,j))break;
   const application=parse(j.answers_json,{});if(String(application[question]??'').trim())continue;
   const key=fingerprint(p,j),old=db.prepare('SELECT * FROM pending_answer_attempts WHERE job_id=? AND question=?').get(j.id,question);
   if(old?.fingerprint===key&&clock()-Date.parse(old.checked_at)<3600000)continue;
   if(checked++>=12)return {filled,checked:12};
   const at=new Date(clock()).toISOString();let result;
   try{
    const profile={...p,employment_context:employmentContext(p,j,currentSearchScope(db,j))},saved=reusableAnswers(db,p);
    const field={label:question,type:'text'},contact=hostedFieldAnswer(field,profile,saved);
    result=contact?{answer:contact.answer,source:'saved'}:hostedFieldKind(field)?{answer:null,source:'unresolved',reason:'This contact field has missing or conflicting saved information.'}:await answer({db,job:j,profile,question,persist:false,answers:saved,applicationAnswers:application});
   }
   catch(error){result={answer:null,reason:String(error.message||'Answer provider unavailable').slice(0,400)};}
   const current=waiting(db,j.id),latest=current&&profileFor(db,current);
   // A human edit, new attempt, consent change or reassignment during the AI
   // call wins. Never overwrite it with the old response.
   if(!latest||check(db,current)||fingerprint(latest,current)!==key)continue;
   const answers=parse(current.answers_json,{}),value=result.answer;
   if(typeof value==='string'&&value.trim()&&value.length<=4000){
    Object.defineProperty(answers,question,{value:value.trim(),enumerable:true});
    db.prepare('UPDATE jobs SET answers_json=?,updated_at=? WHERE id=?').run(JSON.stringify(answers),at,j.id);
    db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'answer_prepared',?)").run(j.id,at,'ApplyPilot resolved a saved question using '+result.source+': '+question);filled++;
   }
   db.prepare('INSERT OR REPLACE INTO pending_answer_attempts VALUES(?,?,?,?,?,?)').run(j.id,question,key,at,value?'saved':'deferred',String(result.reason||'No supported answer in approved facts. This job stays deferred; other jobs can continue.').slice(0,500));
  }
 }
 return {filled,checked};
}
