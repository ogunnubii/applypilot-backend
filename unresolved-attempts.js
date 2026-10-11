import {createHash} from 'node:crypto';
import {applicationEvidence} from './operation-evidence.js';
const evidenceTypes=['submission_started','manual_submission','manual_submission_retry','automatic_submission','applicant_reported_submission','submitted','manual_confirmation'];
export function installUnresolvedAttempts(db){
 db.exec(`CREATE TABLE IF NOT EXISTS unresolved_attempt_quarantines(job_id TEXT PRIMARY KEY REFERENCES jobs(id),user_id TEXT NOT NULL,evidence_signature TEXT NOT NULL,created_at TEXT NOT NULL);`);
 const columns=new Set(db.prepare('PRAGMA table_info(jobs)').all().map(c=>c.name));
 if(!columns.size)return;
 const protectedChanges=["NEW.status IN ('queued','running','local_browser')",...['local_attempt_at','local_owner'].filter(c=>columns.has(c)).map(c=>`NEW.${c} IS NOT OLD.${c}`)];
 if(columns.has('attempts'))protectedChanges.push('NEW.attempts>OLD.attempts');
 if(columns.has('lease_at'))protectedChanges.push('NEW.lease_at IS NOT OLD.lease_at');
 if(columns.has('handoff_available'))protectedChanges.push('NEW.handoff_available!=0');
 if(columns.has('local_phase'))protectedChanges.push("NEW.local_phase IS NOT OLD.local_phase AND NEW.local_phase IS NOT 'submitted'");
 db.exec(`CREATE TRIGGER IF NOT EXISTS unresolved_attempt_execution_fence BEFORE UPDATE ON jobs
 WHEN EXISTS(SELECT 1 FROM unresolved_attempt_quarantines q WHERE q.job_id=OLD.id AND q.user_id=OLD.user_id) AND (${protectedChanges.join(' OR ')})
 BEGIN SELECT RAISE(ABORT,'Unresolved application is parked; execution and retries are blocked'); END;`);
}
export function unresolvedAttemptMarker(db,userId,jobId){
 return db.prepare('SELECT job_id,evidence_signature,created_at FROM unresolved_attempt_quarantines WHERE user_id=? AND job_id=?').get(userId,jobId)||null;
}
function hasConfirmedReceipt(db,job){
 const receiptEvent=db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submitted','manual_confirmation') LIMIT 1").get(job.id);
 return applicationEvidence({...job,receipt_event:receiptEvent}).confirmed;
}
export function unresolvedAttemptEligibility(db,job){
 const denied=reason=>({eligible:false,reason,evidence:null});
 if(!job)return denied('Application not found.');
 if(job.status!=='submitted')return denied('Only an applicant-reported submitted record can be kept unresolved here. Active or preparing applications cannot be parked.');
 if(job.handoff_available!==0)return denied('A live or unverified hosted handoff must be resolved first.');
 if(job.challenge==='Submission in progress')return denied('Submission is explicitly in progress and cannot be parked.');
 if(hasConfirmedReceipt(db,job))return denied('An employer receipt is already confirmed; parking is unnecessary.');
 if(job.challenge!=='Applicant reported submission'||!['verifying','uncertain'].includes(job.local_phase))return denied('This record is not a recognized applicant-reported unresolved submission.');
 if(!job.local_attempt_at)return denied('Submission attempt evidence is missing.');
 if(!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type='applicant_reported_submission' LIMIT 1").get(job.id))return denied('The applicant-reported submission event is missing.');
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='continuation_requests'").get()&&db.prepare("SELECT 1 FROM continuation_requests WHERE user_id=? AND job_id=? AND state='dispatching'").get(job.user_id,job.id))return denied('A browser continuation is still dispatching.');
 const events=db.prepare('SELECT rowid,type,at FROM events WHERE job_id=? AND type IN ('+evidenceTypes.map(()=>'?').join(',')+') ORDER BY rowid').all(job.id,...evidenceTypes);
 const evidence=createHash('sha256').update(JSON.stringify([job.id,job.user_id,job.applicant_id,job.status,job.local_phase,job.challenge,job.local_attempt_at,job.attempts,job.local_owner,job.handoff_available,job.confirmation,events])).digest('hex');
 return {eligible:true,reason:'Keep this receipt unresolved, preserve duplicate protection, and exclude this job from future execution. No employer outcome will be inferred.',evidence};
}
export function unresolvedAttemptQuarantined(db,job){
 if(!job)return false;
 const marker=unresolvedAttemptMarker(db,job.user_id,job.id);if(!marker)return false;
 const state=unresolvedAttemptEligibility(db,job);
 return state.eligible&&marker.evidence_signature===state.evidence;
}
export function unresolvedAttemptState(db,userId,jobId){
 const job=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(jobId,userId);
 if(!job)throw Error('Application not found.');
 return {id:job.id,receipt_confirmed:hasConfirmedReceipt(db,job),parked:!!unresolvedAttemptMarker(db,userId,jobId),quarantined:unresolvedAttemptQuarantined(db,job),eligibility:unresolvedAttemptEligibility(db,job)};
}
export function parkUnresolvedAttempt(db,userId,jobId,evidence){
 if(typeof evidence!=='string'||! /^[a-f0-9]{64}$/.test(evidence))throw Error('Review the current unresolved-attempt details before continuing.');
 db.exec('BEGIN IMMEDIATE');try{
  const job=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(jobId,userId);if(!job)throw Error('Application not found.');
  const state=unresolvedAttemptEligibility(db,job),existing=unresolvedAttemptMarker(db,userId,jobId);
  if(!state.eligible)throw Error(state.reason);
  if(state.evidence!==evidence||existing&&existing.evidence_signature!==evidence)throw Error('The application evidence changed. Refresh its details before taking any action.');
  if(!existing){
   const at=new Date().toISOString();db.prepare('INSERT INTO unresolved_attempt_quarantines VALUES(?,?,?,?)').run(jobId,userId,evidence,at);
   db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'unresolved_attempt_parked','Receipt remains unresolved. Future execution is fenced; attempt history and duplicate protection retained.')").run(jobId,at);
   db.prepare('UPDATE work_focus SET enabled=0,auto_submit=0,skip_blocked=0,job_id=CASE WHEN job_id=? THEN NULL ELSE job_id END WHERE user_id=?').run(jobId,userId);
  }
  db.exec('COMMIT');return {ok:true,parked:true,alreadyParked:!!existing,message:existing?'Already kept unresolved. No new execution was authorized or settings changed.':'Receipt remains unresolved. This application cannot restart. Automation is paused; use your saved search queue to continue unrelated jobs.'};
 }catch(error){db.exec('ROLLBACK');throw error;}
}
