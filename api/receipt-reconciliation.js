import {sameApplication,receipt as employerReceipt} from '../local-policy.js';
import {validatedReceiptText} from '../receipt-sync.js';

// Evidence-only writers: deliberately allowed during Stop/import holds. They
// never reserve or retry an employer action. Receipt, outcome and event commit
// together; every replay still validates the full supplied receipt and owner.
async function reconcile(database,jobId,uid,owner,input,hosted){
 const text=validatedReceiptText(input.receipt),now=new Date().toISOString();
 return database.write(async tx=>{
  const job=await tx.get('SELECT * FROM jobs WHERE id=? AND user_id=?',jobId,uid);
  const attempt=hosted?await tx.get("SELECT created_at FROM autonomous_attempts WHERE job_id=? AND owner='hosted-worker'",jobId):null;
  if(!job||!sameApplication(input.url,job.url)||!employerReceipt(text)||(hosted?(job.local_owner||!attempt):(job.local_owner!==owner||!job.local_attempt_at||input.afterSubmit!==true)))throw Error('An attributable employer receipt after this submission is required.');
  if(await tx.get('SELECT job_id FROM employer_receipts WHERE job_id=?',jobId))return {ok:true,alreadySynced:true};
  if(!(hosted?['running','needs_review','submitted','interview','rejected','offer']:['local_browser','submitted','interview','rejected','offer']).includes(job.status))throw Error('This application is not eligible for receipt reconciliation.');
  const attemptAt=hosted?attempt.created_at:job.local_attempt_at,observed=Date.parse(input.observedAt),observedAt=Number.isFinite(observed)&&observed>=Date.parse(attemptAt)&&observed<=Date.now()?new Date(observed).toISOString():now;
  await tx.run('INSERT INTO employer_receipts VALUES(?,?,?,?,?,?,?,?,?,?)',job.id,uid,owner,job.url,input.url,attemptAt,text,observedAt,now,hosted?null:typeof input.receiptId==='string'?input.receiptId.slice(0,80):null);
  const prefix=hosted?'Hosted browser observed: ':'Browser extension observed: ';
  if(hosted&&['running','needs_review','submitted'].includes(job.status))await tx.run("UPDATE jobs SET status='submitted',confirmation=?,challenge=NULL,updated_at=? WHERE id=? AND user_id=?",prefix+text,now,job.id,uid);
  else if(!hosted&&(job.status==='local_browser'||job.status==='submitted'&&job.challenge==='Applicant reported submission'))await tx.run("UPDATE jobs SET status='submitted',confirmation=?,challenge=NULL,local_phase='submitted',updated_at=? WHERE id=? AND user_id=?",prefix+text,now,job.id,uid);
  else if(!employerReceipt(job.confirmation))await tx.run('UPDATE jobs SET confirmation=? WHERE id=? AND user_id=?',prefix+text,job.id,uid);
  if(!await tx.get("SELECT 1 FROM events WHERE job_id=? AND type IN ('submitted','manual_confirmation') LIMIT 1",job.id))await tx.run("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'submitted',?)",job.id,observedAt,(hosted?'Hosted browser':'Browser extension')+' observed employer confirmation: '+text);
  return {ok:true};
 });
}
export const syncLocalReceipt=(database,jobId,uid,owner,input)=>reconcile(database,jobId,uid,owner,input,false);
export const syncHostedReceipt=(database,jobId,uid,input)=>reconcile(database,jobId,uid,'hosted-worker',input,true);
