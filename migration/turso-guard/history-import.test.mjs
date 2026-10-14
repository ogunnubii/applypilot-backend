import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createClient} from '@libsql/client';
import {installGuardSchema} from './guard-schema.mjs';
import {createLibsqlDatabase} from '../../database/libsql.js';
import {claimCandidate,reconcileClaim} from './guard-repository.mjs';
import {exportPreparationLedger} from './preparation-ledger.mjs';
import {hashFile,inspectDatabase} from '../state-snapshot.mjs';
import {registerCompanyApplicationPolicyFunctions,companyApplicationKeys} from '../../company-application-policy.js';
import {registerPreparationHandoffFunctions,handoffIdentity,exportPreparationLedger as nativeLedger} from '../../preparation-handoff.js';
import {companyKey,historyKey} from '../../application-history.js';
import {sameApplication} from '../../application-dedup.js';
import {employerKey,employerQuotas} from '../../employer-limits.js';
import {syncLocalReceipt,syncHostedReceipt} from '../../receipt-sync.js';
import {operationSnapshot} from '../../operation-evidence.js';
import {HISTORY_IMPORT_POLICY,HISTORY_SOURCE_INVENTORY,HISTORY_IMPORT_SCHEMA_SQL,HISTORY_IMPORT_PREPARATION_FENCE_SQL,importNativeHistory} from './history-import.mjs';

// All native startup writes go to a newly created synthetic Temp database. The
// actual caller's DATABASE_PATH is never inherited by the schema-only child.
const root=mkdtempSync(join(tmpdir(),'applypilot-history-tests-'));
const template=join(root,'empty-native.sqlite'),repo=fileURLToPath(new URL('../../',import.meta.url));
execFileSync(process.execPath,['--import','./migration/test-network-guard.mjs','--input-type=module','-e',
 "import {db} from './db.js';import {installArchive} from './application-archive.js';import {installLibrary} from './answer-library.js';installArchive(db);installLibrary(db);db.exec('PRAGMA wal_checkpoint(TRUNCATE);PRAGMA journal_mode=DELETE;');db.close();"],
 {cwd:repo,env:{...process.env,DATABASE_PATH:template},stdio:'pipe',windowsHide:true});
const at='2026-10-13T12:00:00.000Z',earlier='2026-10-12T12:00:00.000Z';
const url=(tenant='fictional',n=1)=>`https://jobs.lever.co/${tenant}/${String(n).padStart(8,'0')}-1111-1111-1111-111111111111`;
const candidate=(overrides={})=>({userId:'u',applicantId:'a',owner:'browser',requestId:'new',company:'Unrelated',title:'Engineer',url:url('unrelated',999),kind:'submission',...overrides});
function register(db){registerCompanyApplicationPolicyFunctions(db);registerPreparationHandoffFunctions(db);db.function('application_employer_key',{deterministic:true},(company,url)=>employerKey({company,url}));db.function('same_application',{deterministic:true},(ac,at,au,bc,bt,bu)=>Number(sameApplication({company:ac,title:at,url:au},{company:bc,title:bt,url:bu})));db.function('history_company',{deterministic:true},companyKey);db.function('history_title',{deterministic:true},historyKey);}
function insert(db,table,row){const keys=Object.keys(row);db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));}
function job(db,id,{user_id='u',applicant_id='a',company='Fictional '+id,title='Engineer',url:link=url(id),status='saved',...extra}={}){insert(db,'jobs',{id,user_id,applicant_id,company,title,url:link,normalized_url:link,status,created_at:earlier,updated_at:at,...extra});}
function event(db,id,type,time=earlier){insert(db,'events',{job_id:id,at:time,type,message:'SYNTHETIC_ANSWER_EXCLUDED'});}
function source(seed=()=>{}){const folder=mkdtempSync(join(root,'source-')),databasePath=join(folder,'snapshot.sqlite');copyFileSync(template,databasePath);const db=new DatabaseSync(databasePath);register(db);db.exec('PRAGMA foreign_keys=ON');
 for(const id of ['u','other'])insert(db,'users',{id,email:id+'@example.invalid',password_hash:'SYNTHETIC_AUTH_EXCLUDED',created_at:earlier});
 for(const [id,user_id] of [['a','u'],['a2','u'],['other-a','other']])insert(db,'applicants',{id,user_id,name:'Fictional',created_at:earlier,answers_json:'{"private":"SYNTHETIC_ANSWER_EXCLUDED"}',resume_path:'SYNTHETIC_RESUME_EXCLUDED'});
 seed(db);db.close();return {databasePath,manifest:manifest(databasePath)};}
function manifest(path){return {format:1,complete:true,created_at:at,database_completed_at:at,database_sha256:hashFile(path),database:inspectDatabase(path)};}
async function target(t){const raw=createClient({url:':memory:',intMode:'bigint'});await raw.execute('PRAGMA foreign_keys=ON');await installGuardSchema(raw);
 if(!(await raw.execute("SELECT 1 FROM sqlite_master WHERE name='guard_history_imports'")).rows.length)await raw.executeMultiple(HISTORY_IMPORT_SCHEMA_SQL+HISTORY_IMPORT_PREPARATION_FENCE_SQL);
 await raw.execute("INSERT INTO guard_accounts VALUES('u',0),('other',0)");const db=createLibsqlDatabase(raw);t.after(()=>db.close());return {raw,db};}
const count=async(raw,table)=>Number((await raw.execute('SELECT count(*) n FROM '+table)).rows[0].n);
const status=async(raw,userId='u')=>(await raw.execute({sql:'SELECT * FROM guard_history_import_status WHERE user_id=?',args:[userId]})).rows[0];
const run=(raw,s,options={})=>importNativeHistory({client:raw,...s,userId:'u',...options});
async function pending(raw){assert.equal(Number((await status(raw)).pending),1);assert.equal(Number((await status(raw)).completed),0);assert.equal((await status(raw)).source_snapshot_sha,null);}
function wrap(raw,onExecute,onCommit){return {transaction:async mode=>{const tx=await raw.transaction(mode),statements=[];return {get closed(){return tx.closed;},execute:async input=>{const sql=typeof input==='string'?input:input.sql;statements.push(sql);await onExecute?.(input,tx);return tx.execute(input);},executeMultiple:async sql=>{statements.push(sql);return tx.executeMultiple(sql);},commit:async()=>onCommit?onCommit(tx,statements):tx.commit(),rollback:()=>tx.rollback(),close:()=>tx.close()};}};}

test('full native snapshot preserves all outcomes/evidence separately, with no inferred submission or sensitive payload copying',async t=>{
 const s=source(db=>{
  job(db,'confirmed',{status:'interview',local_owner:'browser',local_attempt_at:earlier,confirmation:null});
  syncLocalReceipt(db,'confirmed','u','browser',{receipt:'Your application has been received.',url:url('confirmed'),afterSubmit:true,observedAt:earlier,receiptId:'synthetic-receipt'});
  job(db,'uncertain',{status:'submitted',attempts:1,confirmation:'Application submitted. Placeholder test receipt.'});event(db,'uncertain','submitted');
  job(db,'reported',{status:'offer'});event(db,'reported','applicant_reported_submission');event(db,'reported','offer');
  job(db,'rejected',{status:'rejected'});event(db,'rejected','rejected');
  job(db,'archived',{status:'archived'});insert(db,'application_archive',{job_id:'archived',previous_status:'needs_review',archived_at:at});
  job(db,'hosted',{status:'needs_review'});insert(db,'autonomous_attempts',{job_id:'hosted',owner:'hosted-worker',created_at:earlier});syncHostedReceipt(db,'hosted','u',{receipt:'Your application has been received.',url:url('hosted'),observedAt:earlier});
  insert(db,'unresolved_attempt_quarantines',{job_id:'hosted',user_id:'u',evidence_signature:'synthetic-signature',created_at:at});
  job(db,'other-job',{user_id:'other',applicant_id:'other-a',status:'submitted'});
 });
 const before=hashFile(s.databasePath),native=new DatabaseSync(s.databasePath);register(native);const oracle=operationSnapshot(native,'u');native.close();
 const {raw}=await target(t),result=await run(raw,s,{batchSize:2});assert.equal(result.complete,true);assert.equal(result.scope,'protected_history_projection');assert.equal(result.application_runtime_migrated,false);assert.equal(result.submission_allowed,false);assert.equal(result.source_tables,HISTORY_SOURCE_INVENTORY.length);assert.equal(hashFile(s.databasePath),before);
 const rows=(await raw.execute("SELECT raw_json,plan_json FROM guard_history_rows WHERE source_table='jobs'")).rows;assert.equal(rows.length,6);const states=(await raw.execute("SELECT native_status,confirmed,source_key FROM guard_history_states WHERE source_table='jobs'")).rows;
 for(const item of oracle.applications){const state=states.find(r=>JSON.parse(r.source_key)[0]===item.id);assert.equal(Number(state.confirmed),Number(item.confirmed));}
 assert.equal(states.find(r=>JSON.parse(r.source_key)[0]==='confirmed').native_status,'interview');assert.equal(states.find(r=>JSON.parse(r.source_key)[0]==='uncertain').native_status,'submitted');assert.equal(Number(states.find(r=>JSON.parse(r.source_key)[0]==='uncertain').confirmed),0);
 const evidence=JSON.stringify((await raw.execute('SELECT raw_json FROM guard_history_rows')).rows);assert.doesNotMatch(evidence,/SYNTHETIC_AUTH_EXCLUDED|SYNTHETIC_ANSWER_EXCLUDED|SYNTHETIC_RESUME_EXCLUDED|other-job/);assert.match(evidence,/synthetic-receipt/);
 assert.equal(await count(raw,'guard_receipts'),0);assert.equal(await count(raw,'guard_claims'),0);assert.equal(await count(raw,'guard_intents'),0);assert.equal(Number((await status(raw)).completed),1);assert.equal(Number((await status(raw)).pending),0);assert.equal(await count(raw,'guard_preparation_external_events'),2);
 const counts=await count(raw,'guard_history_rows');assert.equal((await run(raw,s)).replayed,true);assert.equal(await count(raw,'guard_history_rows'),counts);assert.equal(await count(raw,'guard_preparation_external_events'),2);
});

test('deleted journal/activity identities, external outcomes, reservations and Unicode/ATS aliases block duplicate claims',async t=>{
 const reserved=handoffIdentity({employer:'Reservation Incorporated',title:'Engineer',url:url('reservation'),location:'Unknown'},{candidate:true});
 const s=source(db=>{
  insert(db,'preparation_handoff_protections',{user_id:'u',job_id:'deleted-job',company:'Fictiónal Incorporated',title:'Engineer',url:url('old-tenant'),protection:'excluded'});
  insert(db,'company_application_activity',{job_id:'deleted-activity',user_id:'u',applicant_id:'a',company:'Old activity label',company_keys:JSON.stringify(['lever:activity']),normalized_url:url('activity'),reserved_at:earlier,started_at:earlier});
  insert(db,'external_application_history',{id:'external',user_id:'u',company:'Outside Corp',title:'Support',company_key:companyKey('Outside Corp'),title_key:historyKey('Support'),status:'interview',source:'synthetic',imported_at:earlier,updated_at:at});
  insert(db,'preparation_handoff_reservations',{user_id:'u',request_id:'native-reserve',reservation_id:'r',identity_json:JSON.stringify(reserved),created_at:at});
  insert(db,'preparation_handoff_snapshots',{user_id:'u',revision:7,generated_at:at,protection_digest:'a'.repeat(64)});
 });const {raw,db}=await target(t);await run(raw,s);
 for(const input of [{company:'Fictional LLC',title:'Engineer \u2014 Remote',url:url('elsewhere',20)},{company:'Renamed',title:'Different',url:url('activity').replace('jobs.lever.co','jobs.eu.lever.co')},{company:'Outside',title:'Support',url:url('outside',21)},{company:'New label',title:'Different',url:reserved.url}])await assert.rejects(claimCandidate(db,candidate(input)),/application_already_protected/,JSON.stringify(input));
 assert.equal((await claimCandidate(db,candidate({userId:'other',company:'Fictional',title:'Engineer',url:url('old-tenant')}))).fresh,true);
 const oracleDB=new DatabaseSync(s.databasePath);register(oracleDB);const native=nativeLedger(oracleDB,'u',{at});oracleDB.close();assert.equal(native.records.length,4);assert.equal(Number((await raw.execute("SELECT count(*) n FROM guard_protections WHERE user_id='u'")).rows[0].n),4);
});

test('security/quota aliases retain applicant scope; expired evidence never releases an existing unknown hold',async t=>{
 const s=source(db=>{
  insert(db,'employer_security_holds',{user_id:'u',applicant_id:'a',employer_key:'lever:security-tenant',company:'Security Display',job_id:'deleted',observed_at:earlier,message:'Synthetic security rejection',source:'synthetic'});
  insert(db,'employer_limits',{user_id:'u',applicant_id:'a',employer_key:'lever:quota-tenant',company:'Quota Display',observed_at:earlier,hold_until:null,limit_count:2,window_days:30,message:'Synthetic explicit quota',source:'synthetic',reached_at:earlier,reported_until:null});
  insert(db,'employer_limits',{user_id:'u',applicant_id:'a',employer_key:'company:expired',company:'Expired',observed_at:earlier,hold_until:'2025-01-01T00:00:00.000Z',limit_count:null,window_days:null,message:'Synthetic expired evidence',source:'synthetic',reached_at:null,reported_until:null});
 });const {raw,db}=await target(t);await raw.execute("INSERT INTO guard_identities VALUES('unknown','u','Expired','Employer hold',NULL)");await raw.execute("INSERT INTO guard_holds VALUES('unknown','u','unknown','a','security')");await run(raw,s);
 for(const tenant of ['security-tenant','quota-tenant'])await assert.rejects(claimCandidate(db,candidate({url:url(tenant,80)})),/employer_hold/);
 await assert.rejects(claimCandidate(db,candidate({company:'Quota Display',url:url('new-tenant',81)})),/employer_hold/);
 await assert.rejects(claimCandidate(db,candidate({company:'Expired',url:url('expired',82)})),/employer_hold/);
 assert.equal((await claimCandidate(db,candidate({applicantId:'a2',url:url('security-tenant',83)}))).fresh,true);
 assert.equal((await claimCandidate(db,candidate({userId:'other',applicantId:'other-a',url:url('security-tenant',84)}))).fresh,true);
 const expired=(await raw.execute("SELECT plan_json FROM guard_history_rows WHERE source_table='employer_limits' AND raw_json LIKE '%Synthetic expired evidence%'")).rows[0];assert.equal(JSON.parse(expired.plan_json).hold_decision.active,false);assert.equal(await count(raw,'guard_holds'),5);
});

test('rolling quota projection agrees with native oracle including uncertain, pending, reported and expired states',async t=>{
 const s=source(db=>{
  for(let n=1;n<=3;n++){job(db,'quota-'+n,{company:'Quota',url:url('quota',n),status:'submitted',confirmation:n===3?'Your application is pending.':'Your application has been received.'});event(db,'quota-'+n,'submitted',n===1?'2026-10-10T12:00:00.000Z':earlier);}
  for(const [tenant,count,days,reached,reported] of [['quota',2,30,null,null],['policy-only',2,30,null,null],['expired',2,1,earlier,earlier],['reported',2,30,earlier,null]])insert(db,'employer_limits',{user_id:'u',applicant_id:'a',employer_key:'lever:'+tenant,company:tenant,observed_at:earlier,hold_until:null,limit_count:count,window_days:days,message:'Synthetic quota',source:'synthetic',reached_at:reached,reported_until:reported});
 });const oraclePath=join(root,'quota-oracle.sqlite');copyFileSync(s.databasePath,oraclePath);const oracleDB=new DatabaseSync(oraclePath);register(oracleDB);const oracle=employerQuotas(oracleDB,'u',at);oracleDB.close();const {raw}=await target(t);await run(raw,s);
 for(const row of (await raw.execute("SELECT raw_json,plan_json FROM guard_history_rows WHERE source_table='employer_limits'")).rows){const original=JSON.parse(row.raw_json),plan=JSON.parse(row.plan_json),expected=oracle.find(r=>r.employer_key===original.employer_key);assert.equal(plan.hold_decision.hold_until,expected.hold_until);assert.equal(plan.hold_decision.basis,expected.basis);assert.equal(plan.hold_decision.active,expected.hold_until===null||expected.hold_until>at);}
});

test('interrupted batch rolls back its evidence/projection and retains a persistent claim/check/export hold until verified retry',async t=>{
 const s=source(db=>{for(let n=1;n<=5;n++)job(db,'j'+n,{status:'paused'});});const {raw,db}=await target(t);
 await raw.executeMultiple("CREATE TRIGGER synthetic_fail BEFORE INSERT ON guard_protections WHEN (SELECT company FROM guard_identities WHERE id=NEW.identity_id)='Fictional j3' BEGIN SELECT RAISE(ABORT,'synthetic_interrupt');END;");
 await assert.rejects(run(raw,s,{batchSize:2}),/synthetic_interrupt/);await pending(raw);
 assert.equal(Number((await raw.execute("SELECT count(*) n FROM guard_history_rows WHERE source_table='jobs'")).rows[0].n),2);
 await assert.rejects(claimCandidate(db,candidate()),/history_import_incomplete|native_history_import_pending/);
 await assert.rejects(exportPreparationLedger(db,'u'),/history_import_incomplete|native_history_import_pending/);
 await assert.rejects(raw.execute("INSERT INTO guard_preparation_checks(user_id) VALUES('u')"),/history_import_incomplete/);
 await raw.execute('DROP TRIGGER synthetic_fail');await run(raw,s,{batchSize:2});assert.equal(Number((await status(raw)).pending),0);assert.equal(Number((await raw.execute("SELECT count(*) n FROM guard_history_rows WHERE source_table='jobs'")).rows[0].n),5);
});

for(const final of [false,true])test(`lost ${final?'completion':'batch'} commit response reconciles from durable immutable rows without duplication`,async t=>{
 const s=source(db=>job(db,'j',{status:'paused'})),{raw}=await target(t);let fault=true;
 const client=wrap(raw,null,async(tx,sql)=>{await tx.commit();if(fault&&sql.some(s=>s.startsWith(final?'INSERT INTO guard_history_completions':'INSERT INTO guard_history_rows'))){fault=false;throw Error('synthetic_lost_response');}});
 await assert.rejects(run(client,s),/history_import_commit_uncertain/);if(!final)await pending(raw);else assert.equal(Number((await status(raw)).completed),1);
 const result=await run(raw,s);assert.equal(result.replayed,final);assert.equal(Number((await status(raw)).completed),1);assert.equal(await count(raw,'guard_preparation_external_events'),2);
});

test('rolled-back finalization restores the completion-deny trigger and leaves the hold; retry completes safely',async t=>{
 const s=source(),{raw}=await target(t);const client=wrap(raw,null,async(tx,sql)=>{if(sql.some(s=>s.startsWith('INSERT INTO guard_history_completions'))){await tx.rollback();throw Error('synthetic_rollback');}await tx.commit();});
 await assert.rejects(run(client,s),/history_import_commit_uncertain/);await pending(raw);await assert.rejects(raw.execute("INSERT INTO guard_history_completions SELECT import_id,user_id,created_at FROM guard_history_imports"),/history_completion_requires_verified_installer/);await run(raw,s);assert.equal(Number((await status(raw)).completed),1);
});

test('ordinary DML cannot forge completion or rewrite imported raw/outcome state, including REPLACE with recursive triggers OFF',async t=>{
 const s=source(db=>job(db,'j',{status:'offer'})),{raw}=await target(t);await run(raw,s);await raw.execute('PRAGMA recursive_triggers=OFF');
 for(const table of ['guard_history_imports','guard_history_inventory','guard_history_rows','guard_history_states','guard_history_applied','guard_history_completions']){
  await assert.rejects(raw.execute('DELETE FROM '+table),/immutable_history_import/);
  const columns=(await raw.execute('PRAGMA table_info('+table+')')).rows,first=columns[0].name;
  await assert.rejects(raw.execute(`UPDATE ${table} SET ${first}=${first}`),/immutable_history_import/);
  await assert.rejects(raw.execute(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`),/immutable_history_import|history_completion_requires_verified_installer|history_import_already_complete/);
 }
});

test('changed source and changed manifest fail closed; no imported status is inferred from no pending session',async t=>{
 const s=source(),{raw}=await target(t);assert.equal(Number((await status(raw)).completed),0);assert.equal((await status(raw)).source_snapshot_sha,null);
 const bytes=readFileSync(s.databasePath);writeFileSync(s.databasePath,Buffer.concat([bytes,Buffer.from('changed')]));await assert.rejects(run(raw,s),/history_snapshot_changed/);await pending(raw);writeFileSync(s.databasePath,bytes);
 await assert.rejects(run(raw,{...s,manifest:{...s.manifest,created_at:earlier}}),/history_import_identity_conflict/);await pending(raw);await run(raw,s);
});

for(const [name,mutate,pattern] of [
 ['missing table',db=>db.exec('DROP TABLE employer_receipts'),/history_required_table_missing/],
 ['missing column',db=>db.exec('ALTER TABLE employer_receipts DROP COLUMN receipt_id'),/history_required_column_missing/],
 ['orphan attempt',db=>insert(db,'autonomous_attempts',{job_id:'missing',owner:'browser',created_at:at}),/history_source_reference_missing_or_cross_account/],
 ['cross-account activity',db=>{job(db,'other-job',{user_id:'other',applicant_id:'other-a'});insert(db,'company_application_activity',{job_id:'other-job',user_id:'u',applicant_id:'a',company:'Wrong',company_keys:'["company:wrong"]',normalized_url:url('wrong'),reserved_at:at,started_at:null});},/history_source_reference_missing_or_cross_account/],
 ['cross-account security hold',db=>{job(db,'other-job',{user_id:'other',applicant_id:'other-a'});insert(db,'employer_security_holds',{user_id:'u',applicant_id:'a',employer_key:'lever:wrong',company:'Wrong',job_id:'other-job',observed_at:at,message:'Synthetic',source:'synthetic'});},/history_source_reference_missing_or_cross_account/],
 ['malformed expired hold',db=>insert(db,'employer_limits',{user_id:'u',applicant_id:'a',employer_key:'company:expired',company:'Expired',observed_at:at,hold_until:'!not-a-time',limit_count:null,window_days:null,message:'Synthetic',source:'synthetic',reached_at:null,reported_until:null}),/history_invalid_time/],
 ['offset active hold which would appear lexically expired',db=>insert(db,'employer_limits',{user_id:'u',applicant_id:'a',employer_key:'company:active',company:'Active',observed_at:at,hold_until:'2026-10-13T11:00:00.000-03:00',limit_count:null,window_days:null,message:'Synthetic',source:'synthetic',reached_at:null,reported_until:null}),/history_invalid_time/],
 ['offset reported refusal which would appear lexically expired',db=>insert(db,'employer_limits',{user_id:'u',applicant_id:'a',employer_key:'company:active',company:'Active',observed_at:at,hold_until:null,limit_count:2,window_days:30,message:'Synthetic',source:'synthetic',reached_at:earlier,reported_until:'2026-10-13T11:00:00.000-03:00'}),/history_invalid_time/],
 ['malformed identity',db=>insert(db,'preparation_handoff_protections',{user_id:'u',job_id:'bad',company:'',title:'Engineer',url:url('bad'),protection:'uncertain'}),/invalid_identity|invalid_text|history_unsupported/],
 ['unsupported URL',db=>job(db,'unsupported',{url:url('unsupported')+'?requisition=42',status:'paused'}),/history_unsupported_protected_identity/],
 ['unattributable receipt owner',db=>{job(db,'bad-receipt',{status:'submitted',local_owner:'browser',local_attempt_at:earlier});event(db,'bad-receipt','submitted');insert(db,'employer_receipts',{job_id:'bad-receipt',user_id:'u',owner:'other-owner',application_url:url('bad-receipt'),receipt_url:url('bad-receipt'),attempt_at:earlier,receipt_text:'Your application has been received.',observed_at:at,synced_at:at,receipt_id:null});},/history_unattributable_native_receipt/],
 ['hosted receipt with conflicting browser ownership',db=>{job(db,'bad-hosted',{status:'submitted',local_owner:'browser',local_attempt_at:earlier});insert(db,'autonomous_attempts',{job_id:'bad-hosted',owner:'hosted-worker',created_at:earlier});event(db,'bad-hosted','submitted');insert(db,'employer_receipts',{job_id:'bad-hosted',user_id:'u',owner:'hosted-worker',application_url:url('bad-hosted'),receipt_url:url('bad-hosted'),attempt_at:earlier,receipt_text:'Your application has been received.',observed_at:at,synced_at:at,receipt_id:null});},/history_unattributable_native_receipt/],
])test(name+' prevents verified completion and keeps the import hold',async t=>{const s=source(mutate),{raw}=await target(t);await assert.rejects(run(raw,s),pattern);await pending(raw);});

test('target row poisoning and fake applied markers cannot pass installer verification',async t=>{
 const s=source(),{raw}=await target(t);let fault=true;
 const client=wrap(raw,async(input)=>{if(fault&&input.sql?.startsWith('INSERT INTO guard_history_rows')){fault=false;throw Error('synthetic_interrupt');}});await assert.rejects(run(client,s),/synthetic_interrupt/);await pending(raw);
 const session=(await raw.execute('SELECT import_id FROM guard_history_imports')).rows[0].import_id;
 await raw.execute({sql:"INSERT INTO guard_history_rows VALUES(?,'users','[\"u\"]',1,'{}',?,'{}')",args:[session,'0'.repeat(64)]});await raw.execute({sql:"INSERT INTO guard_history_applied VALUES(?,'users','[\"u\"]')",args:[session]});
 await assert.rejects(run(raw,s),/history_row_conflict/);await pending(raw);await assert.rejects(raw.execute("INSERT INTO guard_history_completions SELECT import_id,user_id,created_at FROM guard_history_imports"),/history_completion_requires_verified_installer/);
});

test('source file mutation after pinned verification cannot produce a completed projection',async t=>{
 const s=source(db=>job(db,'j',{status:'paused'})),{raw}=await target(t);let mutated=false;
 const client=wrap(raw,null,async(tx,sql)=>{await tx.commit();if(!mutated&&sql.some(s=>s.startsWith('INSERT INTO guard_history_rows'))){mutated=true;const fdBytes=readFileSync(s.databasePath);writeFileSync(s.databasePath,Buffer.concat([fdBytes,Buffer.from('changed-after-read-snapshot')]));}});
 await assert.rejects(run(client,s),/history_source_changed_during_import/);await pending(raw);assert.equal(await count(raw,'guard_history_completions'),0);
});

test('one pinned source transaction supplies verification and all rows while a concurrent WAL write remains unaccepted',async t=>{
 const s=source(db=>{job(db,'original',{status:'paused'});db.exec('PRAGMA journal_mode=WAL');}),{raw}=await target(t);let writer,mutated=false;
 t.after(()=>writer?.close());
 const client=wrap(raw,null,async(tx,sql)=>{await tx.commit();if(!mutated&&sql.some(s=>s.startsWith('INSERT INTO guard_history_rows'))){mutated=true;writer=new DatabaseSync(s.databasePath);register(writer);writer.prepare("UPDATE jobs SET title='Changed outside snapshot' WHERE id='original'").run();}});
 await assert.rejects(run(client,s),/history_source_has_wal|history_source_changed_during_import/);await pending(raw);
 const copied=JSON.parse((await raw.execute("SELECT raw_json FROM guard_history_rows WHERE source_table='jobs'")).rows[0].raw_json);assert.equal(copied.title,'Engineer');assert.equal(writer.prepare("SELECT title FROM jobs WHERE id='original'").get().title,'Changed outside snapshot');
});

test('even an empty protected-history import advances the epoch twice and invalidates an earlier preparation snapshot',async t=>{
 const s=source(),{raw,db}=await target(t),before=await exportPreparationLedger(db,'u'),epoch=Number((await raw.execute("SELECT epoch FROM guard_preparation_epochs WHERE user_id='u'")).rows[0].epoch);
 await run(raw,s);assert.equal(await count(raw,'guard_protections'),0);assert.equal(await count(raw,'guard_holds'),0);assert.equal(Number((await raw.execute("SELECT epoch FROM guard_preparation_epochs WHERE user_id='u'")).rows[0].epoch),epoch+2);
 await assert.rejects(claimCandidate(db,candidate({requestId:'stale-empty-check',kind:'preparation',preparationSnapshot:before})),/snapshot_epoch_changed|snapshot_changed|stale_snapshot/);
 const after=await exportPreparationLedger(db,'u');
 assert.equal(before.native_history_imported,false);assert.equal(before.source_verified,false);assert.equal(after.native_history_imported,true);assert.equal(after.source_verified,true);assert.equal(after.source_snapshot_sha,s.manifest.database_sha256);assert.equal(after.history_import_scope,'protected_history_projection');
 assert.equal(after.submission_allowed,false);assert.equal(Number((await status(raw)).completed),1);
});

test('successive verified source snapshots retain every original outcome; replaying an older source cannot overwrite later evidence',async t=>{
 const seed=status=>db=>insert(db,'external_application_history',{id:'external',user_id:'u',company:'Outside',title:'Support',company_key:'outside',title_key:'support',status,source:'synthetic',imported_at:earlier,updated_at:at});
 const earlierSource=source(seed('applied')),laterSource=source(seed('interview')),{raw}=await target(t);await run(raw,earlierSource);await run(raw,laterSource);await run(raw,earlierSource);
 const outcomes=(await raw.execute("SELECT native_status FROM guard_history_states WHERE source_table='external_application_history' ORDER BY native_status")).rows.map(r=>r.native_status);assert.deepEqual(outcomes,['applied','interview']);assert.equal(Number((await status(raw)).completed),2);assert.equal(await count(raw,'guard_protections'),2);
});

test('manifest row inventory mismatch fails verification before projecting and leaves the persistent hold',async t=>{
 const s=source(db=>job(db,'j',{status:'paused'})),{raw}=await target(t);s.manifest.database.tables.jobs.rows++;
 await assert.rejects(run(raw,s),/history_snapshot_manifest_mismatch/);await pending(raw);assert.equal(await count(raw,'guard_history_rows'),0);
});

test('extra outcome rows cannot invent confirmed submissions or attribute another account raw evidence',async t=>{
 const s=source(db=>job(db,'uncertain',{status:'submitted',confirmation:null})),{raw}=await target(t);await run(raw,s);
 const original=(await raw.execute("SELECT * FROM guard_history_states WHERE source_table='jobs'")).rows[0];
 for(const change of [{record_id:'forged',confirmed:1n},{record_id:'forged-other',user_id:'other'},{record_id:'forged-status',native_status:'offer'}]){
  const row={...original,...change};await assert.rejects(raw.execute({sql:'INSERT INTO guard_history_states('+Object.keys(row).join(',')+') VALUES('+Object.keys(row).map(()=>'?').join(',')+')',args:Object.values(row)}),/history_state_plan_mismatch|history_import_already_complete/);
 }
 assert.equal(await count(raw,'guard_history_states'),1);assert.equal(Number(original.confirmed),0);
});

test('completed sessions reject all late inventory/evidence inserts, including new source tables with fabricated outcomes',async t=>{
 const s=source(),{raw}=await target(t),result=await run(raw,s);
 await assert.rejects(raw.execute({sql:"INSERT INTO guard_history_inventory VALUES(?,'forged-table','[]',1,?)",args:[result.import_id,'0'.repeat(64)]}),/history_import_already_complete/);
 await assert.rejects(raw.execute({sql:"INSERT INTO guard_history_rows VALUES(?,'users','[\"forged\"]',2,'{}',?,'{}')",args:[result.import_id,'0'.repeat(64)]}),/history_import_already_complete/);
 assert.equal(Number((await status(raw)).completed),1);assert.equal(Number((await status(raw)).pending),0);
});

test('page size is enforced while a larger synthetic source remains resumable',async t=>{
 const s=source(db=>{for(let n=0;n<111;n++)job(db,'page-'+String(n).padStart(3,'0'),{status:'paused'});}),{raw}=await target(t);let largest=0,batches=0;
 const client=wrap(raw,null,async(tx,sql)=>{const n=sql.filter(s=>s.startsWith('INSERT INTO guard_history_rows')).length;if(n){largest=Math.max(largest,n);batches++;}await tx.commit();});
 await run(client,s,{batchSize:7});assert.ok(batches>16);assert.equal(largest,7);await assert.rejects(run(raw,s,{batchSize:HISTORY_IMPORT_POLICY.maxBatchRows+1}),/history_invalid_batch_size/);
});
