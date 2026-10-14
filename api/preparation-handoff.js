import {createHash,randomUUID} from 'node:crypto';
import {HANDOFF_SOURCE,handoffIdentity,matches,protectionCondition,validateRequest} from '../preparation-handoff.js';
import {companyKey} from '../application-history.js';
import {appendImportedProjection,importedPreparationProblem} from '../database/imported-history-boundary.js';
import {quotaStateFromJobs} from '../employer-limits.js';

// Native-schema vertical slice. Each projection, quota refresh and reservation
// shares ONE write transaction. Existing persisted native SQL fences still
// protect every native queue/attempt writer against these reservations. This
// module does not install or replace those fences or authorize a remote runtime.
const MAX_ROWS=20000,MAX_BYTES=10*1024*1024-1024;
const fail=code=>{throw Object.assign(Error(code),{code});};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hasTable=(tx,name)=>tx.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",name);
async function account(tx,uid){
 if(typeof uid!=='string'||!uid||!await tx.get('SELECT id FROM users WHERE id=?',uid))fail('account_missing');
}
// Page every source in the pinned transaction. Bound materialization as well as
// the final public projection, and never SELECT personal/profile/job-note data.
async function rows(tx,sql,args,accept){
 let total=0,bytes=0;
 for(let offset=0;;offset+=100){
  const page=await tx.all(sql+' LIMIT 100 OFFSET ?',...args,offset);
  for(const row of page){
   if(++total>MAX_ROWS||(bytes+=Buffer.byteLength(JSON.stringify(row)))>MAX_BYTES)fail('incomplete_projection');
   await accept(row);
  }
  if(page.length<100)return;
 }
}
async function quotas(tx,uid,at){
 const values=[];
 await rows(tx,'SELECT * FROM employer_limits WHERE user_id=? ORDER BY observed_at DESC',[uid],async row=>{
  const jobs=[];
  if(Object.hasOwn(row,'reached_at')&&row.limit_count&&row.window_days)
   await rows(tx,`SELECT j.id,j.company,j.url,j.confirmation,j.challenge,j.local_attempt_at,
    (SELECT MIN(e.at) FROM events e WHERE e.job_id=j.id AND e.type IN ('submitted','manual_confirmation')) AS receipt_at,
    (SELECT MIN(e.at) FROM events e WHERE e.job_id=j.id AND e.type IN ('submission_started','applicant_reported_submission')) AS attempt_at
    FROM jobs j WHERE j.user_id=? AND j.applicant_id=? ORDER BY j.id`,[uid,row.applicant_id],job=>{jobs.push(job);});
  const state=quotaStateFromJobs(row,at,jobs);
  if(state.hold_until!==row.hold_until)await tx.run('UPDATE employer_limits SET hold_until=? WHERE user_id=? AND applicant_id=? AND employer_key=?',state.hold_until,uid,row.applicant_id,row.employer_key);
  values.push(state);
 });
 if(await hasTable(tx,'employer_security_holds'))
  await rows(tx,'SELECT company,employer_key FROM employer_security_holds WHERE user_id=? ORDER BY employer_key,applicant_id',[uid],row=>{values.push({...row,kind:'security',hold_until:null});});
 return values;
}
async function projection(tx,uid,at){
 const records=[],first=new Map();let bytes=0;
 const add=row=>{
  if(records.length>=MAX_ROWS||(bytes+=Buffer.byteLength(JSON.stringify(row)))>MAX_BYTES)fail('incomplete_projection');
  records.push(row);if(row.record_id.startsWith('job:'))first.set(row.record_id,row);
 };
 const identity=row=>handoffIdentity({employer:row.company,title:row.title,url:row.url,location:'Unknown'});
 await rows(tx,'SELECT job_id,company,title,url,protection FROM preparation_handoff_protections WHERE user_id=? ORDER BY job_id',[uid],row=>add({record_id:'job:'+row.job_id,status:row.protection,identity:identity(row)}));
 const attempts=await hasTable(tx,'autonomous_attempts')?' OR EXISTS(SELECT 1 FROM autonomous_attempts a WHERE a.job_id=jobs.id)':'';
 await rows(tx,`SELECT id,company,title,url FROM jobs WHERE user_id=? AND (${protectionCondition('jobs')}${attempts} OR EXISTS(SELECT 1 FROM events e WHERE e.job_id=jobs.id AND e.type IN ('submission_started','manual_submission','automatic_submission','applicant_reported_submission','submitted','manual_confirmation'))) ORDER BY id`,[uid],row=>{
  const current=identity(row),old=first.get('job:'+row.id);
  if(!old||JSON.stringify(old.identity)!==JSON.stringify(current))add({record_id:'current:'+row.id,status:'uncertain',identity:current});
 });
 await rows(tx,'SELECT job_id,started_at,company,normalized_url FROM company_application_activity WHERE user_id=? AND job_id NOT IN (SELECT job_id FROM preparation_handoff_protections WHERE user_id=?) ORDER BY job_id',[uid,uid],row=>add({record_id:'activity:'+row.job_id,status:row.started_at?'uncertain':'reserved',identity:identity({...row,title:'Unknown historical role',url:row.normalized_url})}));
 await rows(tx,'SELECT id,company,title FROM external_application_history WHERE user_id=? ORDER BY id',[uid],row=>add({record_id:'history:'+row.id,status:'uncertain',identity:identity({...row,url:null})}));
 await rows(tx,'SELECT reservation_id,identity_json FROM preparation_handoff_reservations WHERE user_id=? ORDER BY reservation_id',[uid],row=>add({record_id:'reservation:'+row.reservation_id,status:'reserved',identity:JSON.parse(row.identity_json)}));
 const holds=(await quotas(tx,uid,at)).filter(row=>row.hold_until===null||row.hold_until>at).map(row=>{
  if(typeof row.company!=='string'||!row.company.trim()||row.company.length>200||/[\x00-\x1f]/.test(row.company))fail('invalid_identity');
  return {employer:row.company.trim(),reason_code:row.kind==='security'?'excluded':'application_limit',aliases:[...new Set([companyKey(row.company),row.employer_key.split(':').slice(1).join(':')].filter(Boolean))].sort()};
 });
 const employer_holds=[...new Map(holds.map(row=>[JSON.stringify(row),row])).values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 const data={records,employer_holds};
 if(employer_holds.length>MAX_ROWS||Buffer.byteLength(JSON.stringify(data))>MAX_BYTES)fail('incomplete_projection');
 return appendImportedProjection(tx,uid,data);
}
export async function exportPreparationLedger(database,uid,{at=new Date().toISOString()}={}){
 return database.write(async tx=>{
  await account(tx,uid);
  const data=await projection(tx,uid,at),previous=await tx.get('SELECT revision FROM preparation_handoff_snapshots WHERE user_id=?',uid),revision=(previous?.revision||0)+1;
  if(!Number.isSafeInteger(revision)||revision<1)fail('invalid_snapshot_revision');
  await tx.run('INSERT INTO preparation_handoff_snapshots VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,generated_at=excluded.generated_at,protection_digest=excluded.protection_digest',uid,revision,at,digest(data));
  return {schema_version:2,source_project:HANDOFF_SOURCE,revision,generated_at:at,complete:true,records:data.records,employer_holds:data.employer_holds};
 });
}
export async function reservePreparation(database,uid,input,{at=new Date().toISOString()}={}){
 const identity=validateRequest(input);
 return database.write(async tx=>{
  await account(tx,uid);
  const previous=await tx.get('SELECT * FROM preparation_handoff_reservations WHERE user_id=? AND request_id=?',uid,input.request_id);
  if(previous&&previous.identity_json!==JSON.stringify(identity))fail('request_identity_conflict');
  const snapshot=await tx.get('SELECT * FROM preparation_handoff_snapshots WHERE user_id=?',uid),age=Date.parse(at)-Date.parse(snapshot?.generated_at);
  if(!snapshot||!Number.isFinite(age)||age<0||age>300000)fail('fresh_snapshot_required');
  const data=await projection(tx,uid,at);
  if(input.expected_revision!==snapshot.revision||digest(data)!==snapshot.protection_digest)fail('snapshot_changed');
  const importedProblem=await importedPreparationProblem(tx,{user_id:uid,company:identity.employer,title:identity.title,url:identity.url});
  if(importedProblem)return {schema_version:2,source_project:HANDOFF_SOURCE,request_id:input.request_id,identity,revision:snapshot.revision,checked_at:at,submission_allowed:false,decision:'blocked',reason_code:importedProblem,reservation_id:previous?.reservation_id||null};
  const record=data.records.find(row=>row.record_id!=='reservation:'+previous?.reservation_id&&matches(row.identity,identity));
  const names=[identity.employer,...identity.employer_aliases].map(companyKey),hold=data.employer_holds.find(row=>[row.employer,...row.aliases].map(companyKey).some(n=>names.includes(n)));
  const base={schema_version:2,source_project:HANDOFF_SOURCE,request_id:input.request_id,identity,revision:snapshot.revision,checked_at:at,submission_allowed:false};
  if(record||hold)return {...base,decision:'blocked',reason_code:hold?'employer_hold':'protected_application',reservation_id:previous?.reservation_id||null};
  const reservation_id=previous?.reservation_id||randomUUID();
  if(!previous)await tx.run('INSERT INTO preparation_handoff_reservations VALUES(?,?,?,?,?)',uid,input.request_id,reservation_id,JSON.stringify(identity),at);
  return {...base,decision:previous?'rechecked':'reserved',reservation_id};
 });
}
