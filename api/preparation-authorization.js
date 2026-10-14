import {companyKey,historyKey} from '../application-history.js';
import {importedPreparationProblem} from '../database/imported-history-boundary.js';
import {DatabaseError} from '../database/async-database.js';

class Denied extends Error {constructor(status,message){super(message);this.status=status;}}
const deny=(status,message)=>{throw new Denied(status,message);};
const failed=error=>({status:error instanceof Denied?error.status:503,body:{error:error instanceof Denied?error.message:'Preparation authorization could not be verified. Reload before continuing.',...(error instanceof Denied?{}:{code:error instanceof DatabaseError?error.code:'preparation_authorization_unavailable'})}});

// Shared admission for all existing local execution routes on an imported copy.
// Receipt reconciliation is deliberately exempt at the router. Native SQL
// fences repeat admission at each queue/attempt/reservation write.
export async function importedPreparationAccess(database,{uid,jobId}){
 try{return await database.read(async tx=>{
  const job=await tx.get('SELECT id,user_id,company,title,url FROM jobs WHERE id=? AND user_id=?',jobId,uid);
  if(!job)deny(404,'Job not found');
  const problem=await importedPreparationProblem(tx,job);if(problem)deny(409,'Imported history protects this application or its account is stopped.');
  return null;
 });}catch(error){return failed(error);}
}

// A complete authorization read in one pinned transaction, after HTTP auth.
// It grants only the existing Next-step permission, never a Submit permission.
export async function authorizePreparationStep(database,{uid,jobId,owner}){
 if(!uid)return {status:401,body:{error:'Sign in required'}};
 try{return await database.read(async tx=>{
  const job=await tx.get('SELECT id,user_id,applicant_id,company,title,url,status,local_owner,local_attempt_at,local_phase,challenge,attempts,confirmation FROM jobs WHERE id=? AND user_id=?',jobId,uid);
  if(!job)deny(404,'Job not found');
  if(typeof owner!=='string'||!/^[a-f0-9-]{36}$/.test(owner))deny(400,'Update the extension and reconnect this browser');
  if(job.local_owner!==owner)deny(409,'Application belongs to another browser');
  if(job.status!=='local_browser')deny(409,'This application is not active in your browser');
  const focus=await tx.get('SELECT job_id FROM work_focus WHERE user_id=? AND enabled=1',uid);
  if(focus&&focus.job_id!==job.id)deny(409,'This application is parked while you work on one job at a time.');
  const batch=await tx.get('SELECT current_batch FROM application_batch_preferences WHERE user_id=? AND enabled=1',uid);
  if(batch&&!await tx.get('SELECT 1 FROM application_batch_members WHERE batch_id=? AND job_id=? AND user_id=?',batch.current_batch,job.id,uid))deny(409,'This application is outside your active batch.');
  if(await tx.get('SELECT 1 FROM unresolved_attempt_quarantines WHERE user_id=? AND job_id=?',uid,job.id))deny(409,'This unresolved application is parked. Only a genuine employer receipt can reconcile it.');
  if(job.local_attempt_at||job.attempts>0||job.confirmation||['verifying','uncertain','submitted'].includes(job.local_phase)||['Unconfirmed submission','Submission in progress'].includes(job.challenge)||await tx.get('SELECT 1 FROM autonomous_attempts WHERE job_id=?',job.id))deny(409,'A previous submission may exist; preparation cannot continue.');
  if(await tx.get("SELECT 1 FROM events WHERE job_id=? AND type IN ('submission_started','manual_submission','automatic_submission','applicant_reported_submission','submitted','manual_confirmation') LIMIT 1",job.id)||await tx.get("SELECT 1 FROM preparation_handoff_protections WHERE user_id=? AND job_id=? AND protection IN ('uncertain','excluded')",uid,job.id))deny(409,'Durable attempt evidence protects this application.');
  if(await tx.get('SELECT 1 FROM preparation_handoff_reservations WHERE user_id=? AND preparation_identity_match(identity_json,?,?,?) LIMIT 1',uid,job.company,job.title,job.url))deny(409,'This application is reserved by ApplyPilot 2.');
  const member=await tx.get('SELECT campaign_id,excluded_at FROM preparation_members WHERE user_id=? AND job_id=?',uid,job.id);
  if(member){const campaign=await tx.get('SELECT id,enabled FROM preparation_campaigns WHERE user_id=?',uid);if(!campaign?.enabled||member.excluded_at||member.campaign_id!==campaign.id)deny(409,'This preparation campaign is paused or this form is outside its current selection.');}
  const profile=await tx.get('SELECT consent,ai_consent,gemini_facts_consent,google_research_consent FROM applicants WHERE id=? AND user_id=?',job.applicant_id,uid);
  if(!profile?.consent)deny(403,'Applicant consent was withdrawn');
  if(await tx.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fact_drafts'")){
   const drafts=await tx.all('SELECT DISTINCT provider FROM fact_drafts WHERE job_id=?',job.id);
   if(drafts.some(r=>r.provider==='gemini'?!profile.gemini_facts_consent:!profile.ai_consent))deny(403,'AI answer drafting consent was withdrawn');
  }
  if(!profile.google_research_consent&&await tx.get('SELECT 1 FROM research_draft_usage WHERE job_id=? LIMIT 1',job.id))deny(403,'AI answer drafting consent was withdrawn');
  if(await tx.get('SELECT 1 FROM external_application_history WHERE user_id=? AND company_key=? AND title_key=?',uid,companyKey(job.company),historyKey(job.title)))deny(409,'A previous external application protects this role.');
  if(await importedPreparationProblem(tx,job))deny(409,'Imported history protects this application or its account is stopped.');
  return {status:200,body:{ok:true}};
 });}catch(error){return failed(error);}
}
