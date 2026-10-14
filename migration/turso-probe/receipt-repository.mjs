// First complete async repository slice. This remains disconnected from server.js
// until all installers, trigger functions, callers and claims are ported/tested.
import {sameApplication,receipt as employerReceipt} from '../../local-policy.js';
import {validatedReceiptText} from '../../receipt-sync.js';
import {writeTransaction} from './async-transactions.mjs';

export async function syncLocalReceipt(client,jobId,uid,owner,input){
 const text=validatedReceiptText(input.receipt),now=new Date().toISOString();
 return writeTransaction(client,async tx=>{
  const j=await tx.get('SELECT * FROM jobs WHERE id=? AND user_id=?',jobId,uid);
  if(!j||j.local_owner!==owner||!j.local_attempt_at||!sameApplication(input.url,j.url)||input.afterSubmit!==true||!employerReceipt(text))throw Error('An attributable employer receipt after this submission is required.');
  if(await tx.get('SELECT job_id FROM employer_receipts WHERE job_id=?',jobId))return {ok:true,alreadySynced:true};
  if(!['local_browser','submitted','interview','rejected','offer'].includes(j.status))throw Error('This application is not eligible for receipt reconciliation.');
  const observed=Date.parse(input.observedAt),attempt=Date.parse(j.local_attempt_at);
  const observedAt=Number.isFinite(observed)&&observed>=attempt&&observed<=Date.now()?new Date(observed).toISOString():now;
  await tx.run('INSERT INTO employer_receipts VALUES(?,?,?,?,?,?,?,?,?,?)',j.id,uid,owner,j.url,input.url,j.local_attempt_at,text,observedAt,now,typeof input.receiptId==='string'?input.receiptId.slice(0,80):null);
  if(j.status==='local_browser'||j.status==='submitted'&&j.challenge==='Applicant reported submission')await tx.run("UPDATE jobs SET status='submitted',confirmation=?,challenge=NULL,local_phase='submitted',updated_at=? WHERE id=?",'Browser extension observed: '+text,now,j.id);
  else if(!employerReceipt(j.confirmation))await tx.run('UPDATE jobs SET confirmation=? WHERE id=?','Browser extension observed: '+text,j.id);
  if(!await tx.get("SELECT 1 FROM events WHERE job_id=? AND type IN ('submitted','manual_confirmation') LIMIT 1",j.id))await tx.run("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'submitted',?)",j.id,observedAt,'Browser extension observed employer confirmation: '+text);
  return {ok:true};
 });
}

export async function syncHostedReceipt(client,jobId,uid,input){
 const text=validatedReceiptText(input.receipt),now=new Date().toISOString();
 return writeTransaction(client,async tx=>{
  const j=await tx.get('SELECT * FROM jobs WHERE id=? AND user_id=?',jobId,uid);
  const attempt=await tx.get("SELECT created_at FROM autonomous_attempts WHERE job_id=? AND owner='hosted-worker'",jobId);
  if(!j||j.local_owner||!attempt||!sameApplication(input.url,j.url)||!employerReceipt(text))throw Error('A hosted attempt and attributable employer receipt are required.');
  if(await tx.get('SELECT 1 FROM employer_receipts WHERE job_id=?',jobId))return {ok:true,alreadySynced:true};
  if(!['running','needs_review','submitted','interview','rejected','offer'].includes(j.status))throw Error('This application is not eligible for receipt reconciliation.');
  const observed=Date.parse(input.observedAt),observedAt=Number.isFinite(observed)&&observed>=Date.parse(attempt.created_at)&&observed<=Date.now()?new Date(observed).toISOString():now;
  await tx.run('INSERT INTO employer_receipts VALUES(?,?,?,?,?,?,?,?,?,?)',j.id,uid,'hosted-worker',j.url,input.url,attempt.created_at,text,observedAt,now,null);
  if(['running','needs_review','submitted'].includes(j.status))await tx.run("UPDATE jobs SET status='submitted',confirmation=?,challenge=NULL,updated_at=? WHERE id=?",'Hosted browser observed: '+text,now,j.id);
  else if(!employerReceipt(j.confirmation))await tx.run('UPDATE jobs SET confirmation=? WHERE id=?','Hosted browser observed: '+text,j.id);
  if(!await tx.get("SELECT 1 FROM events WHERE job_id=? AND type IN ('submitted','manual_confirmation') LIMIT 1",j.id))await tx.run("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'submitted',?)",j.id,observedAt,'Hosted browser observed employer confirmation: '+text);
  return {ok:true};
 });
}
