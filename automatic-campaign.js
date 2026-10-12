import {randomUUID} from 'node:crypto';
import {preparationCandidateProblem,rotateTitles} from './preparation-campaign.js';
import {currentSearchScope} from './search-scope.js';
import {prioritizeApplications} from './application-diversity.js';
import {metadataFor} from './job-intelligence.js';
import {operationSnapshot} from './operation-evidence.js';

export function installAutomaticCampaign(db){
 db.exec(`CREATE TABLE IF NOT EXISTS automatic_campaigns(user_id TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,applicant_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,batch_size INTEGER NOT NULL DEFAULT 20,current_batch INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS automatic_batches(campaign_id TEXT NOT NULL,number INTEGER NOT NULL,opened_at TEXT NOT NULL,closed_at TEXT,PRIMARY KEY(campaign_id,number));
CREATE TABLE IF NOT EXISTS automatic_members(job_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,campaign_id TEXT NOT NULL,batch_number INTEGER NOT NULL,position INTEGER NOT NULL,title_group TEXT NOT NULL,outcome TEXT NOT NULL DEFAULT 'pending',reason TEXT,selected_at TEXT NOT NULL,settled_at TEXT);
CREATE TABLE IF NOT EXISTS automatic_preparation_recovery(job_id TEXT PRIMARY KEY,retries INTEGER NOT NULL DEFAULT 0,next_at TEXT,last_failure INTEGER NOT NULL);`);
}
const now=()=>new Date().toISOString();
function installed(db){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='automatic_campaigns' AND type='table'").get();}
export function automaticCampaign(db,uid){return installed(db)?db.prepare('SELECT * FROM automatic_campaigns WHERE user_id=?').get(uid):null;}
export function automaticMember(db,j){return j&&installed(db)?db.prepare('SELECT * FROM automatic_members WHERE job_id=? AND user_id=?').get(j.id,j.user_id):null;}
function submissionStarted(db,j){return !!j.local_attempt_at||['verifying','uncertain','submitted'].includes(j.local_phase)||['Submission in progress','Unconfirmed submission'].includes(j.challenge)||!!db.prepare('SELECT 1 FROM autonomous_attempts WHERE job_id=?').get(j.id)||!!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submission_started','manual_submission','automatic_submission','applicant_reported_submission','submitted','manual_confirmation') LIMIT 1").get(j.id);}
function memberProblem(db,j){
 const problem=preparationCandidateProblem(db,j,{fresh:false});if(problem)return problem;
 if(metadataFor(j).manualReview||globalThis.ApplyPilotPolicy.customApplication(j.url))return 'This employer form requires manual review.';
 return '';
}
export function automaticClaimProblem(db,j){
 const c=automaticCampaign(db,j.user_id);if(!c)return null;
 const member=automaticMember(db,j);
 if(!c.enabled)return 'Automatic campaign is stopped.';
 if(!member||member.campaign_id!==c.id||member.batch_number!==c.current_batch||member.outcome!=='pending')return 'This job is outside the current automatic batch.';
 if(j.local_owner||j.status==='local_browser')return 'This application belongs to an existing local browser.';
 if(db.prepare("SELECT 1 FROM jobs WHERE user_id=? AND status='running' AND id!=? LIMIT 1").get(j.user_id,j.id))return 'Another hosted application is running.';
 if(!['queued','running'].includes(j.status))return 'This application is parked for review.';
 return memberProblem(db,j);
}
export function automaticAllowsSubmit(db,j){return !!automaticMember(db,j)&&automaticClaimProblem(db,j)==='';}

export function startAutomaticCampaign(db,uid,{applicant_id,mode,auto_submit,batch_size=20}={}){
 if(mode!=='automatic'||auto_submit!==true||batch_size!==20)throw Error('Explicitly authorize automatic submission in batches of 20.');
 const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(applicant_id,uid),scope=currentSearchScope(db,{user_id:uid,applicant_id});
 if(!p?.consent||!p.email||!p.resume_path||p.execution_mode!=='cloud'||!scope)throw Error('A saved hosted profile, resume, consent and enabled structured search are required.');
 const old=automaticCampaign(db,uid);if(old&&old.applicant_id!==applicant_id)throw Error('Resume this campaign with its original applicant.');
 if(db.prepare("SELECT 1 FROM jobs WHERE user_id=? AND status='running' LIMIT 1").get(uid))throw Error('Let the currently running application settle before switching campaigns.');
 db.exec('BEGIN IMMEDIATE');try{
  if(old)db.prepare('UPDATE automatic_campaigns SET enabled=1 WHERE user_id=?').run(uid);
  else db.prepare('INSERT INTO automatic_campaigns VALUES(?,?,?,1,20,1,?)').run(uid,randomUUID(),applicant_id,now());
  db.prepare('UPDATE preparation_campaigns SET enabled=0 WHERE user_id=?').run(uid);
  db.prepare('UPDATE application_batch_preferences SET enabled=0 WHERE user_id=?').run(uid);
  db.prepare('UPDATE work_focus SET enabled=0,auto_submit=0,skip_blocked=0,job_id=NULL WHERE user_id=?').run(uid);
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
 return populateAutomaticCampaign(db,uid);
}
export function stopAutomaticCampaign(db,uid){db.prepare('UPDATE automatic_campaigns SET enabled=0 WHERE user_id=?').run(uid);return automaticSnapshot(db,uid);}

// Explicit recovery is limited to a current-batch form that never reached
// submission. Keep the same job/member and record assistance; a changed label
// or challenge can never erase a durable attempt or employer receipt.
export function recoverAutomaticPreparation(db,uid,jobId){
 db.exec('BEGIN IMMEDIATE');try{
  const c=automaticCampaign(db,uid),j=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(jobId,uid),m=automaticMember(db,j);
  if(!c?.enabled||!m||m.campaign_id!==c.id||m.batch_number!==c.current_batch||m.outcome!=='blocked')throw Error('Only a blocked form in the active batch can resume.');
  if(!['paused','needs_review','queued'].includes(j.status))throw Error('Only a parked form can resume; a running application cannot restart.');
  if(j.local_owner||j.handoff_available||submissionStarted(db,j))throw Error('An existing browser or possible submission is protected from restarting.');
  // A legacy preparation action can queue a job while its batch member stays
  // blocked. Reconcile that same unattempted record; do not create a new member.
  if(!['Missing answers','Form validation','Sensitive action','Worker error','Employer declaration'].includes(j.challenge||m.reason))throw Error('This employer step is deferred.');
  const problem=memberProblem(db,j);if(problem)throw Error(problem);
  db.prepare("UPDATE jobs SET status='queued',challenge=NULL,updated_at=? WHERE id=?").run(now(),j.id);
  db.prepare("UPDATE automatic_members SET outcome='pending',reason=NULL,settled_at=NULL WHERE job_id=?").run(j.id);
  db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'human_assistance','Preparation explicitly resumed after review; any eventual completion is assisted.')").run(j.id,now());
  db.exec('COMMIT');return {ok:true};
 }catch(error){db.exec('ROLLBACK');throw error;}
}

export function transientPreparationFailure(message){
 const text=String(message||'');
 if(/^Worker stopped: (?:[A-Za-z][\w.]*: )?Target crashed(?:\r?\n|$)/.test(text))return 'Employer browser crashed before submission';
 if(/^Worker stopped: page\.goto: (?:net::ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_TIMED_OUT|TIMED_OUT|NAME_NOT_RESOLVED)\b|Timeout \d+ms exceeded\.)/.test(text))return 'Temporary employer-page navigation failure';
 if(text==='Worker stopped: browser process restarted before submission.')return 'Worker restarted before submission';
 return '';
}

function recoverTransientPreparation(db,c,j,m,date){
 if(m.batch_number!==c.current_batch||!['pending','blocked'].includes(m.outcome)||j.status!=='needs_review'||j.challenge!=='Worker error')return null;
 if(j.local_owner||j.handoff_available||j.confirmation||submissionStarted(db,j))return null;
 if(db.prepare('SELECT execution_mode FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,j.user_id)?.execution_mode!=='cloud')return null;
 const failure=db.prepare("SELECT rowid AS failure_id,message FROM events WHERE job_id=? AND type='needs_review' ORDER BY rowid DESC LIMIT 1").get(j.id);
 const cause=transientPreparationFailure(failure?.message);if(!cause)return null;
 const problem=memberProblem(db,j);if(problem)return {outcome:'blocked',reason:'Automatic recovery held: '+problem};
 // The worker has to close the failed context before another one can be opened.
 if(!db.prepare("SELECT 1 FROM events WHERE job_id=? AND rowid>? AND type='handoff_closed' LIMIT 1").get(j.id,failure.failure_id))return {outcome:'blocked',reason:'Automatic recovery held: closure of the failed browser has not been recorded.'};
 let recovery=db.prepare('SELECT * FROM automatic_preparation_recovery WHERE job_id=?').get(j.id);
 if((recovery?.retries||0)>=2){
  if(recovery.last_failure!==failure.failure_id){
   db.prepare('UPDATE automatic_preparation_recovery SET next_at=NULL,last_failure=? WHERE job_id=?').run(failure.failure_id,j.id);
   db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'automatic_recovery_exhausted','Two automatic preparation recoveries were used. This form is deferred; other eligible jobs continue.')").run(j.id,date);
  }
  return {outcome:'blocked',reason:'Automatic recovery exhausted: two preparation retries used; other jobs continue.'};
 }
 if(!recovery||recovery.last_failure!==failure.failure_id){
  const next=new Date(Date.parse(date)+((recovery?.retries||0)?120000:30000)).toISOString();
  db.prepare('INSERT INTO automatic_preparation_recovery(job_id,retries,next_at,last_failure) VALUES(?,0,?,?) ON CONFLICT(job_id) DO UPDATE SET next_at=excluded.next_at,last_failure=excluded.last_failure').run(j.id,next,failure.failure_id);
  db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'automatic_recovery_scheduled',?)").run(j.id,date,cause+'. A bounded preparation recovery is scheduled for '+next+'. No submission retry is permitted.');
  recovery=db.prepare('SELECT * FROM automatic_preparation_recovery WHERE job_id=?').get(j.id);
 }
 if(!recovery.next_at)return null;
 if(recovery.next_at>date)return {reason:cause+'. Automatic preparation recovery scheduled for '+recovery.next_at};
 db.prepare('UPDATE automatic_preparation_recovery SET retries=retries+1,next_at=NULL WHERE job_id=?').run(j.id);
 db.prepare("UPDATE jobs SET status='queued',challenge=NULL,updated_at=? WHERE id=?").run(date,j.id);
 db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'automatic_preparation_recovery',?)").run(j.id,date,cause+'. Requeued the same unsubmitted application ('+(recovery.retries+1)+'/2).');
 return {reason:'Automatic preparation recovery queued; submission protections remain active.'};
}

function recoverDiscoveryEligibility(db,c,date){
 // A discovery-only false negative can resolve after fresh metadata arrives.
 // This is never a reset of an opened form, selected member or attempted job.
 const rows=db.prepare(`SELECT * FROM jobs j WHERE user_id=? AND applicant_id=?
 AND status='needs_review' AND challenge='Pipeline needs attention' AND attempts=0
 AND local_owner IS NULL AND local_attempt_at IS NULL AND COALESCE(local_phase,'')=''
 AND handoff_available=0 AND COALESCE(confirmation,'')=''
 AND NOT EXISTS(SELECT 1 FROM automatic_members m WHERE m.job_id=j.id)
 AND EXISTS(SELECT 1 FROM events e WHERE e.job_id=j.id AND e.type='discovered')
 AND NOT EXISTS(SELECT 1 FROM events e WHERE e.job_id=j.id AND e.type IN ('running','prepared','completion_tracking','human_assistance','local_browser'))`).all(c.user_id,c.applicant_id);
 for(const j of rows){
  const last=db.prepare("SELECT message FROM events WHERE job_id=? AND type='needs_review' ORDER BY rowid DESC LIMIT 1").get(j.id);
  if(last?.message!=='This job does not meet the saved work eligibility requirements.'||metadataFor(j).eligibility?.eligible!==true||memberProblem(db,j))continue;
  db.prepare("UPDATE jobs SET status='saved',challenge=NULL,updated_at=? WHERE id=?").run(date,j.id);
  db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'discovery_eligibility_recovered','Fresh employer metadata now passes the approved scope. No form was previously opened or attempted; discovery history is retained.')").run(j.id,date);
 }
}

// Batch boundaries and each terminal disposition are persisted independently of
// the browser. An unresolved receipt settles scheduling, never duplicate safety.
export function populateAutomaticCampaign(db,uid){
 let c=automaticCampaign(db,uid);if(!c?.enabled)return automaticSnapshot(db,uid);
 db.exec('BEGIN IMMEDIATE');try{
  const evidence=new Map(operationSnapshot(db,uid).applications.map(j=>[j.id,j]));
  for(const m of db.prepare('SELECT * FROM automatic_members WHERE campaign_id=?').all(c.id)){
   const j=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(m.job_id,uid);if(!j)continue;
   let outcome=m.outcome,reason=m.reason;
   if(evidence.get(j.id)?.confirmed){outcome='confirmed';reason='Attributable employer receipt recorded.';}
   else if(m.outcome==='pending'){
    if(j.status==='running')continue;
    if(submissionStarted(db,j)){outcome='unresolved';reason='Submission outcome is protected from retries; receipt review required.';}
    else if(['duplicate','archived'].includes(j.status)){outcome=j.status;reason='Excluded with history preserved.';}
    else if(['paused','needs_review','local_browser'].includes(j.status)){outcome='blocked';reason=j.challenge||'The employer form needs review.';}
    else{reason=memberProblem(db,j);if(reason)outcome='deferred';}
   }
   const recovery=!evidence.get(j.id)?.confirmed&&recoverTransientPreparation(db,c,j,m,now());
   if(recovery){outcome=recovery.outcome||'pending';reason=recovery.reason;}
   if(outcome!==m.outcome||reason!==m.reason)db.prepare('UPDATE automatic_members SET outcome=?,reason=?,settled_at=? WHERE job_id=?').run(outcome,reason,outcome==='pending'?null:now(),j.id);
  }
  let batch=db.prepare('SELECT * FROM automatic_members WHERE campaign_id=? AND batch_number=? ORDER BY position').all(c.id,c.current_batch);
  if(batch.length===20&&batch.every(m=>m.outcome!=='pending')){
   db.prepare('UPDATE automatic_batches SET closed_at=COALESCE(closed_at,?) WHERE campaign_id=? AND number=?').run(now(),c.id,c.current_batch);
   db.prepare('UPDATE automatic_campaigns SET current_batch=current_batch+1 WHERE user_id=?').run(uid);c={...c,current_batch:c.current_batch+1};batch=[];
  }
  db.prepare('INSERT OR IGNORE INTO automatic_batches VALUES(?,?,?,NULL)').run(c.id,c.current_batch,now());
  if(batch.length<20){
   recoverDiscoveryEligibility(db,c,now());
   const scope=currentSearchScope(db,{user_id:uid,applicant_id:c.applicant_id});
   if(scope){
    const rows=db.prepare("SELECT * FROM jobs WHERE user_id=? AND applicant_id=? AND status IN ('saved','queued') AND NOT EXISTS(SELECT 1 FROM automatic_members m WHERE m.job_id=jobs.id)").all(uid,c.applicant_id).filter(j=>!preparationCandidateProblem(db,j)&&!memberProblem(db,j));
    const history=db.prepare('SELECT title_group FROM automatic_members WHERE campaign_id=?').all(c.id);
    const ordered=rotateTitles(prioritizeApplications(db,uid,rows),scope.roles,history);
    for(const [i,j] of ordered.slice(0,20-batch.length).entries()){
     db.prepare("INSERT INTO automatic_members VALUES(?,?,?,?,?,?,'pending',NULL,?,NULL)").run(j.id,uid,c.id,c.current_batch,batch.length+i+1,j.title_group,now());
     if(j.status==='saved')db.prepare("UPDATE jobs SET status='queued',updated_at=? WHERE id=?").run(now(),j.id);
    }
   }
  }
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
 return automaticSnapshot(db,uid);
}
export function automaticSnapshot(db,uid){
 const c=automaticCampaign(db,uid);if(!c)return {enabled:false,mode:'manual'};
 const evidence=new Map(operationSnapshot(db,uid).applications.map(j=>[j.id,j]));
 const members=db.prepare(`SELECT m.*,j.title,j.company,j.url,j.status,j.confirmation,
 EXISTS(SELECT 1 FROM events e WHERE e.job_id=j.id AND e.type='prepared') AS prepared,
 (SELECT MIN(at) FROM events e WHERE e.job_id=j.id AND e.type IN ('submitted','manual_confirmation')) AS receipt_at
 FROM automatic_members m JOIN jobs j ON j.id=m.job_id WHERE m.campaign_id=? ORDER BY batch_number,position`).all(c.id).map(m=>({...m,evidence:evidence.get(m.job_id)||{}}));
 const totals={selected:members.length,prepared:0,attempted:0,confirmed:0,automatic:0,assisted:0,unknown:0,blocked:0,deferred:0,unresolved:0};
 for(const m of members){if(m.prepared)totals.prepared++;for(const key of ['attempted','confirmed','automatic','assisted','unknown'])if(m.evidence[key])totals[key]++;if(m.outcome==='blocked')totals.blocked++;if(['deferred','duplicate','archived'].includes(m.outcome))totals.deferred++;if(m.outcome==='unresolved'&&!m.evidence.confirmed)totals.unresolved++;}
 const current=members.filter(m=>m.batch_number===c.current_batch);
 return {id:c.id,applicant_id:c.applicant_id,enabled:!!c.enabled,mode:'automatic',executor:'hosted',batch_size:20,current_batch:c.current_batch,selected:current.length,settled:current.filter(m=>m.outcome!=='pending').length,supply_needed:20-current.length,totals,batches:db.prepare('SELECT number,opened_at,closed_at FROM automatic_batches WHERE campaign_id=? ORDER BY number').all(c.id),members:members.slice(-40)};
}
