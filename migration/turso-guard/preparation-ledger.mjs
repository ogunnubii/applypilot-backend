import {createHash,randomUUID} from 'node:crypto';
import {handoffIdentity} from '../../preparation-handoff.js';
import {applicationRoleKey} from '../../application-dedup.js';
import {companyKey,historyKey} from '../../application-history.js';

// Isolated guard model only. This projects the supplied guard tables, not the
// native jobs/events/history/activity tables. It never authorizes submission.
// SQL requires a current snapshot/check even for raw preparation claim INSERT.
// The digest is computed here; SQL binds it to an immutable snapshot and uses a
// derived append-only epoch to detect state changes without a SHA/UDF dependency.
// This does not itself import native history or qualify production caller/auth parity.
export const PREPARATION_MAX_AGE_MS=300000;
export const PREPARATION_MAX_RECORDS=20000;
export const PREPARATION_MAX_BYTES=10*1024*1024-1024;
const source_project='isolated-guard-model';
const fail=code=>{throw Object.assign(Error(code),{code});};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const immutable=(table,conflict)=>`
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable_preparation_record'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable_preparation_record'); END;
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN ${conflict} BEGIN SELECT RAISE(ABORT,'immutable_preparation_record'); END;
`;

const sameEmployerSQL=(a,b)=>`(${a}.company_key IN (${b}.company_key,${b}.tenant_key) OR (${a}.tenant_key!='' AND ${a}.tenant_key IN (${b}.company_key,${b}.tenant_key)))`;
const matchesSQL=(a,b)=>`((${a}.canonical_url IS NOT NULL AND ${a}.canonical_url=${b}.canonical_url) OR (${a}.handoff_posting_key!='' AND ${a}.handoff_posting_key=${b}.handoff_posting_key) OR (${a}.role_key!='' AND ${a}.role_key=${b}.role_key AND ${sameEmployerSQL(a,b)}) OR (${a}.company_key=${b}.company_key AND ${a}.history_title_key=${b}.history_title_key))`;
const currentSnapshotSQL=r=>`EXISTS(SELECT 1 FROM guard_preparation_snapshots s JOIN guard_preparation_epochs e ON e.user_id=s.user_id WHERE s.user_id=${r}.user_id AND s.revision=${r}.snapshot_revision AND s.protection_digest=${r}.protection_digest AND s.projection_epoch=${r}.projection_epoch AND s.projection_epoch=e.epoch AND s.revision=(SELECT max(revision) FROM guard_preparation_snapshots WHERE user_id=s.user_id) AND julianday(s.generated_at)<=julianday('now') AND julianday(s.generated_at)>=julianday('now','-300 seconds'))`;
const validCheckTimeSQL=r=>`(length(${r}.checked_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',${r}.checked_at) IS ${r}.checked_at AND julianday(${r}.checked_at)<=julianday('now') AND julianday(${r}.checked_at)>=julianday('now','-300 seconds'))`;
// SQL uses a conservative JSON byte upper bound (six escaped bytes per source
// byte plus fixed metadata). It deliberately may reject a native projection
// below 10 MiB; no raw writer may bypass the actual repository projection cap.
const projectionInvalidSQL=user=>['guard_protections','guard_holds'].map(table=>{
 const id=table==='guard_protections'?'protection_id':'hold_id';
 return `(SELECT count(*) FROM ${table} WHERE user_id=${user})>${PREPARATION_MAX_RECORDS} OR EXISTS(SELECT 1 FROM ${table} p LEFT JOIN guard_identity_keys k ON k.id=p.identity_id AND k.user_id=p.user_id WHERE p.user_id=${user} AND (k.valid IS NOT 1 OR typeof(p.${id})!='text' OR length(CAST(p.${id} AS BLOB)) NOT BETWEEN 1 AND 512 OR instr(p.${id},char(0))>0 OR p.${id} GLOB ('*['||char(1)||'-'||char(31)||']*')))`;
}).join(' OR ')+` OR (${['guard_protections','guard_holds'].map(table=>{
 const id=table==='guard_protections'?'protection_id':'hold_id';
 return `coalesce((SELECT sum(512+6*(length(CAST(p.${id} AS BLOB))+length(CAST(i.company AS BLOB))+length(CAST(i.title AS BLOB))+coalesce(length(CAST(i.url AS BLOB)),0))) FROM ${table} p JOIN guard_identities i ON i.id=p.identity_id WHERE p.user_id=${user}),0)`;
}).join('+')})>${PREPARATION_MAX_BYTES}`;

// Install after GUARD_SCHEMA_SQL in the same trusted bootstrap. DDL remains a
// trusted operation. Snapshots are append-only; exporting never erases history.
export const PREPARATION_SCHEMA_SQL=`
CREATE TABLE guard_account_stop_events(event_id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL REFERENCES guard_accounts(user_id),stopped INTEGER NOT NULL CHECK(stopped IN(0,1)));
${immutable('guard_account_stop_events','EXISTS(SELECT 1 FROM guard_account_stop_events WHERE event_id=NEW.event_id)')}
CREATE TRIGGER guard_stop_event_record AFTER UPDATE OF stopped ON guard_accounts WHEN NEW.stopped!=OLD.stopped BEGIN INSERT INTO guard_account_stop_events(user_id,stopped) VALUES(NEW.user_id,NEW.stopped); END;
CREATE TABLE guard_preparation_external_events(event_id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL REFERENCES guard_accounts(user_id),source TEXT NOT NULL CHECK(source='history_import'));
${immutable('guard_preparation_external_events','EXISTS(SELECT 1 FROM guard_preparation_external_events WHERE event_id=NEW.event_id)')}
CREATE VIEW guard_preparation_epochs AS SELECT a.user_id,
 (SELECT count(*) FROM guard_protections p WHERE p.user_id=a.user_id)+(SELECT count(*) FROM guard_holds h WHERE h.user_id=a.user_id)+(SELECT count(*) FROM guard_account_stop_events e WHERE e.user_id=a.user_id)+(SELECT count(*) FROM guard_preparation_external_events x WHERE x.user_id=a.user_id) AS epoch FROM guard_accounts a;
CREATE TABLE guard_preparation_snapshots(
 user_id TEXT NOT NULL REFERENCES guard_accounts(user_id),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0 AND revision<=9007199254740991),
 generated_at TEXT NOT NULL,protection_digest TEXT NOT NULL CHECK(length(protection_digest)=64 AND protection_digest NOT GLOB '*[^0-9a-f]*'),projection_epoch INTEGER NOT NULL CHECK(typeof(projection_epoch)='integer' AND projection_epoch>=0),
 PRIMARY KEY(user_id,revision)
);
${immutable('guard_preparation_snapshots','EXISTS(SELECT 1 FROM guard_preparation_snapshots WHERE user_id=NEW.user_id AND revision=NEW.revision)')}
CREATE TRIGGER guard_preparation_snapshot_validate BEFORE INSERT ON guard_preparation_snapshots BEGIN
 SELECT CASE WHEN NEW.revision!=coalesce((SELECT max(revision) FROM guard_preparation_snapshots WHERE user_id=NEW.user_id),0)+1 THEN RAISE(ABORT,'invalid_snapshot_revision') END;
 SELECT CASE WHEN length(NEW.generated_at)!=24 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.generated_at) IS NOT NEW.generated_at THEN RAISE(ABORT,'invalid_snapshot_time') END;
 SELECT CASE WHEN julianday(NEW.generated_at)>julianday('now') THEN RAISE(ABORT,'future_snapshot_time') END;
 SELECT CASE WHEN NEW.projection_epoch IS NOT (SELECT epoch FROM guard_preparation_epochs WHERE user_id=NEW.user_id) THEN RAISE(ABORT,'snapshot_epoch_changed') END;
 SELECT CASE WHEN ${projectionInvalidSQL('NEW.user_id')} THEN RAISE(ABORT,'incomplete_projection') END;
END;
CREATE TABLE guard_preparation_reservations(
 user_id TEXT NOT NULL,request_id TEXT NOT NULL,claim_id TEXT NOT NULL UNIQUE,applicant_id TEXT NOT NULL,owner TEXT NOT NULL,
 identity_json TEXT NOT NULL CHECK(length(CAST(identity_json AS BLOB))<=16384),created_at TEXT NOT NULL,snapshot_revision INTEGER NOT NULL,
 PRIMARY KEY(user_id,request_id),FOREIGN KEY(claim_id,user_id) REFERENCES guard_claims(claim_id,user_id),
 FOREIGN KEY(user_id,snapshot_revision) REFERENCES guard_preparation_snapshots(user_id,revision)
);
${immutable('guard_preparation_reservations','EXISTS(SELECT 1 FROM guard_preparation_reservations WHERE claim_id=NEW.claim_id OR (user_id=NEW.user_id AND request_id=NEW.request_id))')}
CREATE TRIGGER guard_preparation_reservation_validate BEFORE INSERT ON guard_preparation_reservations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM guard_accounts WHERE user_id=NEW.user_id AND stopped=0) THEN RAISE(ABORT,'account_stopped_or_missing') END;
 SELECT CASE WHEN json_valid(NEW.identity_json)!=1 THEN RAISE(ABORT,'invalid_reservation_identity') END;
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM guard_claims c JOIN guard_identities i ON i.id=c.identity_id
  WHERE c.claim_id=NEW.claim_id AND c.user_id=NEW.user_id AND c.request_id=NEW.request_id AND c.owner=NEW.owner
  AND c.applicant_id=NEW.applicant_id AND c.kind='preparation' AND c.created_at=NEW.created_at
  AND json_extract(NEW.identity_json,'$.employer')=i.company AND json_extract(NEW.identity_json,'$.title')=i.title
  AND json_extract(NEW.identity_json,'$.url')=i.url
 ) THEN RAISE(ABORT,'invalid_preparation_claim') END;
 SELECT CASE WHEN NEW.snapshot_revision!=(SELECT max(revision) FROM guard_preparation_snapshots WHERE user_id=NEW.user_id) THEN RAISE(ABORT,'snapshot_changed') END;
END;
CREATE TABLE guard_preparation_checks(
 check_id TEXT PRIMARY KEY NOT NULL,user_id TEXT NOT NULL,request_id TEXT NOT NULL,claim_id TEXT NOT NULL,identity_id TEXT NOT NULL,
 applicant_id TEXT NOT NULL,owner TEXT NOT NULL,identity_json TEXT NOT NULL CHECK(length(CAST(identity_json AS BLOB))<=16384),
 snapshot_revision INTEGER NOT NULL,protection_digest TEXT NOT NULL,projection_epoch INTEGER NOT NULL,checked_at TEXT NOT NULL,
 FOREIGN KEY(identity_id,user_id) REFERENCES guard_identities(id,user_id),FOREIGN KEY(user_id,snapshot_revision) REFERENCES guard_preparation_snapshots(user_id,revision)
);
${immutable('guard_preparation_checks','EXISTS(SELECT 1 FROM guard_preparation_checks WHERE check_id=NEW.check_id)')}
CREATE INDEX guard_preparation_check_claim ON guard_preparation_checks(claim_id);
CREATE TRIGGER guard_preparation_check_validate BEFORE INSERT ON guard_preparation_checks BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM guard_accounts WHERE user_id=NEW.user_id AND stopped=0) THEN RAISE(ABORT,'account_stopped_or_missing') END;
 SELECT CASE WHEN typeof(NEW.request_id)!='text' OR length(NEW.request_id) NOT BETWEEN 16 AND 100 OR NEW.request_id GLOB '*[^a-zA-Z0-9_-]*' OR instr(NEW.request_id,char(0))>0 THEN RAISE(ABORT,'invalid_preparation_request') END;
 SELECT CASE WHEN ${['owner','applicant_id'].map(c=>`typeof(NEW.${c})!='text' OR length(NEW.${c}) NOT BETWEEN 1 AND 200 OR trim(NEW.${c})!=NEW.${c} OR instr(NEW.${c},char(0))>0 OR NEW.${c} GLOB ('*['||char(1)||'-'||char(31)||']*')`).join(' OR ')} THEN RAISE(ABORT,'invalid_preparation_context') END;
 SELECT CASE WHEN NOT ${currentSnapshotSQL('NEW')} THEN RAISE(ABORT,'preparation_snapshot_changed_or_stale') END;
 SELECT CASE WHEN NOT ${validCheckTimeSQL('NEW')} THEN RAISE(ABORT,'invalid_preparation_check_time') END;
 SELECT CASE WHEN json_valid(NEW.identity_json)!=1 THEN RAISE(ABORT,'invalid_reservation_identity') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM guard_identities i JOIN guard_identity_keys k ON k.id=i.id WHERE i.id=NEW.identity_id AND i.user_id=NEW.user_id AND k.valid=1 AND k.handoff_posting_key!='' AND i.url=k.canonical_url AND json_extract(NEW.identity_json,'$.employer')=i.company AND json_extract(NEW.identity_json,'$.title')=i.title AND json_extract(NEW.identity_json,'$.url')=i.url) THEN RAISE(ABORT,'invalid_preparation_identity') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM guard_claims c WHERE (c.claim_id=NEW.claim_id OR (c.user_id=NEW.user_id AND c.request_id=NEW.request_id)) AND NOT EXISTS(SELECT 1 FROM guard_preparation_reservations r WHERE r.claim_id=c.claim_id AND r.claim_id=NEW.claim_id AND r.user_id=NEW.user_id AND r.request_id=NEW.request_id AND r.applicant_id=NEW.applicant_id AND r.owner=NEW.owner AND r.identity_json=NEW.identity_json AND c.identity_id=NEW.identity_id AND c.kind='preparation')) THEN RAISE(ABORT,'request_identity_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM guard_protections p JOIN guard_identity_keys k ON k.id=p.identity_id JOIN guard_identity_keys c ON c.id=NEW.identity_id WHERE p.user_id=NEW.user_id AND ${matchesSQL('c','k')} AND NOT(p.protection_id='claim:'||NEW.claim_id AND EXISTS(SELECT 1 FROM guard_preparation_reservations r WHERE r.claim_id=NEW.claim_id AND r.user_id=NEW.user_id AND r.request_id=NEW.request_id))) THEN RAISE(ABORT,'application_already_protected') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM guard_holds h JOIN guard_identity_keys k ON k.id=h.identity_id JOIN guard_identity_keys c ON c.id=NEW.identity_id WHERE h.user_id=NEW.user_id AND ${sameEmployerSQL('c','k')}) THEN RAISE(ABORT,'employer_hold') END;
END;
CREATE TRIGGER guard_preparation_claim_fence BEFORE INSERT ON guard_claims WHEN NEW.kind='preparation' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM guard_preparation_checks q WHERE q.claim_id=NEW.claim_id AND q.user_id=NEW.user_id AND q.request_id=NEW.request_id AND q.identity_id=NEW.identity_id AND q.applicant_id=NEW.applicant_id AND q.owner=NEW.owner AND q.checked_at=NEW.created_at AND ${currentSnapshotSQL('q')} AND ${validCheckTimeSQL('q')}) THEN RAISE(ABORT,'preparation_snapshot_required') END;
END;
CREATE TRIGGER guard_preparation_claim_record AFTER INSERT ON guard_claims WHEN NEW.kind='preparation' BEGIN
 INSERT INTO guard_preparation_reservations SELECT q.user_id,q.request_id,q.claim_id,q.applicant_id,q.owner,q.identity_json,NEW.created_at,q.snapshot_revision FROM guard_preparation_checks q WHERE q.claim_id=NEW.claim_id AND q.user_id=NEW.user_id AND q.request_id=NEW.request_id AND q.identity_id=NEW.identity_id AND q.applicant_id=NEW.applicant_id AND q.owner=NEW.owner AND q.checked_at=NEW.created_at ORDER BY q.check_id DESC LIMIT 1;
END;
`;

function required(value,name){
 if(typeof value!=='string'||!value||value.trim()!==value||value.length>200||/[\x00-\x1f]/.test(value))fail('invalid_'+name);
 return value;
}
function timestamp(at){
 if(typeof at!=='string'||!Number.isFinite(Date.parse(at))||new Date(at).toISOString()!==at)fail('invalid_check_time');
 return at;
}
function validateRequest(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['schema_version','request_id','expected_revision','expected_digest','identity'].includes(k))||input.schema_version!==2||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1||typeof input.request_id!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(input.request_id)||(input.expected_digest!==undefined&&(typeof input.expected_digest!=='string'||!/^[a-f0-9]{64}$/.test(input.expected_digest))))fail('invalid_request');
 return handoffIdentity(input.identity,{candidate:true});
}
const names=identity=>[identity.employer,...identity.employer_aliases].map(companyKey).filter(Boolean);
function matches(a,b){
 if(a.url&&a.url===b.url)return true;
 if(a.ats&&a.ats===b.ats&&a.tenant===b.tenant&&a.requisition_id===b.requisition_id)return true;
 if(applicationRoleKey(a.title)&&applicationRoleKey(a.title)===applicationRoleKey(b.title)&&names(a).some(key=>names(b).includes(key)))return true;
 // Shared SQL also preserves the external-history title barrier.
 return companyKey(a.employer)===companyKey(b.employer)&&historyKey(a.title)===historyKey(b.title);
}
function protectedIdentity(row){
 if(row.identity_present!==1||row.valid!==1)fail('invalid_protected_identity');
 try{return handoffIdentity({employer:row.company,title:row.title,url:row.url,location:'Unknown'});}
 catch{fail('invalid_protected_identity');}
}

async function projection(tx,userId){
 const account=await tx.get('SELECT stopped FROM guard_accounts WHERE user_id=?',userId);
 if(!account)fail('account_missing');
 const data={account_stopped:account.stopped===1,records:[],employer_holds:[]};
 let bytes=Buffer.byteLength(JSON.stringify(data));
 function add(key,value){
  bytes+=Buffer.byteLength(JSON.stringify(value))+1;
  if(bytes>PREPARATION_MAX_BYTES)fail('incomplete_projection');
  data[key].push(value);
 }
 for(const [table,key,id] of [['guard_protections','records','protection_id'],['guard_holds','employer_holds','hold_id']]){
  const count=await tx.get('SELECT count(*) AS n FROM '+table+' WHERE user_id=?',userId);
  if(count.n>PREPARATION_MAX_RECORDS)fail('incomplete_projection');
  // Bound each fetched page. LEFT JOIN prevents a missing derived key from
  // silently removing a protected identity from the supposedly complete export.
  for(let offset=0;offset<count.n;offset+=100){
   const statusColumn=key==='records'?'kind':'reason';
   const validStatuses=key==='records'?"'excluded','uncertain','reserved'":"'security','quota'";
   const boundedMetadata=`typeof(p.${id})='text' AND length(CAST(p.${id} AS BLOB)) BETWEEN 1 AND 512 AND p.${statusColumn} IN (${validStatuses})`;
   // Irrelevant source/applicant fields are never fetched. Oversized IDs and
   // invalid identities become scalar failure flags before crossing into JS.
   const rows=await tx.all(`SELECT CASE WHEN ${boundedMetadata} THEN p.${id} ELSE NULL END AS record_id,CASE WHEN ${boundedMetadata} THEN p.${statusColumn} ELSE NULL END AS record_status,CASE WHEN ${boundedMetadata} THEN 1 ELSE 0 END AS metadata_valid,CASE WHEN i.id IS NOT NULL THEN 1 ELSE 0 END AS identity_present,CASE WHEN k.valid=1 THEN i.company ELSE NULL END AS company,CASE WHEN k.valid=1 THEN i.title ELSE NULL END AS title,CASE WHEN k.valid=1 THEN i.url ELSE NULL END AS url,k.valid FROM ${table} p LEFT JOIN guard_identities i ON i.id=p.identity_id AND i.user_id=p.user_id LEFT JOIN guard_identity_keys k ON k.id=i.id AND k.user_id=p.user_id WHERE p.user_id=? ORDER BY p.${id} LIMIT 100 OFFSET ?`,userId,offset);
   if(!rows.length)fail('incomplete_projection');
   for(const row of rows){
    if(row.metadata_valid!==1||/[\x00-\x1f]/.test(row.record_id))fail('invalid_projection_record');
    const identity=protectedIdentity(row);
    if(key==='records')add(key,{record_id:'guard:'+row.record_id,status:row.record_status,identity});
    else add(key,{record_id:'hold:'+row.record_id,employer:identity.employer,identity,reason_code:row.record_status==='security'?'excluded':'application_limit',aliases:identity.employer_aliases,scope:'account'});
   }
  }
 }
 return data;
}
const model={schema_version:2,source_project,isolated_model:true,native_history_imported:false,submission_allowed:false};

// A missing import is explicitly unimported, never evidence of completeness.
// Completion is append-only and restricted to the separately verified offline
// installer. This status describes its protected-history projection only.
export async function historyImportState(tx,userId){
 const status=await tx.get('SELECT pending,completed,source_snapshot_sha FROM guard_history_import_status WHERE user_id=?',userId);
 if(!status)fail('account_missing');
 if(status.pending>0||status.completed<1||!status.source_snapshot_sha)fail('history_import_incomplete');
 const imported=status.completed>0;
 return {native_history_imported:imported,source_verified:imported,source_snapshot_sha:imported?status.source_snapshot_sha:null,history_import_scope:imported?'protected_history_projection':null};
}

export async function exportPreparationLedger(db,userId,{at}={}){
 required(userId,'account');if(at!==undefined)timestamp(at);
 return db.write(async tx=>{
  // Use the enforcing database's clock, not a possibly faster client clock.
  at??=(await tx.get("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at")).at;
  const importState=await historyImportState(tx,userId);
  const data=await projection(tx,userId),previous=await tx.get('SELECT max(revision) AS revision FROM guard_preparation_snapshots WHERE user_id=?',userId);
  const revision=(previous?.revision||0)+1;
  if(!Number.isSafeInteger(revision))fail('invalid_snapshot_revision');
  const protection_digest=digest(data);
  const {epoch}=await tx.get('SELECT epoch FROM guard_preparation_epochs WHERE user_id=?',userId);
  await tx.run('INSERT INTO guard_preparation_snapshots VALUES(?,?,?,?,?)',userId,revision,at,protection_digest,epoch);
  return {...model,...importState,revision,generated_at:at,protection_digest,projection_epoch:epoch,complete:true,...data};
 });
}

// owner/applicantId and the optional clock belong to the trusted calling
// context, not the external request payload. Freshness is rechecked inside the
// write transaction, including every replay; claims/stop fences remain SQL-owned.
export async function reservePreparation(db,userId,input,{owner,applicantId,at}={}){
 required(userId,'account');required(owner,'owner');required(applicantId,'applicant');if(at!==undefined)timestamp(at);
 const identity=validateRequest(input),identityJSON=JSON.stringify(identity);
 return db.write(async tx=>{
  at??=(await tx.get("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at")).at;
  const importState=await historyImportState(tx,userId);
  const previous=await tx.get('SELECT * FROM guard_preparation_reservations WHERE user_id=? AND request_id=?',userId,input.request_id);
  if(previous&&(previous.identity_json!==identityJSON||previous.owner!==owner||previous.applicant_id!==applicantId))fail('request_identity_conflict');
  const snapshot=await tx.get('SELECT * FROM guard_preparation_snapshots WHERE user_id=? ORDER BY revision DESC LIMIT 1',userId);
  const age=Date.parse(at)-Date.parse(snapshot?.generated_at);
  if(!snapshot||!Number.isFinite(age)||age<0||age>PREPARATION_MAX_AGE_MS)fail('fresh_snapshot_required');
  const data=await projection(tx,userId);
  const {epoch}=await tx.get('SELECT epoch FROM guard_preparation_epochs WHERE user_id=?',userId);
  if(snapshot.revision!==input.expected_revision||snapshot.protection_digest!==digest(data)||snapshot.projection_epoch!==epoch||(input.expected_digest!==undefined&&input.expected_digest!==snapshot.protection_digest))fail('snapshot_changed');
  const base={...model,...importState,request_id:input.request_id,identity,revision:snapshot.revision,checked_at:at,reservation_id:previous?.claim_id||null,fresh:false};
  const record=data.records.find(row=>row.record_id!=='guard:claim:'+previous?.claim_id&&matches(row.identity,identity));
  // Native AP2 handoff exports holds across the account, even when the original
  // record belongs to another applicant. Do not narrow that barrier on replay.
  const hold=data.employer_holds.find(row=>[row.employer,...row.aliases].map(companyKey).some(key=>names(identity).includes(key)));
  if(data.account_stopped||hold||record)return {...base,decision:'blocked',reason_code:data.account_stopped?'account_stopped':hold?'employer_hold':'protected_application'};
  const existing=await tx.get('SELECT claim_id,identity_id FROM guard_claims WHERE user_id=? AND request_id=?',userId,input.request_id);
  if(existing&&!previous)fail('request_identity_conflict');
  const claimId=previous?.claim_id||randomUUID(),identityId=existing?.identity_id||randomUUID();
  if(!previous)await tx.run('INSERT INTO guard_identities VALUES(?,?,?,?,?)',identityId,userId,identity.employer,identity.title,identity.url);
  // Both first claims and replays pass the same SQL check. Claim INSERT repeats
  // the live epoch/time test so a separately committed raw check is no shortcut.
  await tx.run('INSERT INTO guard_preparation_checks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',randomUUID(),userId,input.request_id,claimId,identityId,applicantId,owner,identityJSON,snapshot.revision,snapshot.protection_digest,epoch,at);
  if(previous)return {...base,decision:'rechecked'};
  await tx.run('INSERT INTO guard_claims VALUES(?,?,?,?,?,?,?,?)',claimId,userId,input.request_id,identityId,applicantId,owner,'preparation',at);
  return {...base,decision:'reserved',reservation_id:claimId,fresh:true};
 });
}
