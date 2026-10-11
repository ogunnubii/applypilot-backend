import {prioritizeApplications} from './application-diversity.js';
import {applicationEvidence} from './operation-evidence.js';
import {employerHold} from './employer-limits.js';
import {inActiveBatch,populateBatch} from './application-batches.js';
import {metadataFor} from './job-intelligence.js';
import {supported} from './local-policy.js';
import {excludesFrench,frenchApplication} from './language-policy.js';
import {researchConsentWithdrawn} from './research-consent.js';
import {priorApplication} from './application-dedup.js';
import {companyKey,historyKey} from './application-history.js';

const now=()=>new Date().toISOString();
export function installSingleApplication(db){
 db.exec(`CREATE TABLE IF NOT EXISTS work_focus(user_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,job_id TEXT);
 CREATE TABLE IF NOT EXISTS application_progress(job_id TEXT PRIMARY KEY,required_total INTEGER NOT NULL,required_filled INTEGER NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS autonomous_attempts(job_id TEXT PRIMARY KEY,owner TEXT NOT NULL,created_at TEXT NOT NULL);`);
 for(const column of ['auto_submit','skip_blocked'])if(!db.prepare('PRAGMA table_info(work_focus)').all().some(c=>c.name===column))db.exec('ALTER TABLE work_focus ADD COLUMN '+column+' INTEGER NOT NULL DEFAULT 0');
}
export function receiptConfirmed(db,job){
 return !!job&&applicationEvidence({...job,receipt_event:db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submitted','manual_confirmation') LIMIT 1").get(job.id)}).confirmed;
}
export function focusAllowsSubmit(db,job){
 return !!job&&inActiveBatch(db,job)&&!!db.prepare('SELECT 1 FROM work_focus WHERE user_id=? AND enabled=1 AND auto_submit=1 AND job_id=?').get(job.user_id,job.id);
}
function hasSubmissionEvidence(db,job){
 return !!job&&(['submitted','interview','rejected','offer'].includes(job.status)||!!job.local_attempt_at||['verifying','uncertain','submitted'].includes(job.local_phase)||['Unconfirmed submission','Submission in progress'].includes(job.challenge)||
  !!db.prepare('SELECT 1 FROM autonomous_attempts WHERE job_id=?').get(job.id)||
  !!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submission_started','manual_submission','automatic_submission','applicant_reported_submission','submitted','manual_confirmation') LIMIT 1").get(job.id));
}
function preparationProblem(db,job){
 const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(job.applicant_id,job.user_id),metadata=metadataFor(job);
 if(!p?.consent||!p.email||!p.resume_path)return 'Applicant consent, email and resume are required.';
 if(!inActiveBatch(db,job))return 'This application is outside your active batch.';
 if(!supported(job.url))return 'Use a supported direct employer application link.';
 if(metadata.available===false)return 'The employer posting is no longer available.';
 if(metadata.eligibility?.eligible===false)return 'This job does not meet the saved work eligibility requirements.';
 if(excludesFrench(db,job.user_id)&&frenchApplication(job))return 'French-language applications are excluded by your preference.';
 if(employerHold(db,job))return employerHold(db,job).message;
 if(researchConsentWithdrawn(db,job.id,job.applicant_id))return 'Drafting consent changed. Review saved answers before continuing.';
 if(priorApplication(db,job.user_id,job)||db.prepare('SELECT 1 FROM external_application_history WHERE user_id=? AND company_key=? AND title_key=?').get(job.user_id,companyKey(job.company),historyKey(job.title)))return 'A prior application exists. Check the employer receipt.';
 return '';
}
const isBlocked=job=>['paused','needs_review'].includes(job.status)||job.status==='local_browser'&&job.local_phase==='blocked';
function selectFocusedJob(db,userId){
 const focus=db.prepare('SELECT * FROM work_focus WHERE user_id=? AND enabled=1').get(userId);
 if(!focus)return;
 const current=focus.job_id?db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(focus.job_id,userId):null;
 const pendingContinuation=current&&db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='continuation_requests'").get()&&db.prepare("SELECT 1 FROM continuation_requests WHERE job_id=? AND user_id=? AND state='dispatching' AND claimed_at>=?").get(current.id,userId,new Date(Date.now()-60000).toISOString());
 // Opt-in best effort parks only pre-submit blockers. Uncertain attempts never
 // release the selection, and are never candidates for an automatic restart.
 const safeToMove=!current||receiptConfirmed(db,current)||!hasSubmissionEvidence(db,current)&&(
  ['archived','duplicate'].includes(current.status)||!inActiveBatch(db,current)||focus.skip_blocked&&!pendingContinuation&&(
   isBlocked(current)||['saved','queued'].includes(current.status)&&!!preparationProblem(db,current)));
 if(!safeToMove)return;
 const rows=db.prepare("SELECT * FROM jobs WHERE user_id=? AND status IN ('saved','queued','paused','needs_review','local_browser')").all(userId)
  .filter(job=>job.id!==current?.id&&!hasSubmissionEvidence(db,job)&&!preparationProblem(db,job));
 const untouched=rows.filter(job=>['saved','queued'].includes(job.status)&&!Number(job.attempts)&&!job.handoff_available&&!job.local_owner&&!job.challenge);
 const candidates=focus.skip_blocked?untouched:untouched.length?untouched:rows.filter(job=>!['saved','queued'].includes(job.status));
 const next=prioritizeApplications(db,userId,candidates)[0];
 db.prepare('UPDATE work_focus SET job_id=? WHERE user_id=?').run(next?.id||null,userId);
 if(next?.status==='saved')db.prepare("UPDATE jobs SET status='queued',updated_at=? WHERE id=? AND status='saved' AND attempts=0 AND local_attempt_at IS NULL AND handoff_available=0").run(now(),next.id);
}
export function ensureFocusedJob(db,userId){
 db.exec('BEGIN IMMEDIATE');
 try{selectFocusedJob(db,userId);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 return focusSnapshot(db,userId);
}
export function focusSnapshot(db,userId){
 const f=db.prepare('SELECT * FROM work_focus WHERE user_id=?').get(userId);
 const job=f?.job_id?db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(f.job_id,userId):null;
 const p=job?db.prepare('SELECT * FROM application_progress WHERE job_id=?').get(job.id):null;
 return {enabled:!!f?.enabled,auto_submit:!!f?.auto_submit,skip_blocked:!!f?.skip_blocked,job_id:f?.job_id||null,
  selected_job:job?{id:job.id,title:job.title,company:job.company,status:job.status,challenge:job.challenge,execution_mode:db.prepare('SELECT execution_mode FROM applicants WHERE id=? AND user_id=?').get(job.applicant_id,userId)?.execution_mode||'cloud'}:null,
  parked:db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND status NOT IN ('duplicate','archived','submitted','interview','rejected','offer') AND id!=COALESCE(?,'')").get(userId,f?.job_id||null).n,
  progress:p?{required:p.required_total,filled:p.required_filled,percent:p.required_total?Math.floor(p.required_filled*100/p.required_total):null,updated_at:p.updated_at}:null,
  confirmed:receiptConfirmed(db,job),awaiting:hasSubmissionEvidence(db,job)&&!receiptConfirmed(db,job)};
}
export function setWorkFocus(db,userId,{enabled,auto_submit,skip_blocked,next}={}){
 if(typeof enabled!=='boolean'||auto_submit!==undefined&&typeof auto_submit!=='boolean'||skip_blocked!==undefined&&typeof skip_blocked!=='boolean'||next!==undefined&&typeof next!=='boolean')throw Error('Choose explicit automatic submission and blocked-form settings.');
 if(enabled===false){db.prepare('UPDATE work_focus SET enabled=0,auto_submit=0,skip_blocked=0 WHERE user_id=?').run(userId);return focusSnapshot(db,userId);}
 populateBatch(db,userId);
 db.exec('BEGIN IMMEDIATE');
 try{
  const old=focusSnapshot(db,userId);
  if(next&&old.job_id&&!old.confirmed)throw Error('The selected application needs an employer confirmation before moving on.');
  db.prepare('INSERT INTO work_focus(user_id,enabled,job_id,auto_submit,skip_blocked) VALUES(?,1,NULL,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=1,auto_submit=excluded.auto_submit,skip_blocked=excluded.skip_blocked').run(userId,auto_submit===true?1:0,skip_blocked===true?1:0);
  selectFocusedJob(db,userId);db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 return focusSnapshot(db,userId);
}
export function saveFormProgress(db,jobId,progress){
 if(!progress||!Number.isInteger(progress.required)||!Number.isInteger(progress.filled)||progress.required<0||progress.required>150||progress.filled<0||progress.filled>progress.required)return;
 db.prepare('INSERT INTO application_progress VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET required_total=excluded.required_total,required_filled=excluded.required_filled,updated_at=excluded.updated_at').run(jobId,progress.required,progress.filled,now());
}
// Reserve BEFORE clicking. A lost response is uncertain and never grants a replay.
export function reserveAutonomousAttempt(db,jobId,userId,owner){
 db.exec('BEGIN IMMEDIATE');
 try{
  const j=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(jobId,userId);
  if(!j||!focusAllowsSubmit(db,j)||!['running','local_browser'].includes(j.status))throw Error('Autonomous submission is not enabled for this selected application.');
  if(j.status==='local_browser'&&j.local_owner!==owner)throw Error('This application belongs to another browser.');
  if(hasSubmissionEvidence(db,j))throw Error('A submission may already have occurred. Check the employer receipt.');
  const problem=preparationProblem(db,j);if(problem)throw Error(problem);
  if(metadataFor(j).manualReview||globalThis.ApplyPilotPolicy.customApplication(j.url))throw Error('This employer form requires your review and Submit click.');
  if(j.status==='running'&&(owner!=='hosted-worker'||j.local_owner||db.prepare('SELECT execution_mode FROM applicants WHERE id=?').get(j.applicant_id)?.execution_mode!=='cloud'))throw Error('The selected execution environment is no longer authorized.');
  if(j.status==='local_browser'&&['blocked','uncertain','verifying'].includes(j.local_phase))throw Error('The employer form needs review before automatic submission.');
  db.prepare('INSERT INTO autonomous_attempts VALUES(?,?,?)').run(jobId,owner,now());
  db.prepare("UPDATE jobs SET local_attempt_at=?,local_phase='verifying',challenge='Submission in progress',updated_at=? WHERE id=?").run(now(),now(),jobId);
  for(const [type,message] of [['submission_started','Autonomous submission intent saved before the employer action.'],['automatic_submission','Selected application authorized for one automatic Submit click.']])db.prepare('INSERT INTO events(job_id,at,type,message) VALUES(?,?,?,?)').run(jobId,now(),type,message);
  db.exec('COMMIT');return {ok:true,permitted:true};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
