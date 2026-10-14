import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {closeSync,existsSync,lstatSync,mkdtempSync,openSync,readSync,realpathSync,rmdirSync,unlinkSync} from 'node:fs';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {handoffIdentity} from '../../preparation-handoff.js';
import {companyKey,historyKey} from '../../application-history.js';
import {employerKey} from '../../employer-limits.js';
import {applicationEvidence} from '../../operation-evidence.js';
import {receipt,sameApplication} from '../../local-policy.js';

// Trusted, offline installer for a COMPLETE PROTECTED-HISTORY PROJECTION for
// one verified source/account. This is not an application/runtime migration or
// authorization to execute an employer action. Ordinary runtime writers must
// lack DDL privilege; this module does not provide the database access control.
// Never point it at an original/live database: supply a completed SQLite image
// and its independently retained snapshot manifest. No worker/server is loaded.
//
// Evidence allowlists exclude auth/session/provider data, answers, job notes,
// applicant contact fields and resume contents/paths. Whole-database hashes are
// checked inside the same pinned readonly transaction used for projection.
// Metadata is bounded per row/page; a hashes-only disk spool sorts row digests.
//
// Imported active quota holds conservatively remain permanent guard barriers.
// Their native calculated expiration and expired/inactive source records remain
// inspectable in the raw/plan ledger. Releasing a hold requires a separate design.
// No historical receipt creates a new claim, intent, submission permission or
// guard_receipts row. Native outcome/status and confirmed evidence stay separate.
// Accounts with no completed import are held by SQL and repositories. This
// establishes protected-history completeness only, never full runtime import.

export const HISTORY_IMPORT_POLICY=Object.freeze({version:1,maxRowBytes:262144,maxBatchBytes:1048576,maxBatchRows:100});
const fail=code=>{throw Object.assign(Error(code),{code});};
const hash=value=>createHash('sha256').update(value).digest('hex');
const encode=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?{integer:String(v)}:v instanceof Uint8Array?{blob:Buffer.from(v).toString('hex')}:v);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'&&!(value instanceof Uint8Array)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const quote=value=>'"'+value.replaceAll('"','""')+'"';
const required=(value,code,max=512)=>{if(typeof value!=='string'||!value||!value.isWellFormed()||value.length>max||/[\x00-\x1f]/.test(value))fail(code);return value;};
const integer=value=>{const n=Number(value);if(!Number.isSafeInteger(n))fail('history_unsafe_integer');return n;};
// Native writers persist Date.toISOString() values. Native quota checks compare
// these strings lexically; accepting offset/malformed dates could expire an
// actually active hold. Reject noncanonical legacy evidence for manual review.
const date=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail('history_invalid_time');return value;};

// Columns in this inventory are original evidence values, not a reserialized
// public handoff export. New source schema versions require explicit review.
const specs=[
 ['users',['id'],['id'],'id=?'],
 ['applicants',['id','user_id'],['id'],'user_id=?'],
 ['jobs',['id','user_id','applicant_id','title','company','url','normalized_url','status','attempts','lease_at','confirmation','challenge','created_at','updated_at','local_owner','local_attempt_at','local_phase','handoff_available'],['id'],'user_id=?'],
 ['events',['id','job_id','at','type'],['id'],'job_id IN (SELECT id FROM jobs WHERE user_id=?)'],
 ['autonomous_attempts',['job_id','owner','created_at'],['job_id'],'job_id IN (SELECT id FROM jobs WHERE user_id=?)'],
 ['employer_receipts',['job_id','user_id','owner','application_url','receipt_url','attempt_at','receipt_text','observed_at','synced_at','receipt_id'],['job_id'],'user_id=?'],
 ['unresolved_attempt_quarantines',['job_id','user_id','evidence_signature','created_at'],['job_id'],'user_id=?'],
 ['application_archive',['job_id','previous_status','archived_at'],['job_id'],'job_id IN (SELECT id FROM jobs WHERE user_id=?)'],
 ['preparation_handoff_protections',['user_id','job_id','company','title','url','protection'],['user_id','job_id'],'user_id=?'],
 ['company_application_activity',['job_id','user_id','applicant_id','company','company_keys','normalized_url','reserved_at','started_at'],['job_id'],'user_id=?'],
 ['external_application_history',['id','user_id','company','title','company_key','title_key','status','source','imported_at','updated_at','work_mode','country','interview_at','interview_stage'],['id'],'user_id=?'],
 ['preparation_handoff_reservations',['user_id','request_id','reservation_id','identity_json','created_at'],['user_id','request_id'],'user_id=?'],
 ['preparation_handoff_snapshots',['user_id','revision','generated_at','protection_digest'],['user_id'],'user_id=?'],
 ['employer_security_holds',['user_id','applicant_id','employer_key','company','job_id','observed_at','message','source'],['user_id','applicant_id','employer_key'],'user_id=?'],
 ['employer_limits',['user_id','applicant_id','employer_key','company','observed_at','hold_until','limit_count','window_days','message','source','reached_at','reported_until'],['user_id','applicant_id','employer_key'],'user_id=?'],
];
export const HISTORY_SOURCE_INVENTORY=Object.freeze(specs.map(([table,columns])=>Object.freeze({table,columns:Object.freeze([...columns])})));
const immutable=(table,key)=>`CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable_history_import'); END;
CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable_history_import'); END;
CREATE TRIGGER ${table}_immutable_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${key}) BEGIN SELECT RAISE(ABORT,'immutable_history_import'); END;`;
// Require an actual completed import; absence of a pending row is insufficient.
const pending="NOT EXISTS(SELECT 1 FROM guard_history_import_status WHERE user_id=NEW.user_id AND pending=0 AND completed>0 AND source_snapshot_sha IS NOT NULL)";
const completionDeny="CREATE TRIGGER guard_history_completion_installer_only BEFORE INSERT ON guard_history_completions BEGIN SELECT RAISE(ABORT,'history_completion_requires_verified_installer'); END;";

export const HISTORY_IMPORT_SCHEMA_SQL=`
CREATE TABLE guard_history_imports(import_id TEXT PRIMARY KEY NOT NULL,user_id TEXT NOT NULL REFERENCES guard_accounts(user_id),snapshot_sha256 TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,source_created_at TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(user_id,snapshot_sha256));
${immutable('guard_history_imports','import_id=NEW.import_id OR (user_id=NEW.user_id AND snapshot_sha256=NEW.snapshot_sha256)')}
CREATE TABLE guard_history_inventory(import_id TEXT NOT NULL REFERENCES guard_history_imports(import_id),source_table TEXT NOT NULL,columns_json TEXT NOT NULL,row_count INTEGER NOT NULL CHECK(row_count>=0),rows_sha256 TEXT NOT NULL,PRIMARY KEY(import_id,source_table));
${immutable('guard_history_inventory','import_id=NEW.import_id AND source_table=NEW.source_table')}
CREATE TABLE guard_history_rows(import_id TEXT NOT NULL,source_table TEXT NOT NULL,source_key TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>0),raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),raw_sha256 TEXT NOT NULL,plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),PRIMARY KEY(import_id,source_table,source_key),UNIQUE(import_id,source_table,ordinal),FOREIGN KEY(import_id,source_table) REFERENCES guard_history_inventory(import_id,source_table));
${immutable('guard_history_rows','import_id=NEW.import_id AND source_table=NEW.source_table AND (source_key=NEW.source_key OR ordinal=NEW.ordinal)')}
CREATE TRIGGER guard_history_row_bounds BEFORE INSERT ON guard_history_rows BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM guard_history_inventory WHERE import_id=NEW.import_id AND source_table=NEW.source_table AND NEW.ordinal<=row_count) THEN RAISE(ABORT,'history_inventory_mismatch') END;
 SELECT CASE WHEN length(CAST(NEW.raw_json AS BLOB))>${HISTORY_IMPORT_POLICY.maxRowBytes} OR length(CAST(NEW.plan_json AS BLOB))>${HISTORY_IMPORT_POLICY.maxRowBytes} THEN RAISE(ABORT,'history_row_too_large') END;
END;
CREATE TABLE guard_history_states(record_id TEXT PRIMARY KEY NOT NULL,import_id TEXT NOT NULL,user_id TEXT NOT NULL,source_table TEXT NOT NULL,source_key TEXT NOT NULL,native_status TEXT NOT NULL,confirmed INTEGER NOT NULL CHECK(confirmed IN(0,1)),protection_kind TEXT,observed_at TEXT NOT NULL,FOREIGN KEY(import_id,source_table,source_key) REFERENCES guard_history_rows(import_id,source_table,source_key));
${immutable('guard_history_states','record_id=NEW.record_id')}
CREATE TRIGGER guard_history_state_from_plan BEFORE INSERT ON guard_history_states BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM guard_history_rows r JOIN guard_history_imports i ON i.import_id=r.import_id WHERE r.import_id=NEW.import_id AND r.source_table=NEW.source_table AND r.source_key=NEW.source_key AND i.user_id=NEW.user_id AND json_type(r.plan_json,'$.state')='object' AND ${['record_id','import_id','user_id','source_table','source_key','native_status','confirmed','protection_kind','observed_at'].map(k=>`NEW.${k} IS json_extract(r.plan_json,'$.state.${k}')`).join(' AND ')}) THEN RAISE(ABORT,'history_state_plan_mismatch') END;
END;
CREATE TABLE guard_history_applied(import_id TEXT NOT NULL,source_table TEXT NOT NULL,source_key TEXT NOT NULL,PRIMARY KEY(import_id,source_table,source_key),FOREIGN KEY(import_id,source_table,source_key) REFERENCES guard_history_rows(import_id,source_table,source_key));
${immutable('guard_history_applied','import_id=NEW.import_id AND source_table=NEW.source_table AND source_key=NEW.source_key')}
CREATE TABLE guard_history_completions(import_id TEXT PRIMARY KEY NOT NULL REFERENCES guard_history_imports(import_id),user_id TEXT NOT NULL REFERENCES guard_accounts(user_id),completed_at TEXT NOT NULL);
${immutable('guard_history_completions','import_id=NEW.import_id')}
${completionDeny}
${['guard_history_inventory','guard_history_rows','guard_history_states','guard_history_applied'].map(table=>`CREATE TRIGGER ${table}_completed_fence BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM guard_history_completions WHERE import_id=NEW.import_id) BEGIN SELECT RAISE(ABORT,'history_import_already_complete'); END;`).join('\n')}
CREATE VIEW guard_history_import_status AS SELECT a.user_id,
 (SELECT count(*) FROM guard_history_imports i WHERE i.user_id=a.user_id AND NOT EXISTS(SELECT 1 FROM guard_history_completions c WHERE c.import_id=i.import_id)) AS pending,
 (SELECT count(*) FROM guard_history_completions c WHERE c.user_id=a.user_id) AS completed,
 CASE WHEN NOT EXISTS(SELECT 1 FROM guard_history_imports i WHERE i.user_id=a.user_id AND NOT EXISTS(SELECT 1 FROM guard_history_completions c WHERE c.import_id=i.import_id))
 THEN (SELECT i.snapshot_sha256 FROM guard_history_imports i JOIN guard_history_completions c ON c.import_id=i.import_id WHERE i.user_id=a.user_id ORDER BY i.source_created_at DESC,i.import_id DESC LIMIT 1) END AS source_snapshot_sha
 FROM guard_accounts a;
CREATE TRIGGER guard_history_claim_hold BEFORE INSERT ON guard_claims WHEN ${pending} BEGIN SELECT RAISE(ABORT,'history_import_incomplete'); END;
CREATE TRIGGER guard_history_snapshot_hold BEFORE INSERT ON guard_preparation_snapshots WHEN ${pending} BEGIN SELECT RAISE(ABORT,'history_import_incomplete'); END;
CREATE TRIGGER guard_history_started_epoch AFTER INSERT ON guard_history_imports BEGIN INSERT INTO guard_preparation_external_events(user_id,source) VALUES(NEW.user_id,'history_import'); END;
CREATE TRIGGER guard_history_completed_epoch AFTER INSERT ON guard_history_completions BEGIN INSERT INTO guard_preparation_external_events(user_id,source) VALUES(NEW.user_id,'history_import'); END;
`;
export const HISTORY_IMPORT_PREPARATION_FENCE_SQL=`CREATE TRIGGER guard_history_preparation_hold BEFORE INSERT ON guard_preparation_checks WHEN ${pending} BEGIN SELECT RAISE(ABORT,'history_import_incomplete'); END;`;

function regular(path){const s=lstatSync(path,{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n)fail('history_invalid_source_file');const actual=realpathSync(path);if((process.platform==='win32'?actual.toLowerCase():actual)!==(process.platform==='win32'?path.toLowerCase():path))fail('history_linked_source_path');return s;}
function fileHash(path){const fd=openSync(path,'r'),buffer=Buffer.allocUnsafe(65536),h=createHash('sha256');try{for(;;){const n=readSync(fd,buffer,0,buffer.length,null);if(!n)break;h.update(buffer.subarray(0,n));}return h.digest('hex');}finally{closeSync(fd);}}
function sameFile(a,b){return ['dev','ino','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);}
function noWAL(path){if(existsSync(path+'-wal')&&lstatSync(path+'-wal').size)fail('history_source_has_wal');}
function arrayHash(values,serialize=encode){const h=createHash('sha256');h.update('[');let first=true;for(const value of values){if(!first)h.update(',');h.update(serialize(value));first=false;}h.update(']');return h.digest('hex');}
function rowHash(row){return hash(encode(Object.keys(row).sort().map(key=>[key,row[key]])));}

// Same digest format as state-snapshot.mjs, on THIS connection's existing read
// transaction. The spool contains only hashes, never evidence or credentials.
function inspectPinned(source){
 const parent=resolve(tmpdir()),folder=mkdtempSync(join(parent,'applypilot-history-hashes-')),path=join(folder,'hashes.sqlite');let spool;
 try{
  if(source.prepare('PRAGMA quick_check').get().quick_check!=='ok'||source.prepare('PRAGMA foreign_key_check').get())fail('history_source_integrity_failed');
  const schema_digest=arrayHash(source.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name').iterate());
  spool=new DatabaseSync(path);spool.exec('PRAGMA journal_mode=OFF;PRAGMA synchronous=OFF;PRAGMA cache_size=-512;PRAGMA mmap_size=0;PRAGMA temp_store=FILE;CREATE TABLE hashes(d TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(d,n)) WITHOUT ROWID;BEGIN');
  const insert=spool.prepare('INSERT INTO hashes VALUES(?,?)'),tables={};
  for(const {name} of source.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").iterate()){
   const statement=source.prepare('SELECT * FROM '+quote(name));statement.setReadBigInts(true);let rows=0;
   for(const row of statement.iterate())insert.run(rowHash(row),++rows);
   Object.defineProperty(tables,name,{value:{rows,digest:arrayHash(spool.prepare('SELECT d FROM hashes ORDER BY d,n').iterate(),row=>JSON.stringify(row.d))},enumerable:true});spool.exec('DELETE FROM hashes');
  }
  return {format:1,schema_digest,tables};
 }finally{if(spool)spool.close();if(relative(parent,folder).startsWith('..')||relative(folder,path)!=='hashes.sqlite')fail('history_invalid_spool_path');if(existsSync(path))unlinkSync(path);rmdirSync(folder);}
}

function validateSchema(source,userId){
 for(const [table,columns] of specs){
  if(!source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))fail('history_required_table_missing');
  const names=new Set(source.prepare('PRAGMA table_info('+quote(table)+')').all().map(c=>c.name));if(columns.some(c=>!names.has(c)))fail('history_required_column_missing');
 }
 if(!source.prepare('SELECT id FROM users WHERE id=?').get(userId))fail('history_source_account_missing');
 const checks=[
  'SELECT 1 FROM applicants a LEFT JOIN users u ON u.id=a.user_id WHERE u.id IS NULL LIMIT 1',
  'SELECT 1 FROM jobs j LEFT JOIN applicants a ON a.id=j.applicant_id AND a.user_id=j.user_id WHERE a.id IS NULL LIMIT 1',
  ...['events','autonomous_attempts','employer_receipts','unresolved_attempt_quarantines','application_archive'].map(t=>`SELECT 1 FROM ${t} x LEFT JOIN jobs j ON j.id=x.job_id WHERE j.id IS NULL LIMIT 1`),
  ...['employer_receipts','unresolved_attempt_quarantines'].map(t=>`SELECT 1 FROM ${t} x JOIN jobs j ON j.id=x.job_id WHERE x.user_id IS NOT j.user_id LIMIT 1`),
  ...['company_application_activity','employer_security_holds','employer_limits'].map(t=>`SELECT 1 FROM ${t} x LEFT JOIN applicants a ON a.id=x.applicant_id AND a.user_id=x.user_id WHERE a.id IS NULL LIMIT 1`),
  ...['company_application_activity','employer_security_holds'].map(t=>`SELECT 1 FROM ${t} x JOIN jobs j ON j.id=x.job_id WHERE x.user_id IS NOT j.user_id OR x.applicant_id IS NOT j.applicant_id LIMIT 1`),
  ...['preparation_handoff_protections','external_application_history','preparation_handoff_reservations','preparation_handoff_snapshots'].map(t=>`SELECT 1 FROM ${t} x LEFT JOIN users u ON u.id=x.user_id WHERE u.id IS NULL LIMIT 1`),
 ];
 for(const sql of checks)if(source.prepare(sql).get())fail('history_source_reference_missing_or_cross_account');
}
function rows(source,spec,userId){const [table,columns,keys,where]=spec,statement=source.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)} WHERE ${where} ORDER BY ${keys.map(quote).join(',')}`);statement.setReadBigInts(true);return statement.iterate(userId);}
function record(spec,row){const key=encode(spec[2].map(k=>row[k])),raw=encode(row);if(Buffer.byteLength(raw)>HISTORY_IMPORT_POLICY.maxRowBytes||key.length>4096)fail('history_row_too_large');return {key,raw,sha:hash(raw)};}
function scopedJob(source,id,userId){const row=source.prepare('SELECT id,user_id,applicant_id,company,title,url,status,local_owner,local_attempt_at,confirmation,updated_at FROM jobs WHERE id=? AND user_id=?').get(id,userId);if(!row)fail('history_source_reference_missing_or_cross_account');return row;}
const evidenceTypes="'submission_started','manual_submission','automatic_submission','applicant_reported_submission','submitted','manual_confirmation'";
function nativeJobState(source,row){
 const evidence=source.prepare(`SELECT 1 FROM events WHERE job_id=? AND type IN (${evidenceTypes}) LIMIT 1`).get(row.id),attempt=source.prepare('SELECT 1 FROM autonomous_attempts WHERE job_id=?').get(row.id);
 const event=source.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submitted','manual_confirmation') LIMIT 1").get(row.id);
 const uncertain=integer(row.attempts)>0||row.local_attempt_at!==null||row.confirmation!==null||['submitted','interview','rejected','offer'].includes(row.status)||['verifying','uncertain','submitted'].includes(row.local_phase)||['Unconfirmed submission','Submission in progress'].includes(row.challenge)||evidence||attempt;
 const kind=['archived','duplicate','excluded'].includes(row.status)?'excluded':uncertain?'uncertain':row.status!=='saved'?'reserved':null;
 return {kind,confirmed:Number(applicationEvidence({confirmation:row.confirmation,receipt_event:event}).confirmed)};
}
function registerQuotaOracle(source){
 source.function('history_import_employer',{deterministic:true},(company,url)=>employerKey({company,url}));
 source.function('history_import_time',{deterministic:true},value=>{const n=Date.parse(value||'');return Number.isFinite(n)?n:null;});
 source.function('history_import_quota_identity',{deterministic:true},(url,id)=>{try{const u=new URL(url);return u.origin.toLowerCase()+u.pathname.replace(/\/(?:application|apply)\/?$/i,'').replace(/\/$/,'').toLowerCase();}catch{return id;}});
 source.function('history_import_quota_receipt',{deterministic:true},text=>Number(!!receipt(text||'')&&!/placeholder|example\.com|github\.com|unconfirmed|simulat|test receipt/i.test(text||'')));
}
function quotaState(source,row,at){
 const count=row.limit_count===null?null:integer(row.limit_count),days=row.window_days===null?null:integer(row.window_days);
 if(count!==null&&(count<1||count>999)||days!==null&&(days<1||days>365))fail('history_invalid_quota');
 if(!count||!days)return {hold_until:row.hold_until,basis:'stored-native-state',active:row.hold_until===null||row.hold_until>at};
 const sql=`WITH evidence AS(SELECT history_import_quota_identity(j.url,j.id) identity,
  CASE WHEN history_import_quota_receipt(j.confirmation) THEN history_import_time((SELECT min(e.at) FROM events e WHERE e.job_id=j.id AND e.type IN('submitted','manual_confirmation'))) END confirmed
  FROM jobs j WHERE j.user_id=? AND j.applicant_id=? AND history_import_employer(j.company,j.url)=?),
 unique_receipts AS(SELECT identity,min(confirmed) confirmed FROM evidence GROUP BY identity) `;
 const args=[row.user_id,row.applicant_id,row.employer_key],now=Date.parse(at),window=days*86400000,reached=Date.parse(row.reached_at||'');
 const nth=source.prepare(sql+'SELECT confirmed FROM unique_receipts WHERE confirmed>? AND confirmed<=? ORDER BY confirmed DESC LIMIT 1 OFFSET ?').get(...args,now-window,now,count-1);
 let until=nth?new Date(nth.confirmed+window).toISOString():'',basis='recorded-receipts';
 const atReport=Number.isFinite(reached)?source.prepare(sql+'SELECT count(*) n FROM unique_receipts WHERE confirmed>? AND confirmed<=?').get(...args,reached-window,reached).n:0;
 if(Number.isFinite(reached)&&atReport<count&&(row.reported_until===null||row.reported_until>at))if(row.reported_until===null||!until||row.reported_until>until){until=row.reported_until;basis='reported-limit';}
 return {hold_until:until,basis,active:until===null||until>at};
}

function makePlan(source,table,row,{userId,importId,key,at}){
 const id='history:'+hash(encode([importId,table,key])),plan={identities:[],protections:[],holds:[],state:null};
 function identity(company,title,url){const native=handoffIdentity({employer:company,title,url,location:'Unknown'}),identityId=id+':i'+plan.identities.length;plan.identities.push({id:identityId,user_id:userId,company:native.employer,title:native.title,url:native.url});return identityId;}
 function protect(company,title,url,kind){if(!['uncertain','excluded','reserved'].includes(kind))fail('history_invalid_protection');const identity_id=identity(company,title,url);plan.protections.push({protection_id:id+':p'+plan.protections.length,user_id:userId,identity_id,kind,source:'native-history:'+table});}
 function state(status,confirmed,kind,observed){required(status,'history_invalid_status',100);date(observed);plan.state={record_id:id,import_id:importId,user_id:userId,source_table:table,source_key:key,native_status:status,confirmed,protection_kind:kind,observed_at:observed};}
 function jobProtection(jobId,kind='uncertain'){const j=scopedJob(source,jobId,userId);protect(j.company,j.title,j.url,kind);return j;}
 if(table==='jobs'){
  const {kind,confirmed}=nativeJobState(source,row);if(kind)protect(row.company,row.title,row.url,kind);else identity(row.company,row.title,row.url);
  state(row.status,confirmed,kind,row.updated_at);
 }else if(table==='events'){
  const j=scopedJob(source,row.job_id,userId);
  if(['submission_started','manual_submission','manual_submission_retry','automatic_submission','applicant_reported_submission','submitted','manual_confirmation','interview','rejected','offer'].includes(row.type))protect(j.company,j.title,j.url,'uncertain');
  if(['interview','rejected','offer'].includes(row.type))state(row.type,0,'uncertain',row.at);
 }else if(table==='autonomous_attempts'||table==='unresolved_attempt_quarantines'){jobProtection(row.job_id);}
 else if(table==='application_archive'){jobProtection(row.job_id,'excluded');state(row.previous_status,0,'excluded',row.archived_at);}
 else if(table==='employer_receipts'){
  const j=jobProtection(row.job_id),event=source.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN('submitted','manual_confirmation') LIMIT 1").get(j.id);
  const attempt=row.owner==='hosted-worker'?(!j.local_owner?source.prepare("SELECT created_at FROM autonomous_attempts WHERE job_id=? AND owner='hosted-worker'").get(j.id)?.created_at:null):j.local_owner===row.owner?j.local_attempt_at:null;
  required(row.owner,'history_invalid_receipt_owner');date(row.attempt_at);date(row.observed_at);date(row.synced_at);
  if(Date.parse(row.observed_at)<Date.parse(row.attempt_at)||Date.parse(row.synced_at)<Date.parse(row.observed_at))fail('history_invalid_receipt_time');
  if(!event||!attempt||attempt!==row.attempt_at||!sameApplication(row.application_url,j.url)||!sameApplication(row.receipt_url,j.url)||!applicationEvidence({confirmation:row.receipt_text,receipt_event:true}).confirmed)fail('history_unattributable_native_receipt');
 }else if(table==='preparation_handoff_protections'){protect(row.company,row.title,row.url,row.protection);}
 else if(table==='company_application_activity'){
  let keys;try{keys=JSON.parse(row.company_keys);}catch{fail('history_invalid_activity_keys');}
  if(!Array.isArray(keys)||!keys.length||keys.some(k=>typeof k!=='string'||k.length>512))fail('history_invalid_activity_keys');
  protect(row.company,'Unknown historical role',row.normalized_url,row.started_at?'uncertain':'reserved');
 }else if(table==='external_application_history'){
  if(companyKey(row.company)!==row.company_key||historyKey(row.title)!==row.title_key||!['applied','screening','interview','rejected','offer'].includes(row.status))fail('history_invalid_external_history');
  protect(row.company,row.title,null,'uncertain');state(row.status,0,'uncertain',row.updated_at);
 }else if(table==='preparation_handoff_reservations'){
  let raw;try{raw=JSON.parse(row.identity_json);}catch{fail('history_invalid_reservation');}
  const valid=handoffIdentity(raw,{candidate:true});if(encode(canonical(raw))!==encode(canonical(valid)))fail('history_invalid_reservation');
  protect(valid.employer,valid.title,valid.url,'reserved');
 }else if(table==='employer_security_holds'||table==='employer_limits'){
  const key=required(row.employer_key,'history_invalid_employer_key'),match=key.match(/^(company|ashby|lever|greenhouse):(.+)$/);if(!match)fail('history_unsupported_employer_key');
  date(row.observed_at);for(const field of ['hold_until','reached_at','reported_until'])if(row[field]!==undefined&&row[field]!==null&&row[field]!=='')date(row[field]);
  const security=table==='employer_security_holds',decision=security?{hold_until:null,basis:'security',active:true}:quotaState(source,row,at);plan.hold_decision={...decision,observed_at:at,scope:'applicant',preparation_scope:'account',release_supported:false};
  for(const company of [...new Set([row.company,match[2]])]){const identity_id=identity(company,'Employer hold',null);if(decision.active)plan.holds.push({hold_id:id+':h'+plan.holds.length,user_id:userId,identity_id,applicant_id:row.applicant_id,reason:security?'security':'quota'});}
 }
 const json=encode(plan);if(Buffer.byteLength(json)>HISTORY_IMPORT_POLICY.maxRowBytes)fail('history_row_too_large');return {plan,json};
}

const execute=(tx,sql,args=[])=>tx.execute({sql,args});
const one=async(tx,sql,args=[])=>{const result=await execute(tx,sql,args);return result.rows[0];};
async function transaction(client,work){const tx=await client.transaction('write');let committing=false;try{const fk=await one(tx,'PRAGMA foreign_keys');if(integer(fk.foreign_keys)!==1)fail('history_foreign_keys_required');const result=await work(tx);committing=true;await tx.commit();return result;}catch(error){if(committing)fail('history_import_commit_uncertain');if(!tx.closed)await tx.rollback();throw error;}finally{tx.close();}}
async function insertObject(tx,table,value){const keys=Object.keys(value);await execute(tx,`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,Object.values(value));}
async function verifyObject(tx,table,primary,value){const actual=await one(tx,`SELECT ${Object.keys(value).join(',')} FROM ${table} WHERE ${primary}=?`,[value[primary]]);if(!actual||Object.entries(value).some(([key,v])=>typeof v==='number'?integer(actual[key])!==v:actual[key]!==v))fail('history_projection_mismatch');}
async function project(tx,plan){
 for(const row of plan.identities){await insertObject(tx,'guard_identities',row);const valid=await one(tx,'SELECT valid FROM guard_identity_keys WHERE id=?',[row.id]);if(!valid||integer(valid.valid)!==1)fail('history_unsupported_protected_identity');}
 for(const row of plan.protections)await insertObject(tx,'guard_protections',row);
 for(const row of plan.holds)await insertObject(tx,'guard_holds',row);
 if(plan.state)await insertObject(tx,'guard_history_states',plan.state);
}
async function verifyPlan(tx,plan){
 for(const row of plan.identities){await verifyObject(tx,'guard_identities','id',row);const valid=await one(tx,'SELECT valid FROM guard_identity_keys WHERE id=?',[row.id]);if(!valid||integer(valid.valid)!==1)fail('history_unsupported_protected_identity');}
 for(const row of plan.protections)await verifyObject(tx,'guard_protections','protection_id',row);
 for(const row of plan.holds)await verifyObject(tx,'guard_holds','hold_id',row);
 if(plan.state)await verifyObject(tx,'guard_history_states','record_id',plan.state);
}

/** Installer API. No automatic retries, source writes, network or execution. */
export async function importNativeHistory({client,databasePath,manifest,userId,batchSize=50}){
 required(userId,'history_invalid_account');if(!Number.isInteger(batchSize)||batchSize<1||batchSize>HISTORY_IMPORT_POLICY.maxBatchRows)fail('history_invalid_batch_size');
 if(!isAbsolute(databasePath)||manifest?.format!==1||manifest.complete!==true||!/^([a-f0-9]{64})$/.test(manifest.database_sha256||'')||!manifest.database?.tables)fail('history_verified_snapshot_required');
 const path=resolve(databasePath),snapshot=manifest.database_sha256,manifestHash=hash(encode(canonical(manifest))),importId=hash(encode([userId,snapshot])),at=date(manifest.database_completed_at||manifest.created_at);
 const session={import_id:importId,user_id:userId,snapshot_sha256:snapshot,manifest_sha256:manifestHash,source_created_at:at};
 await transaction(client,async tx=>{const old=await one(tx,'SELECT * FROM guard_history_imports WHERE import_id=?',[importId]);if(old){if(Object.entries(session).some(([key,v])=>old[key]!==v))fail('history_import_identity_conflict');}else await insertObject(tx,'guard_history_imports',{...session,created_at:new Date().toISOString()});});
 let source;const before=regular(path);noWAL(path);
 try{
  if(fileHash(path)!==snapshot)fail('history_snapshot_changed');
  source=new DatabaseSync(path,{readOnly:true});source.limits.length=8*1024*1024;source.exec('PRAGMA query_only=ON;PRAGMA cache_size=-512;PRAGMA mmap_size=0;PRAGMA temp_store=FILE;BEGIN');
  const version=source.prepare('PRAGMA data_version').get().data_version;
  if(encode(canonical(inspectPinned(source)))!==encode(canonical(manifest.database)))fail('history_snapshot_manifest_mismatch');
  validateSchema(source,userId);registerQuotaOracle(source);
  for(const spec of specs){
   let count=0;const digests=function*(){for(const row of rows(source,spec,userId)){count++;yield record(spec,row).sha;}};
   const inventory={import_id:importId,source_table:spec[0],columns_json:encode(spec[1]),row_count:count,rows_sha256:arrayHash(digests())};inventory.row_count=count;
   await transaction(client,async tx=>{const old=await one(tx,'SELECT * FROM guard_history_inventory WHERE import_id=? AND source_table=?',[importId,spec[0]]);if(old){if(Object.entries(inventory).some(([key,v])=>typeof v==='number'?integer(old[key])!==v:old[key]!==v))fail('history_inventory_conflict');}else await insertObject(tx,'guard_history_inventory',inventory);});
   let batch=[],bytes=0,ordinal=0;
   const flush=async()=>{if(!batch.length)return;await transaction(client,async tx=>{for(const item of batch){
    const old=await one(tx,'SELECT ordinal,raw_json,raw_sha256,plan_json FROM guard_history_rows WHERE import_id=? AND source_table=? AND source_key=?',[importId,spec[0],item.key]);
    if(old){if(integer(old.ordinal)!==item.ordinal||old.raw_json!==item.raw||old.raw_sha256!==item.sha||old.plan_json!==item.json)fail('history_row_conflict');await verifyPlan(tx,item.plan);if(!await one(tx,'SELECT 1 FROM guard_history_applied WHERE import_id=? AND source_table=? AND source_key=?',[importId,spec[0],item.key]))fail('history_projection_mismatch');continue;}
    await insertObject(tx,'guard_history_rows',{import_id:importId,source_table:spec[0],source_key:item.key,ordinal:item.ordinal,raw_json:item.raw,raw_sha256:item.sha,plan_json:item.json});
    await project(tx,item.plan);await insertObject(tx,'guard_history_applied',{import_id:importId,source_table:spec[0],source_key:item.key});
   }});batch=[];bytes=0;};
   for(const row of rows(source,spec,userId)){
    const raw=record(spec,row),planned=makePlan(source,spec[0],row,{userId,importId,key:raw.key,at}),size=Buffer.byteLength(raw.raw)+Buffer.byteLength(planned.json);
    if(batch.length&&(batch.length>=batchSize||bytes+size>HISTORY_IMPORT_POLICY.maxBatchBytes))await flush();
    batch.push({...raw,...planned,ordinal:++ordinal});bytes+=size;
   }
   await flush();if(ordinal!==count)fail('history_inventory_mismatch');
  }
  // Re-read every pinned source row and compare the actual target evidence AND
  // all projections. Verification is paged too: immutable rows cannot change
  // after a page verifies. No caller-writable "verified" flags are trusted.
  let total=0;const verifiedCounts=[];
  for(const spec of specs){let n=0,batch=[],bytes=0;
   const flush=async()=>{if(!batch.length)return;await transaction(client,async tx=>{for(const item of batch){
    const actual=await one(tx,'SELECT r.* FROM guard_history_rows r JOIN guard_history_applied a USING(import_id,source_table,source_key) WHERE r.import_id=? AND r.source_table=? AND r.source_key=?',[importId,spec[0],item.key]);
    if(!actual||integer(actual.ordinal)!==item.ordinal||actual.raw_json!==item.raw||actual.raw_sha256!==item.sha||actual.plan_json!==item.json)fail('history_completeness_verification_failed');await verifyPlan(tx,item.plan);
   }});batch=[];bytes=0;};
   for(const row of rows(source,spec,userId)){const raw=record(spec,row),planned=makePlan(source,spec[0],row,{userId,importId,key:raw.key,at}),size=Buffer.byteLength(raw.raw)+Buffer.byteLength(planned.json);
    if(batch.length&&(batch.length>=batchSize||bytes+size>HISTORY_IMPORT_POLICY.maxBatchBytes))await flush();batch.push({...raw,...planned,ordinal:++n});bytes+=size;
   }await flush();verifiedCounts.push([spec[0],n]);total+=n;
  }
  // Trusted finalization has a bounded number of metadata checks. A normal DML
  // caller cannot forge completion, even with matching count/hash fields.
  const result=await transaction(client,async tx=>{
   const inventories=await one(tx,'SELECT count(*) n FROM guard_history_inventory WHERE import_id=?',[importId]);if(integer(inventories.n)!==specs.length)fail('history_inventory_mismatch');
   for(const [table,n] of verifiedCounts){const count=await one(tx,'SELECT (SELECT row_count FROM guard_history_inventory WHERE import_id=? AND source_table=?) expected,(SELECT count(*) FROM guard_history_rows WHERE import_id=? AND source_table=?) actual,(SELECT count(*) FROM guard_history_applied WHERE import_id=? AND source_table=?) applied',[importId,table,importId,table,importId,table]);if(integer(count.expected)!==n||integer(count.actual)!==n||integer(count.applied)!==n)fail('history_completeness_verification_failed');}
   noWAL(path);if(!sameFile(before,regular(path))||fileHash(path)!==snapshot||source.prepare('PRAGMA data_version').get().data_version!==version)fail('history_source_changed_during_import');
   const old=await one(tx,'SELECT * FROM guard_history_completions WHERE import_id=?',[importId]);
   if(!old){await tx.executeMultiple('DROP TRIGGER guard_history_completion_installer_only;');await insertObject(tx,'guard_history_completions',{import_id:importId,user_id:userId,completed_at:new Date().toISOString()});await tx.executeMultiple(completionDeny);}
   return {complete:true,scope:'protected_history_projection',import_id:importId,user_id:userId,source_snapshot_sha:snapshot,source_tables:specs.length,rows:total,replayed:!!old,submission_allowed:false,application_runtime_migrated:false,quota_hold_release_supported:false};
  });
  return result;
 }finally{if(source){try{source.exec('ROLLBACK');}finally{source.close();}}}
}
