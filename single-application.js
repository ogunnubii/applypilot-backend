import {prioritizeApplications} from './application-diversity.js';
import {applicationEvidence} from './operation-evidence.js';
import {employerHold} from './employer-limits.js';

const now=()=>new Date().toISOString();
export function installSingleApplication(db){
 db.exec(`CREATE TABLE IF NOT EXISTS work_focus(user_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,job_id TEXT);
 CREATE TABLE IF NOT EXISTS application_progress(job_id TEXT PRIMARY KEY,required_total INTEGER NOT NULL,required_filled INTEGER NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS autonomous_attempts(job_id TEXT PRIMARY KEY,owner TEXT NOT NULL,created_at TEXT NOT NULL);`);
 if(!db.prepare('PRAGMA table_info(work_focus)').all().some(c=>c.name==='auto_submit'))db.exec('ALTER TABLE work_focus ADD COLUMN auto_submit INTEGER NOT NULL DEFAULT 0');
}
export function receiptConfirmed(db,job){
 return !!job&&applicationEvidence({...job,receipt_event:db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submitted','manual_confirmation') LIMIT 1").get(job.id)}).confirmed;
}
export function focusAllowsSubmit(db,job){
 return !!db.prepare('SELECT 1 FROM work_focus WHERE user_id=? AND enabled=1 AND auto_submit=1 AND job_id=?').get(job.user_id,job.id);
}
// A blocked/uncertain application remains selected. Only a real receipt releases it.
export function ensureFocusedJob(db,userId){
 db.exec('BEGIN IMMEDIATE');
 try{
  const focus=db.prepare('SELECT * FROM work_focus WHERE user_id=? AND enabled=1').get(userId);
  if(focus){
   const current=focus.job_id?db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(focus.job_id,userId):null;
   if(!focus.job_id||receiptConfirmed(db,current)){
    const rows=db.prepare(`SELECT * FROM jobs WHERE user_id=? AND status IN ('saved','queued','paused','needs_review','local_browser')
     AND local_attempt_at IS NULL AND COALESCE(challenge,'') NOT IN ('Unconfirmed submission','Submission in progress')
     AND COALESCE(json_extract(job_metadata_json,'$.available'),1)!=0
     AND NOT EXISTS(SELECT 1 FROM autonomous_attempts a WHERE a.job_id=jobs.id)
     AND NOT EXISTS(SELECT 1 FROM events e WHERE e.job_id=jobs.id AND e.type IN ('submission_started','applicant_reported_submission','submitted','manual_confirmation'))`).all(userId).filter(j=>!employerHold(db,j));
    // Finish untouched applications first; do not restart an existing employer session.
    const untouched=rows.filter(j=>['saved','queued'].includes(j.status)&&!j.attempts&&!j.handoff_available);
    const next=prioritizeApplications(db,userId,untouched.length?untouched:rows)[0];
    db.prepare('UPDATE work_focus SET job_id=? WHERE user_id=?').run(next?.id||null,userId);
    if(next?.status==='saved')db.prepare("UPDATE jobs SET status='queued',updated_at=? WHERE id=?").run(now(),next.id);
   }
  }
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 return focusSnapshot(db,userId);
}
export function focusSnapshot(db,userId){
 const f=db.prepare('SELECT * FROM work_focus WHERE user_id=?').get(userId);
 const job=f?.job_id?db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(f.job_id,userId):null;
 const p=job?db.prepare('SELECT * FROM application_progress WHERE job_id=?').get(job.id):null;
 return {enabled:!!f?.enabled,auto_submit:!!f?.auto_submit,job_id:f?.job_id||null,
  parked:db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND status NOT IN ('duplicate','archived','submitted','interview','rejected','offer') AND id!=COALESCE(?,'')").get(userId,f?.job_id||null).n,
  progress:p?{required:p.required_total,filled:p.required_filled,percent:p.required_total?Math.floor(p.required_filled*100/p.required_total):null,updated_at:p.updated_at}:null,
  confirmed:receiptConfirmed(db,job),awaiting:!!job&&(!!job.local_attempt_at||!!db.prepare('SELECT 1 FROM autonomous_attempts WHERE job_id=?').get(job.id))&&!receiptConfirmed(db,job)};
}
export function setWorkFocus(db,userId,{enabled,auto_submit,next}={}){
 if(enabled===false){db.prepare('UPDATE work_focus SET enabled=0,auto_submit=0 WHERE user_id=?').run(userId);return focusSnapshot(db,userId);}
 const old=focusSnapshot(db,userId);
 if(next&&old.job_id&&!old.confirmed)throw Error('The selected application needs an employer confirmation before moving on.');
 db.prepare('INSERT INTO work_focus(user_id,enabled,job_id,auto_submit) VALUES(?,1,NULL,?) ON CONFLICT(user_id) DO UPDATE SET enabled=1,auto_submit=excluded.auto_submit').run(userId,auto_submit===true?1:0);
 return ensureFocusedJob(db,userId);
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
  if(j.local_attempt_at||db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submission_started','manual_submission','submitted','manual_confirmation','applicant_reported_submission') LIMIT 1").get(j.id))throw Error('A submission may already have occurred. Check the employer receipt.');
  if(!db.prepare('SELECT consent FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,userId)?.consent)throw Error('Applicant consent is required.');
  const hold=employerHold(db,j);if(hold)throw Error(hold.message);
  db.prepare('INSERT INTO autonomous_attempts VALUES(?,?,?)').run(jobId,owner,now());
  db.prepare("UPDATE jobs SET local_attempt_at=?,local_phase='verifying',challenge='Submission in progress',updated_at=? WHERE id=?").run(now(),now(),jobId);
  for(const [type,message] of [['submission_started','Autonomous submission intent saved before the employer action.'],['automatic_submission','Selected application authorized for one automatic Submit click.']])db.prepare('INSERT INTO events(job_id,at,type,message) VALUES(?,?,?,?)').run(jobId,now(),type,message);
  db.exec('COMMIT');return {ok:true,permitted:true};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
