import {sameApplication,receipt as employerReceipt} from './local-policy.js';

export function installReceiptSync(db){
 db.exec(`CREATE TABLE IF NOT EXISTS employer_receipts(job_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,owner TEXT NOT NULL,application_url TEXT NOT NULL,receipt_url TEXT NOT NULL,attempt_at TEXT NOT NULL,receipt_text TEXT NOT NULL,observed_at TEXT NOT NULL,synced_at TEXT NOT NULL,receipt_id TEXT);`);
}

// Hosted receipts use the reservation written before the one permitted click.
// Receipt, outcome and event commit together, including after worker recovery.
export function syncHostedReceipt(db,jobId,uid,input){
 const text=String(input.receipt||'').slice(0,300),now=new Date().toISOString();
 db.exec('BEGIN IMMEDIATE');try{
  const j=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(jobId,uid);
  const attempt=db.prepare("SELECT created_at FROM autonomous_attempts WHERE job_id=? AND owner='hosted-worker'").get(jobId);
  if(!j||j.local_owner||!attempt||!sameApplication(input.url,j.url)||!employerReceipt(text))throw Error('A hosted attempt and attributable employer receipt are required.');
  if(db.prepare('SELECT 1 FROM employer_receipts WHERE job_id=?').get(jobId)){db.exec('COMMIT');return {ok:true,alreadySynced:true};}
  if(!['running','needs_review','submitted','interview','rejected','offer'].includes(j.status))throw Error('This application is not eligible for receipt reconciliation.');
  const observed=Date.parse(input.observedAt),observedAt=Number.isFinite(observed)&&observed>=Date.parse(attempt.created_at)&&observed<=Date.now()?new Date(observed).toISOString():now;
  db.prepare('INSERT INTO employer_receipts VALUES(?,?,?,?,?,?,?,?,?,?)').run(j.id,uid,'hosted-worker',j.url,input.url,attempt.created_at,text,observedAt,now,null);
  if(['running','needs_review','submitted'].includes(j.status))db.prepare("UPDATE jobs SET status='submitted',confirmation=?,challenge=NULL,updated_at=? WHERE id=?").run('Hosted browser observed: '+text,now,j.id);
  else if(!employerReceipt(j.confirmation))db.prepare('UPDATE jobs SET confirmation=? WHERE id=?').run('Hosted browser observed: '+text,j.id);
  if(!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submitted','manual_confirmation') LIMIT 1").get(j.id))db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'submitted',?)").run(j.id,observedAt,'Hosted browser observed employer confirmation: '+text);
  db.exec('COMMIT');return {ok:true};
 }catch(error){db.exec('ROLLBACK');throw error;}
}

// One durable receipt per application. Retrying a lost response cannot alter
// the original receipt time, overwrite a later outcome, or add another event.
export function syncLocalReceipt(db,jobId,uid,owner,input){
 const text=String(input.receipt||'').slice(0,300),now=new Date().toISOString();
 db.exec('BEGIN IMMEDIATE');try{
  const j=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(jobId,uid);
  if(!j||j.local_owner!==owner||!j.local_attempt_at||!sameApplication(input.url,j.url)||input.afterSubmit!==true||!employerReceipt(text))throw Error('An attributable employer receipt after this submission is required.');
  const previous=db.prepare('SELECT job_id FROM employer_receipts WHERE job_id=?').get(jobId);
  if(previous){db.exec('COMMIT');return {ok:true,alreadySynced:true};}
  if(!['local_browser','submitted','interview','rejected','offer'].includes(j.status))throw Error('This application is not eligible for receipt reconciliation.');
  const observed=Date.parse(input.observedAt),attempt=Date.parse(j.local_attempt_at);
  const observedAt=Number.isFinite(observed)&&observed>=attempt&&observed<=Date.now()?new Date(observed).toISOString():now;
  db.prepare('INSERT INTO employer_receipts VALUES(?,?,?,?,?,?,?,?,?,?)').run(j.id,uid,owner,j.url,input.url,j.local_attempt_at,text,observedAt,now,typeof input.receiptId==='string'?input.receiptId.slice(0,80):null);
  if(j.status==='local_browser'||j.status==='submitted'&&j.challenge==='Applicant reported submission')db.prepare("UPDATE jobs SET status='submitted',confirmation=?,challenge=NULL,local_phase='submitted',updated_at=? WHERE id=?").run('Browser extension observed: '+text,now,j.id);
  else if(!employerReceipt(j.confirmation))db.prepare('UPDATE jobs SET confirmation=? WHERE id=?').run('Browser extension observed: '+text,j.id);
  if(!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submitted','manual_confirmation') LIMIT 1").get(j.id))db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'submitted',?)").run(j.id,observedAt,'Browser extension observed employer confirmation: '+text);
  db.exec('COMMIT');return {ok:true};
 }catch(error){db.exec('ROLLBACK');throw error;}
}
