import {db,event,now} from './db.js';

export function recoverWorkerJobs() {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const j of db.prepare("SELECT * FROM jobs WHERE status='running'").all()) {
      const uncertain = !!j.local_attempt_at||['verifying','uncertain','submitted'].includes(j.local_phase)||['Submission in progress','Unconfirmed submission'].includes(j.challenge)||!!db.prepare('SELECT 1 FROM autonomous_attempts WHERE job_id=?').get(j.id)||!!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submission_started','manual_submission','automatic_submission','applicant_reported_submission','submitted','manual_confirmation') LIMIT 1").get(j.id);
      db.prepare('UPDATE jobs SET status=?,challenge=?,lease_at=NULL,updated_at=? WHERE id=?').run(uncertain?'needs_review':'queued',uncertain?'Unconfirmed submission':null,now(),j.id);
      event(j.id,'recovery',uncertain?'Interrupted after submission started; receipt review required.':'Interrupted before submission; safely returned to queue.');
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function rememberAnswers(applicantId, entries) {
  const row=db.prepare('SELECT answers_json FROM applicants WHERE id=?').get(applicantId);
  const answers=JSON.parse(row.answers_json || '{}');
  for (const [question,answer] of entries) Object.defineProperty(answers,question,{value:answer,enumerable:true,configurable:true,writable:true});
  if(Object.keys(answers).length>500)throw Error('Saved answer limit reached');
  db.prepare('UPDATE applicants SET answers_json=? WHERE id=?').run(JSON.stringify(answers),applicantId);
}
