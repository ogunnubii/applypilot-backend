export function installManualSubmitRecords(db){db.exec("CREATE TABLE IF NOT EXISTS manual_submit_clicks(job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,click_id TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(job_id,click_id))")}
export function recordReportedSubmission(db,userId,jobId){
 db.exec('BEGIN IMMEDIATE');
 try{
  const job=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(jobId,userId);
  if(!job)throw Error('Application not found');
  if(['submitted','interview','rejected','offer'].includes(job.status)){db.exec('COMMIT');return {ok:true,alreadyRecorded:true};}
  if(['running','archived','duplicate'].includes(job.status)||job.handoff_available)throw Error('Wait for active preparation to finish before recording your submission.');
  const at=new Date().toISOString();
  db.prepare("UPDATE jobs SET status='submitted',local_attempt_at=COALESCE(local_attempt_at,?),local_phase='verifying',required_fields_json='[]',challenge='Applicant reported submission',updated_at=? WHERE id=? AND user_id=?").run(at,at,jobId,userId);
  db.prepare('INSERT INTO events(job_id,at,type,message) VALUES(?,?,?,?)').run(jobId,at,'applicant_reported_submission','Applicant reported already submitting this application. Reapplication stopped; no employer receipt was supplied.');
  db.exec('COMMIT');return {ok:true,reported:true,confirmed:false};
 }catch(error){db.exec('ROLLBACK');throw error;}
}
export function recordManualSubmit(db,job,clickId='legacy',humanAssisted=false){
 if(typeof clickId!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(clickId))throw Error('Invalid click identifier');
 const at=new Date().toISOString();db.exec('BEGIN IMMEDIATE');
 try{
 const added=db.prepare('INSERT OR IGNORE INTO manual_submit_clicks(job_id,click_id,at) VALUES(?,?,?)').run(job.id,clickId,at);
 if(added.changes){
 db.prepare("UPDATE jobs SET local_attempt_at=COALESCE(local_attempt_at,?),local_phase='verifying',required_fields_json='[]',challenge='Submission in progress',updated_at=? WHERE id=? AND status='local_browser'").run(at,at,job.id);
 const count=db.prepare('SELECT COUNT(*) AS n FROM manual_submit_clicks WHERE job_id=?').get(job.id).n;
 const event=(type,message)=>db.prepare('INSERT INTO events(job_id,at,type,message) VALUES(?,?,?,?)').run(job.id,at,type,message);
 if(humanAssisted&&!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type='human_assistance'").get(job.id))event('human_assistance','Applicant assisted with the employer form.');
 event(job.local_attempt_at?'manual_submission_retry':'manual_submission','Manual Submit click '+count+' recorded. Awaiting an employer receipt; this is not a confirmed submission.');
 if(!job.local_attempt_at)event('submission_started','Observed applicant Submit click. Automatic submission retry remains disabled.');
 }
 const clicks=db.prepare('SELECT COUNT(*) AS n FROM manual_submit_clicks WHERE job_id=?').get(job.id).n;
 db.exec('COMMIT');return {ok:true,clicks,duplicate:!added.changes,confirmed:false};
 }catch(e){db.exec('ROLLBACK');throw e}
}
