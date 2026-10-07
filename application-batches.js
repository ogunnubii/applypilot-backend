import {randomUUID} from 'node:crypto';
import {prioritizeApplications} from './application-diversity.js';
import {employerHold} from './employer-limits.js';
import {supportSearchInstruction,remoteCanadaIntent,t4FallbackIntent} from './support-career.js';
import {workEligibility} from './work-eligibility.js';
const terminal=new Set(['submitted','interview','rejected','offer','archived','duplicate']);
export function installBatches(db){db.exec(`CREATE TABLE IF NOT EXISTS application_batch_preferences(user_id TEXT PRIMARY KEY,applicant_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,current_batch TEXT NOT NULL,minimum_cad INTEGER NOT NULL DEFAULT 120000,degree TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS application_batch_members(batch_id TEXT NOT NULL,job_id TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(batch_id,job_id));
CREATE TABLE IF NOT EXISTS answer_save_state(job_id TEXT NOT NULL,question TEXT NOT NULL,editing INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(job_id,question));`);}
export function batchPreferences(db,uid){if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='application_batch_preferences'").get())return null;return db.prepare('SELECT * FROM application_batch_preferences WHERE user_id=? AND enabled=1').get(uid);}
export function inActiveBatch(db,job){const p=batchPreferences(db,job.user_id);return !p||!!db.prepare('SELECT 1 FROM application_batch_members WHERE batch_id=? AND job_id=? AND user_id=?').get(p.current_batch,job.id,job.user_id);}
export function populateBatch(db,uid){
 const p=batchPreferences(db,uid);if(!p)return null;
 const instruction=supportSearchInstruction(db,uid,p.applicant_id),remoteCanadaOnly=remoteCanadaIntent(instruction),t4Fallback=remoteCanadaOnly&&t4FallbackIntent(instruction);
 db.exec('BEGIN IMMEDIATE');try{
  const size=db.prepare('SELECT COUNT(*) AS n FROM application_batch_members WHERE batch_id=?').get(p.current_batch).n;
  if(size<20){const rows=db.prepare(`SELECT * FROM jobs WHERE user_id=? AND applicant_id=? AND status IN ('saved','queued') AND local_attempt_at IS NULL AND attempts=0 AND handoff_available=0 AND challenge IS NULL
   AND NOT EXISTS(SELECT 1 FROM application_batch_members m WHERE m.job_id=jobs.id)`).all(uid,p.applicant_id).filter(j=>{let m={};try{m=JSON.parse(j.job_metadata_json||'{}')}catch{}return (!remoteCanadaOnly||workEligibility({...m,title:j.title},{remoteCanadaOnly:true,incorporatedFromCanada:true,allowCanadianEmployment:t4Fallback}).eligible)&&m.available===true&&m.supportCareer?.strong===true&&m.salaryTarget?.eligible===true&&m.salaryTarget.minimum===p.minimum_cad&&m.eligibility?.eligible===true&&!m.frenchApplication&&!employerHold(db,j);});
   const preferred=rows.filter(j=>JSON.parse(j.job_metadata_json||'{}').eligibility?.kind!=='canada-employment-fallback');
   const active=db.prepare("SELECT 1 FROM jobs j JOIN application_batch_members m ON m.job_id=j.id WHERE m.batch_id=? AND j.status NOT IN ('submitted','interview','rejected','offer','archived','duplicate') LIMIT 1").get(p.current_batch);
   const selected=preferred.length?preferred:t4Fallback&&!active?rows:[];
   for(const [i,j]of prioritizeApplications(db,uid,selected).slice(0,20-size).entries())db.prepare('INSERT INTO application_batch_members VALUES(?,?,?,?)').run(p.current_batch,j.id,uid,size+i+1);
  }db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 return batchSnapshot(db,uid);
}
export function batchSnapshot(db,uid){const p=batchPreferences(db,uid);if(!p)return {enabled:false};const members=db.prepare('SELECT j.id,j.status,j.challenge,m.position FROM jobs j JOIN application_batch_members m ON m.job_id=j.id WHERE m.batch_id=? AND m.user_id=? ORDER BY m.position').all(p.current_batch,uid);return {enabled:true,id:p.current_batch,size:20,selected:members.length,completed:members.filter(j=>terminal.has(j.status)).length,job_ids:members.map(j=>j.id),minimum_cad:p.minimum_cad,degree:p.degree,t4Fallback:remoteCanadaIntent(supportSearchInstruction(db,uid,p.applicant_id))&&t4FallbackIntent(supportSearchInstruction(db,uid,p.applicant_id))};}
export function resetSupportBatch(db,uid,{applicant_id,minimum_cad=120000,degree=''}={}){
 if(!Number.isInteger(minimum_cad)||minimum_cad<1||minimum_cad>10000000)throw Error('Enter a valid annual CAD pay target.');
 const applicant=db.prepare('SELECT id FROM applicants WHERE id=? AND user_id=?').get(applicant_id,uid);if(!applicant)throw Error('Choose your saved applicant profile.');
 const at=new Date().toISOString(),id=randomUUID(),instruction=supportSearchInstruction(db,uid,applicant.id);let archived=0;
 db.exec('BEGIN IMMEDIATE');try{
  // Retain receipts, events, answers and exact identities, including uncertain attempts.
  for(const j of db.prepare("SELECT * FROM jobs WHERE user_id=? AND status NOT IN ('submitted','interview','rejected','offer','archived','duplicate')").all(uid)){
   db.prepare('INSERT OR REPLACE INTO application_archive VALUES(?,?,?)').run(j.id,j.status,at);
   db.prepare("UPDATE jobs SET status='archived',handoff_available=0,updated_at=? WHERE id=?").run(at,j.id);
   db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'archived','Queue reset for support-career batches. History and possible submission attempts retained.')").run(j.id,at);archived++;
  }
  db.prepare('UPDATE work_focus SET enabled=0,auto_submit=0 WHERE user_id=?').run(uid);
  db.prepare("UPDATE continuation_requests SET state='cancelled',message='Queue reset' WHERE user_id=? AND state IN ('queued','dispatching','review')").run(uid);
  db.prepare('UPDATE searches SET enabled=0 WHERE user_id=?').run(uid);
  db.prepare("UPDATE funnel_items SET status='excluded',message='Archived by queue reset',updated_at=? WHERE user_id=? AND status IN ('pending','checking')").run(at,uid);
  db.prepare("INSERT INTO application_batch_preferences VALUES(?,?,1,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET applicant_id=excluded.applicant_id,enabled=1,current_batch=excluded.current_batch,minimum_cad=excluded.minimum_cad,degree=excluded.degree,created_at=excluded.created_at").run(uid,applicant.id,id,minimum_cad,String(degree).slice(0,300),at);
  db.prepare("INSERT INTO searches(id,user_id,applicant_id,instruction,boards_json,auto_queue,created_at) VALUES(?,?,?,?,'[]',1,?)").run(randomUUID(),uid,applicant.id,instruction,at);
  db.prepare('INSERT INTO pipeline_preferences VALUES(?,1,?) ON CONFLICT(user_id) DO UPDATE SET auto_queue_found=1,updated_at=excluded.updated_at').run(uid,at);
  if(String(degree).trim()){const profile=db.prepare('SELECT answers_json FROM applicants WHERE id=?').get(applicant.id),answers=JSON.parse(profile.answers_json||'{}');answers['Highest level of education']="Master's degree";answers['Field of study']=String(degree).trim().slice(0,300);db.prepare('UPDATE applicants SET answers_json=? WHERE id=?').run(JSON.stringify(answers),applicant.id);}
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 return {...batchSnapshot(db,uid),archived};
}
export function nextBatch(db,uid){const current=batchSnapshot(db,uid);if(!current.enabled||!current.selected||current.completed!==current.selected)throw Error('Finish or archive the current batch before starting another.');db.prepare('UPDATE application_batch_preferences SET current_batch=? WHERE user_id=?').run(randomUUID(),uid);return populateBatch(db,uid);}
