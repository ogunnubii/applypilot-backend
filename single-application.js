import {installUnresolvedAttempts,unresolvedAttemptQuarantined,unresolvedAttemptEligibility,unresolvedAttemptMarker} from './unresolved-attempts.js';
import {matchAssessment} from './matching.js';
import {currentScopeAssessment,currentSearchScope,scopeIntent,searchScopeSignature} from './search-scope.js';
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
 installUnresolvedAttempts(db);
 db.exec(`CREATE TABLE IF NOT EXISTS work_focus(user_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,job_id TEXT);
 CREATE TABLE IF NOT EXISTS application_progress(job_id TEXT PRIMARY KEY,required_total INTEGER NOT NULL,required_filled INTEGER NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS autonomous_attempts(job_id TEXT PRIMARY KEY,owner TEXT NOT NULL,created_at TEXT NOT NULL);`);
 for(const column of ['auto_submit','skip_blocked','search_queue_only','stop_after_receipt'])if(!db.prepare('PRAGMA table_info(work_focus)').all().some(c=>c.name===column))db.exec('ALTER TABLE work_focus ADD COLUMN '+column+' INTEGER NOT NULL DEFAULT 0');
 if(!db.prepare('PRAGMA table_info(work_focus)').all().some(c=>c.name==='queue_applicant_id'))db.exec("ALTER TABLE work_focus ADD COLUMN queue_applicant_id TEXT");
}
// Explicit queue transition; historical attempts are never cleared or retried.
function archivedApplicationQuarantined(db,job){
 if(job.status!=='archived'||job.handoff_available!==0)return false;
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='application_archive'").get()||!db.prepare('SELECT 1 FROM application_archive WHERE job_id=?').get(job.id))return false;
 if(!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type='archived' LIMIT 1").get(job.id))return false;
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='continuation_requests'").get()&&db.prepare("SELECT 1 FROM continuation_requests WHERE user_id=? AND job_id=? AND state='dispatching' LIMIT 1").get(job.user_id,job.id))return false;
 // This is a future-execution fence, not proof that an old employer click
 // stopped or succeeded. The archived job and every attempt remain protected.
 return true;
}
export function inFlightApplication(db,userId,exceptId=''){
 // Receipt routes may retain a historical verifying phase. Exempt only a
 // completed employer-confirmed record; never infer receipt from status alone.
 const candidates=db.prepare("SELECT * FROM jobs WHERE user_id=? AND id!=? AND (status='running' OR local_phase='verifying' OR challenge='Submission in progress')").all(userId,exceptId);
 return candidates.find(job=>!unresolvedAttemptQuarantined(db,job)&&!archivedApplicationQuarantined(db,job)&&(job.status==='running'||job.challenge==='Submission in progress'||!['submitted','interview','rejected','offer'].includes(job.status)||!receiptConfirmed(db,job)));
}
const diagnosticEventTypes=['submission_started','manual_submission','manual_submission_retry','automatic_submission','applicant_reported_submission','submitted','manual_confirmation','running','local_browser','paused','needs_review','queued','filled','resumed','archived'];
function diagnosticTimestamp(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))return null;
 return new Date(value).toISOString();
}
function blockerDiagnostics(db,userId,job){
 const profile=db.prepare('SELECT execution_mode FROM applicants WHERE id=? AND user_id=?').get(job.applicant_id,userId);
 const reservation=db.prepare("SELECT CASE WHEN owner='hosted-worker' THEN 'hosted-worker' ELSE 'local-browser' END AS source FROM autonomous_attempts WHERE job_id=?").get(job.id);
 const source=reservation?.source||(job.status==='local_browser'||job.local_owner?'local-browser':job.status==='running'?'hosted-worker':null);
 // Never select event messages: they can contain applicant answers or questions.
 const events=db.prepare('SELECT e.type,e.at FROM events e JOIN jobs j ON j.id=e.job_id WHERE e.job_id=? AND j.user_id=? AND e.type IN ('+diagnosticEventTypes.map(()=>'?').join(',')+') ORDER BY e.rowid DESC LIMIT 5').all(job.id,userId,...diagnosticEventTypes);
 return {updated_at:diagnosticTimestamp(job.updated_at),attempt_at:diagnosticTimestamp(job.local_attempt_at),worker_claim_at:diagnosticTimestamp(job.lease_at),profile_execution_mode:['cloud','local'].includes(profile?.execution_mode)?profile.execution_mode:null,recorded_execution_source:source,recent_events:events.map(event=>({type:event.type,at:diagnosticTimestamp(event.at)}))};
}
// Read-only reconciliation for a lost transition response. Never selects a job,
// populates a batch, changes authorization, or reveals another account's data.
export function savedSearchQueueState(db,userId,{applicant_id}={}){
 const focus=db.prepare('SELECT * FROM work_focus WHERE user_id=?').get(userId),batch=db.prepare('SELECT * FROM application_batch_preferences WHERE user_id=?').get(userId);
 const applicantId=applicant_id||focus?.queue_applicant_id||batch?.applicant_id||null;
 if(applicantId&&!db.prepare('SELECT id FROM applicants WHERE id=? AND user_id=?').get(applicantId,userId))throw Error('Choose your saved applicant profile.');
 const blocker=inFlightApplication(db,userId),readiness=savedSearchReadiness(db,userId,applicantId,focus);
 return {mode:focus?.search_queue_only?'saved-search':'legacy',applicant_id:focus?.queue_applicant_id||null,checked_applicant_id:applicantId,batch_enabled:!!batch?.enabled,focus_enabled:!!focus?.enabled,auto_submit:!!focus?.auto_submit,paused:!focus?.enabled&&!focus?.auto_submit,active_structured_search:!!(applicantId&&currentSearchScope(db,{user_id:userId,applicant_id:applicantId})),readiness,blocker:blocker?{id:blocker.id,title:blocker.title,company:blocker.company,status:blocker.status,phase:blocker.local_phase||null,unresolved_action:unresolvedAttemptEligibility(db,blocker),...blockerDiagnostics(db,userId,blocker),reason:blocker.status==='running'?'Application preparation is running':blocker.challenge==='Submission in progress'?'Submission is in progress':'A submission is still marked as awaiting verification; no employer receipt is confirmed'}:null};
}
// Preview uses the same preparation and fresh-search guards as selection. It
// never claims work, refreshes postings, reserves a click or changes consent.
function savedSearchReadiness(db,userId,applicantId,focus){
 if(!applicantId||!focus?.search_queue_only||focus.queue_applicant_id!==applicantId)return null;
 const rows=db.prepare("SELECT * FROM jobs WHERE user_id=? AND applicant_id=? AND status IN ('saved','queued')").all(userId,applicantId),eligible=[],held=[];
 const publicJob=job=>({id:job.id,title:job.title,company:job.company,url:job.url,location:metadataFor(job).location||'',remote:metadataFor(job).remote===true});
 for(const job of rows){
  const reason=hasSubmissionEvidence(db,job)?'A previous submission may exist; protected from retry.':preparationProblem(db,job)||savedSearchProblem(db,job,focus,true);
  if(reason)held.push({...publicJob(job),reason});else eligible.push(job);
 }
 const ranked=prioritizeApplications(db,userId,eligible);
 return {checked:rows.length,eligible:ranked.length,held:held.length,candidates:ranked.slice(0,20).map(job=>({...publicJob(job),automatic_submission_supported:!metadataFor(job).manualReview&&!globalThis.ApplyPilotPolicy.customApplication(job.url)})),held_jobs:held.slice(0,20)};
}
export function useSavedSearchQueue(db,userId,{applicant_id}={}){
 const profile=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(applicant_id,userId);
 if(!profile)throw Error('Choose your saved applicant profile.');
 if(!currentSearchScope(db,{user_id:userId,applicant_id}))throw Error('Save and enable a structured search for this profile first.');
 db.exec('BEGIN IMMEDIATE');try{
  if(inFlightApplication(db,userId))throw Error('An application is still running or verifying a submission. Let it finish or resolve it before changing queues.');
  db.prepare('UPDATE application_batch_preferences SET enabled=0 WHERE user_id=?').run(userId);
  db.prepare("INSERT INTO work_focus(user_id,enabled,job_id,auto_submit,skip_blocked,search_queue_only,queue_applicant_id) VALUES(?,0,NULL,0,0,1,?) ON CONFLICT(user_id) DO UPDATE SET enabled=0,job_id=NULL,auto_submit=0,skip_blocked=0,search_queue_only=1,queue_applicant_id=excluded.queue_applicant_id").run(userId,applicant_id);
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 return {batch:{enabled:false},focus:focusSnapshot(db,userId),message:'Saved search queue selected. Automation is paused. Previous applications and searches are preserved; enable automatic submission separately when ready.'};
}
function savedSearchProblem(db,job,focus,candidate=false){
 if(!focus?.search_queue_only)return '';
 if(job.applicant_id!==focus.queue_applicant_id)return 'This application is outside the selected saved-search profile.';
 const scope=currentSearchScope(db,job),metadata=metadataFor(job);
 if(!scope)return 'An enabled structured search is required.';
 if(metadata.searchScopeSignature!==searchScopeSignature(scope))return 'Run the active structured search to verify this job against its current scope.';
 if(metadata.available!==true||!Number.isFinite(Date.parse(metadata.checkedAt||''))||Date.now()-Date.parse(metadata.checkedAt)>=86400000)return 'A fresh employer posting check is required.';
 const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(job.applicant_id,job.user_id),intent=scopeIntent(scope);
 if(scope.includeRelatedRoles)intent.roles.push(...String(p?.focus||'').split(/[;,]/).map(x=>x.trim().toLowerCase()).filter(Boolean));
 if(!matchAssessment({...metadata,title:job.title},intent,p?.focus).strong||currentScopeAssessment(db,job)?.eligibility?.eligible!==true)return 'A strong, eligible match to the saved structured search is required.';
 if(candidate&&(!['saved','queued'].includes(job.status)||Number(job.attempts)||job.local_owner||job.handoff_available||job.challenge||hasSubmissionEvidence(db,job)))return 'Only untouched applications can enter the saved search queue.';
 return '';
}
export function savedSearchClaimProblem(db,job){
 const focus=db.prepare('SELECT * FROM work_focus WHERE user_id=?').get(job.user_id);
 if(!focus?.search_queue_only)return '';
 if(!focus.enabled||focus.job_id!==job.id)return 'Saved search automation is paused or another application is selected.';
 if(inFlightApplication(db,job.user_id,job.id))return 'Another application is still running or verifying a submission.';
 if(job.status==='local_browser'&&!hasSubmissionEvidence(db,job))return savedSearchProblem(db,job,focus);
 // A deliberate takeover request may reopen the selected, pre-submit form
 // after its hosted browser expires. A preparation count is not a submission.
 // Preserve the count, require a request newer than the last worker claim,
 // and never let recovery, automatic queuing or an old request grant a retry.
 if(job.status==='queued'&&Number(job.attempts)>0&&!job.local_owner&&!job.handoff_available&&!job.challenge&&!hasSubmissionEvidence(db,job)){
  const request=db.prepare("SELECT rowid AS sequence,message FROM events WHERE job_id=? AND type='queued' ORDER BY rowid DESC LIMIT 1").get(job.id);
  const lastRun=db.prepare("SELECT MAX(rowid) AS sequence FROM events WHERE job_id=? AND type IN ('running','resumed')").get(job.id);
  if(request?.message==='Preparing a live application browser for applicant takeover'&&request.sequence>(lastRun?.sequence||0)){
   return preparationProblem(db,job)||savedSearchProblem(db,job,focus);
  }
 }
 return savedSearchProblem(db,job,focus,true);
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
 if(currentScopeAssessment(db,job)?.eligibility?.eligible===false)return 'This job does not meet the current search scope and work eligibility requirements.';
 if(metadata.eligibility?.eligible===false)return 'This job does not meet the saved work eligibility requirements.';
 if(excludesFrench(db,job.user_id)&&frenchApplication(job))return 'French-language applications are excluded by your preference.';
 if(employerHold(db,job))return employerHold(db,job).message;
 if(researchConsentWithdrawn(db,job.id,job.applicant_id))return 'Drafting consent changed. Review saved answers before continuing.';
 if(priorApplication(db,job.user_id,job)||db.prepare('SELECT 1 FROM external_application_history WHERE user_id=? AND company_key=? AND title_key=?').get(job.user_id,companyKey(job.company),historyKey(job.title)))return 'A prior application exists. Check the employer receipt.';
 return '';
}
const isBlocked=job=>['paused','needs_review'].includes(job.status)||job.status==='local_browser'&&job.local_phase==='blocked';
export function startOneApplication(db,userId,jobId,{auto_submit=true}={}){
 if(typeof auto_submit!=='boolean')throw Error('Choose an explicit submission mode.');
 db.exec('BEGIN IMMEDIATE');try{
  const focus=db.prepare('SELECT * FROM work_focus WHERE user_id=?').get(userId),job=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(jobId,userId);
  if(!job||!focus?.search_queue_only)throw Error('Choose a fresh application from your saved search queue.');
  if(inFlightApplication(db,userId))throw Error('Another application is running or awaiting submission verification.');
  const current=focus.job_id?db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(focus.job_id,userId):null;
  if(current&&db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='continuation_requests'").get()&&db.prepare("SELECT 1 FROM continuation_requests WHERE job_id=? AND user_id=? AND state='dispatching'").get(current.id,userId))throw Error('A continuation is still dispatching for the selected application.');
  if(current&&current.id!==job.id&&!receiptConfirmed(db,current)&&!(isBlocked(current)&&!hasSubmissionEvidence(db,current))&&!['archived','duplicate'].includes(current.status))throw Error('Resolve the selected application before starting another.');
  const problem=preparationProblem(db,job)||savedSearchProblem(db,job,focus,true);if(problem)throw Error(problem);
  if(auto_submit&&(metadataFor(job).manualReview||globalThis.ApplyPilotPolicy.customApplication(job.url)))throw Error('This employer requires your final review and Submit click.');
  if(db.prepare('SELECT execution_mode FROM applicants WHERE id=? AND user_id=?').get(job.applicant_id,userId)?.execution_mode!=='cloud')throw Error('Choose hosted worker mode before starting a hosted application.');
  db.prepare('UPDATE work_focus SET enabled=1,auto_submit=?,skip_blocked=0,stop_after_receipt=1,job_id=? WHERE user_id=?').run(auto_submit?1:0,job.id,userId);
  if(job.status==='saved')db.prepare("UPDATE jobs SET status='queued',updated_at=? WHERE id=?").run(now(),job.id);
  db.exec('COMMIT');return focusSnapshot(db,userId);
 }catch(error){db.exec('ROLLBACK');throw error;}
}
function selectFocusedJob(db,userId){
 const focus=db.prepare('SELECT * FROM work_focus WHERE user_id=? AND enabled=1').get(userId);
 if(!focus)return;
 const current=focus.job_id?db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(focus.job_id,userId):null;
 if(focus.stop_after_receipt){
  if(!current||receiptConfirmed(db,current)||['archived','duplicate'].includes(current.status))db.prepare('UPDATE work_focus SET enabled=0,auto_submit=0,skip_blocked=0 WHERE user_id=?').run(userId);
  return; // Authorization covers this named job only, including after removal.
 }
 const pendingContinuation=current&&db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='continuation_requests'").get()&&db.prepare("SELECT 1 FROM continuation_requests WHERE job_id=? AND user_id=? AND state='dispatching' AND claimed_at>=?").get(current.id,userId,new Date(Date.now()-60000).toISOString());
 // Opt-in best effort parks only pre-submit blockers. Uncertain attempts never
 // release the selection, and are never candidates for an automatic restart.
 const safeToMove=!current||receiptConfirmed(db,current)||!hasSubmissionEvidence(db,current)&&(
  ['archived','duplicate'].includes(current.status)||!inActiveBatch(db,current)||focus.skip_blocked&&!pendingContinuation&&(
   isBlocked(current)||['saved','queued'].includes(current.status)&&!!preparationProblem(db,current)));
 if(!safeToMove)return;
 const rows=db.prepare("SELECT * FROM jobs WHERE user_id=? AND status IN ('saved','queued','paused','needs_review','local_browser')").all(userId)
  .filter(job=>job.id!==current?.id&&!hasSubmissionEvidence(db,job)&&!preparationProblem(db,job));
 const modeRows=focus.search_queue_only?rows.filter(job=>!savedSearchProblem(db,job,focus,true)):rows;
 if(focus.search_queue_only&&inFlightApplication(db,userId,current?.id||''))return;
 const untouched=modeRows.filter(job=>['saved','queued'].includes(job.status)&&!Number(job.attempts)&&!job.handoff_available&&!job.local_owner&&!job.challenge);
 const candidates=focus.search_queue_only||focus.skip_blocked?untouched:untouched.length?untouched:rows.filter(job=>!['saved','queued'].includes(job.status));
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
 return {enabled:!!f?.enabled,search_queue_only:!!f?.search_queue_only,queue_applicant_id:f?.queue_applicant_id||null,auto_submit:!!f?.auto_submit,skip_blocked:!!f?.skip_blocked,stop_after_receipt:!!f?.stop_after_receipt,job_id:f?.job_id||null,
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
  if(old.search_queue_only&&!currentSearchScope(db,{user_id:userId,applicant_id:old.queue_applicant_id}))throw Error('Save and enable a structured search before reenabling automation.');
  if(old.search_queue_only&&inFlightApplication(db,userId,old.job_id||''))throw Error('Another application is still running or verifying a submission.');
  if(next&&old.job_id&&!old.confirmed)throw Error('The selected application needs an employer confirmation before moving on.');
  db.prepare('INSERT INTO work_focus(user_id,enabled,job_id,auto_submit,skip_blocked) VALUES(?,1,NULL,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=1,auto_submit=excluded.auto_submit,skip_blocked=excluded.skip_blocked').run(userId,auto_submit===true?1:0,skip_blocked===true?1:0);
  db.prepare('UPDATE work_focus SET stop_after_receipt=0 WHERE user_id=?').run(userId);
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
  if(j&&unresolvedAttemptMarker(db,userId,jobId))throw Error('This unresolved application is parked and cannot be submitted again.');
  if(!j||!focusAllowsSubmit(db,j)||!['running','local_browser'].includes(j.status))throw Error('Autonomous submission is not enabled for this selected application.');
  if(j.status==='local_browser'&&j.local_owner!==owner)throw Error('This application belongs to another browser.');
  if(hasSubmissionEvidence(db,j))throw Error('A submission may already have occurred. Check the employer receipt.');
  const problem=preparationProblem(db,j);if(problem)throw Error(problem);
  const focus=db.prepare('SELECT * FROM work_focus WHERE user_id=?').get(userId);
  if(focus?.search_queue_only){if(inFlightApplication(db,userId,j.id))throw Error('Another application is still running or verifying a submission.');const scopeProblem=savedSearchProblem(db,j,focus);if(scopeProblem)throw Error(scopeProblem);}
  if(metadataFor(j).manualReview||globalThis.ApplyPilotPolicy.customApplication(j.url))throw Error('This employer form requires your review and Submit click.');
  if(j.status==='running'&&(owner!=='hosted-worker'||j.local_owner||db.prepare('SELECT execution_mode FROM applicants WHERE id=?').get(j.applicant_id)?.execution_mode!=='cloud'))throw Error('The selected execution environment is no longer authorized.');
  if(j.status==='local_browser'&&['blocked','uncertain','verifying'].includes(j.local_phase))throw Error('The employer form needs review before automatic submission.');
  db.prepare('INSERT INTO autonomous_attempts VALUES(?,?,?)').run(jobId,owner,now());
  db.prepare("UPDATE jobs SET local_attempt_at=?,local_phase='verifying',challenge='Submission in progress',updated_at=? WHERE id=?").run(now(),now(),jobId);
  for(const [type,message] of [['submission_started','Autonomous submission intent saved before the employer action.'],['automatic_submission','Selected application authorized for one automatic Submit click.']])db.prepare('INSERT INTO events(job_id,at,type,message) VALUES(?,?,?,?)').run(jobId,now(),type,message);
  db.exec('COMMIT');return {ok:true,permitted:true};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
