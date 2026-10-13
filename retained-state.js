// Retire an unavailable retained browser without turning a possible submission
// into another preparation attempt. Closure is recorded only after it happened.
export function closeRetainedBrowser(db,id,message,{crashed=false,attempted=false}={}){
 const at=new Date().toISOString();db.exec('BEGIN IMMEDIATE');
 try{
  const j=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if(!j){db.exec('COMMIT');return;}
  const uncertain=attempted||!!j.confirmation||!!j.local_attempt_at||['verifying','uncertain','submitted'].includes(j.local_phase)||['Submission in progress','Unconfirmed submission'].includes(j.challenge)||!!db.prepare('SELECT 1 FROM autonomous_attempts WHERE job_id=?').get(id)||!!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submission_started','manual_submission','automatic_submission','applicant_reported_submission','submitted','manual_confirmation') LIMIT 1").get(id);
  if(crashed&&!['submitted','interview','rejected','offer','archived','duplicate'].includes(j.status)){
   if(uncertain){
    db.prepare("UPDATE jobs SET status='needs_review',challenge='Unconfirmed submission',updated_at=? WHERE id=?").run(at,id);
   }else if(j.status==='needs_review'&&j.challenge==='Ready to submit'&&!j.local_owner){
    db.prepare("UPDATE jobs SET challenge='Worker error',updated_at=? WHERE id=?").run(at,id);
    db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'needs_review','Worker stopped: Target crashed')").run(id,at);
   }
  }
  db.prepare('UPDATE jobs SET handoff_available=0 WHERE id=?').run(id);
  db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'handoff_closed',?)").run(id,at,message);
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
}
