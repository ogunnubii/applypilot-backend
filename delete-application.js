import {deleteLibrary} from './answer-library.js';
export function deleteApplication(db,uid,id){
 db.exec('BEGIN IMMEDIATE');
 try{
  const job=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(id,uid);
  if(!job)throw Error('Application not found');
  if(['running','queued','local_browser'].includes(job.status)||job.handoff_available)throw Error('Stop the application and close its live session before deleting it');
  for(const row of db.prepare('SELECT id FROM answer_history WHERE job_id=? AND user_id=?').all(id,uid))deleteLibrary(db,uid,row.id);
  db.prepare('DELETE FROM blocker_emails WHERE job_id=?').run(id);
  db.prepare('DELETE FROM events WHERE job_id=?').run(id);
  db.prepare('UPDATE work_focus SET job_id=NULL WHERE user_id=? AND job_id=?').run(uid,id);
  db.prepare('DELETE FROM jobs WHERE id=? AND user_id=?').run(id,uid);
  db.exec('COMMIT');return {ok:true};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
