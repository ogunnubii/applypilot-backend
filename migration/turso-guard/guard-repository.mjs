import {randomUUID} from 'node:crypto';
import {sameApplication} from '../../local-policy.js';
import {applicationEvidence} from '../../operation-evidence.js';
import {RECEIPT_SQL_POLICY} from './receipt-sql.mjs';
import {historyImportState,reservePreparation} from './preparation-ledger.mjs';

// Review-only. A fresh safety claim is NOT full native execution authorization.
// No function here grants submission permission or invokes an employer/provider.
const required = (value, name, max = 200) => {
 if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw Error('invalid_' + name);
 return value;
};
function request(input) {
 return {
  userId: required(input.userId,'account'), requestId: required(input.requestId,'request'),
  applicantId: required(input.applicantId,'applicant'), owner: required(input.owner,'owner'),
  company: required(input.company,'company'), title: required(input.title,'title',500),
  url: required(input.url,'url',3000), kind: ['preparation','submission'].includes(input.kind) ? input.kind : (()=>{throw Error('invalid_claim_kind')})()
 };
}
const replayFields = {applicantId:'applicant_id',owner:'owner',company:'company',title:'title',url:'url',kind:'kind'};

export async function claimCandidate(db, input) {
 const value = request(input);
 if(value.kind==='preparation'){
  const snapshot=input.preparationSnapshot;
  if(!snapshot||!Number.isSafeInteger(snapshot.revision)||typeof snapshot.protection_digest!=='string'||!/^[a-f0-9]{64}$/.test(snapshot.protection_digest))throw Error('preparation_snapshot_required');
  const result=await reservePreparation(db,value.userId,{schema_version:2,request_id:value.requestId,expected_revision:snapshot.revision,expected_digest:snapshot.protection_digest,identity:{employer:value.company,title:value.title,url:value.url,location:input.location||'Unknown'}},{owner:value.owner,applicantId:value.applicantId});
  if(result.decision==='blocked')throw Error(result.reason_code);
  return {claimId:result.reservation_id,fresh:result.fresh,state:'reserved',submission_allowed:false};
 }
 return db.write(async tx => {
  await historyImportState(tx,value.userId);
  const previous = await tx.get(`SELECT c.*,i.company,i.title,i.url FROM guard_claim_state c JOIN guard_identities i ON i.id=c.identity_id WHERE c.user_id=? AND c.request_id=?`,value.userId,value.requestId);
  if (previous) {
   if (Object.entries(replayFields).some(([field,column])=>value[field]!==previous[column])) throw Error('request_identity_changed');
   return {claimId:previous.claim_id,fresh:false,state:previous.state,submission_allowed:false};
  }
  const claimId=randomUUID(),identityId=randomUUID(),now=new Date().toISOString();
  await tx.run('INSERT INTO guard_identities VALUES(?,?,?,?,?)',identityId,value.userId,value.company,value.title,value.url);
  await tx.run('INSERT INTO guard_claims VALUES(?,?,?,?,?,?,?,?)',claimId,value.userId,value.requestId,identityId,value.applicantId,value.owner,value.kind,now);
  return {claimId,fresh:true,state:value.kind==='submission'?'uncertain':'reserved',submission_allowed:false};
 });
}

export async function reconcileClaim(db, {userId,requestId,owner,preparationSnapshot}) {
 required(userId,'account');required(requestId,'request');required(owner,'owner');
 const row=await db.read(async tx=>{
  await historyImportState(tx,userId);
  return tx.get('SELECT c.claim_id,c.state,c.kind,c.applicant_id,r.identity_json FROM guard_claim_state c LEFT JOIN guard_preparation_reservations r ON r.claim_id=c.claim_id WHERE c.user_id=? AND c.request_id=? AND c.owner=?',userId,requestId,owner);
 });
 if(!row)return {found:false,submission_allowed:false};
 if(row.kind==='preparation'){
  if(!preparationSnapshot||!Number.isSafeInteger(preparationSnapshot.revision)||typeof preparationSnapshot.protection_digest!=='string'||!/^[a-f0-9]{64}$/.test(preparationSnapshot.protection_digest))throw Error('preparation_snapshot_required');
  const result=await reservePreparation(db,userId,{schema_version:2,request_id:requestId,expected_revision:preparationSnapshot.revision,expected_digest:preparationSnapshot.protection_digest,identity:JSON.parse(row.identity_json)},{owner,applicantId:row.applicant_id});
  return {claimId:row.claim_id,fresh:false,state:row.state,decision:result.decision,...(result.reason_code?{reason_code:result.reason_code}:{}),submission_allowed:false};
 }
 return {claimId:row.claim_id,fresh:false,state:row.state,submission_allowed:false};
}

export async function recordReceipt(db, {userId,claimId,owner,...input}) {
 required(userId,'account');required(claimId,'claim');required(owner,'owner');
 // Inspect every supplied character before accepting or reconciling evidence.
 // Truncation could hide a later failure, pending notice or placeholder marker.
 if(typeof input.receipt!=='string'||!input.receipt.isWellFormed()||input.receipt.includes('\0')||Buffer.byteLength(input.receipt,'utf8')>RECEIPT_SQL_POLICY.maxBytes)throw Error('invalid_receipt_text');
 const text=input.receipt, now=new Date().toISOString();
 if(input.afterSubmit!==true||!applicationEvidence({confirmation:text,receipt_event:true}).confirmed)throw Error('affirmative_receipt_required');
 return db.write(async tx=>{
  const c=await tx.get(`SELECT c.*,i.company,i.title,i.url FROM guard_claims c JOIN guard_identities i ON i.id=c.identity_id JOIN guard_intents a ON a.claim_id=c.claim_id WHERE c.claim_id=? AND c.user_id=? AND c.owner=? AND a.owner=? AND c.kind='submission'`,claimId,userId,owner,owner);
  if(!c||!sameApplication(input.url,c.url))throw Error('attributable_attempt_required');
  const previous=await tx.get('SELECT claim_id FROM guard_receipts WHERE claim_id=?',claimId);
  if(previous)return {ok:true,alreadySynced:true};
  const observed=Date.parse(input.observedAt),observedAt=Number.isFinite(observed)&&observed>=Date.parse(c.created_at)&&observed<=Date.parse(now)?new Date(observed).toISOString():now;
  const identityId=randomUUID();
  await tx.run('INSERT INTO guard_identities VALUES(?,?,?,?,?)',identityId,userId,c.company,c.title,input.url);
  await tx.run('INSERT INTO guard_receipts VALUES(?,?,?,?,?,?,?,?)',claimId,userId,owner,identityId,typeof input.receiptId==='string'?input.receiptId.slice(0,80):null,text,observedAt,now);
  return {ok:true};
 });
}
