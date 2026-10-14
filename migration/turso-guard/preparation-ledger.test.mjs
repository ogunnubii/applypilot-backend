import {importEmptyFixtureHistory} from './history-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createClient} from '@libsql/client';
import {createLibsqlDatabase} from '../../database/libsql.js';
import {UncertainCommitError} from '../../database/async-database.js';
import {installGuardSchema} from './guard-schema.mjs';
import {claimCandidate,reconcileClaim} from './guard-repository.mjs';
import {PREPARATION_SCHEMA_SQL,exportPreparationLedger,reservePreparation} from './preparation-ledger.mjs';
import {handoffIdentity,installPreparationHandoff,exportPreparationLedger as nativeExport,reservePreparation as nativeReserve} from '../../preparation-handoff.js';
import {installEmployerLimits} from '../../employer-limits.js';
import {installCompanyApplicationPolicy} from '../../company-application-policy.js';

const identity=(id='1234',employer='Example Labs',title='Platform Engineer')=>({url:`https://job-boards.greenhouse.io/example/jobs/${id}`,employer,title,location:'Canada'});
const request=(revision,id='request_example_0001',job=identity())=>({schema_version:2,request_id:id,expected_revision:revision,identity:job});
const context={owner:'synthetic-owner',applicantId:'synthetic-applicant'};
async function fixture(t,{file=false}={}){
 let url=':memory:';
 if(file){
  const root=process.env.APPLYPILOT_ASYNC_TEST_ROOT,inside=root&&relative(resolve(tmpdir()),resolve(root));
  if(!inside||inside.startsWith('..'))throw Error('Run via checks/run-async-tests.mjs');
  url=pathToFileURL(join(mkdtempSync(join(root,'preparation-ledger-')),'fixture.sqlite')).href;
 }
 const raw=createClient({url,intMode:'bigint'});
 await raw.executeMultiple('PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA busy_timeout=0;PRAGMA recursive_triggers=OFF;');
 await installGuardSchema(raw);
 if(!(await raw.execute("SELECT 1 FROM sqlite_master WHERE name='guard_preparation_snapshots'")).rows.length)await raw.executeMultiple(PREPARATION_SCHEMA_SQL);
 await raw.execute("INSERT INTO guard_accounts VALUES('u',0)");await importEmptyFixtureHistory(raw);
 const db=createLibsqlDatabase(raw);t.after(()=>db.close());return {db,raw,url};
}
async function count(raw,table){return Number((await raw.execute('SELECT count(*) AS n FROM '+table)).rows[0].n);}
async function protect(raw,{id='old',user='u',job=identity(),kind='uncertain'}={}){
 await raw.execute({sql:'INSERT INTO guard_identities VALUES(?,?,?,?,?)',args:[id,user,job.employer,job.title,job.url]});
 await raw.execute({sql:'INSERT INTO guard_protections VALUES(?,?,?,?,?)',args:[id,user,id,kind,'synthetic-import']});
}
async function hold(raw,{id='hold',job=identity(),applicant='different-owner-profile',reason='security'}={}){
 await raw.execute({sql:'INSERT INTO guard_identities VALUES(?,?,?,?,?)',args:[id,'u',job.employer,job.title,job.url]});
 await raw.execute({sql:'INSERT INTO guard_holds VALUES(?,?,?,?,?)',args:[id,'u',id,applicant,reason]});
}

test('complete isolated export retains every guard protection and hold, isolates users and advances immutable revisions',async t=>{
 const {db,raw}=await fixture(t);
 await protect(raw,{id:'excluded',kind:'excluded'});
 await protect(raw,{id:'history',job:{...identity('2345','History Employer','Other Role'),url:null}});
 await protect(raw,{id:'reservation',kind:'reserved',job:identity('3456','Reservation Employer','Another Role')});
 await hold(raw);
 await raw.execute("INSERT INTO guard_accounts VALUES('foreign',0)");
 await protect(raw,{id:'foreign',user:'foreign',job:identity('5678','Foreign Employer','Private')});
 const value=await exportPreparationLedger(db,'u');
 assert.equal(value.records.length,3);assert.equal(value.employer_holds.length,1);assert.equal(value.complete,true);assert.equal(value.submission_allowed,false);
 assert.equal(value.native_history_imported,true);assert.equal(value.isolated_model,true);assert.equal(value.account_stopped,false);
 assert.equal(value.source_verified,true);assert.match(value.source_snapshot_sha,/^[a-f0-9]{64}$/);
 assert.equal(value.records.find(row=>row.record_id==='guard:history').identity.url,null);
 assert.doesNotMatch(JSON.stringify(value),/Foreign Employer|different-owner-profile|synthetic-import/);
 assert.match(value.protection_digest,/^[a-f0-9]{64}$/);
 const second=await exportPreparationLedger(db,'u');assert.equal(second.revision,2);assert.equal(second.protection_digest,value.protection_digest);
 assert.equal(await count(raw,'guard_preparation_snapshots'),2);
});

test('canonical requests reserve atomically; replay always requires a fresh snapshot and never grants submission',async t=>{
 const {db,raw}=await fixture(t),s=await exportPreparationLedger(db,'u');
 const canonical=identity(),alias={...canonical,url:'https://boards.greenhouse.io/example/jobs/1234/?utm_source=fixture#form'};
 const first=await reservePreparation(db,'u',request(s.revision,undefined,alias),context);
 assert.equal(first.decision,'reserved');assert.equal(first.fresh,true);assert.equal(first.submission_allowed,false);assert.deepEqual(first.identity,{...canonical,ats:'greenhouse',tenant:'example',requisition_id:'1234',employer_aliases:['example','examplelabs']});
 assert.equal(await count(raw,'guard_claims'),1);assert.equal(await count(raw,'guard_protections'),1);assert.equal(await count(raw,'guard_events'),1);assert.equal(await count(raw,'guard_intents'),0);
 await assert.rejects(reservePreparation(db,'u',request(s.revision),context),/snapshot_changed/);
 const fresh=await exportPreparationLedger(db,'u');
 const again=await reservePreparation(db,'u',request(fresh.revision),context);
 assert.equal(again.decision,'rechecked');assert.equal(again.fresh,false);assert.equal(again.submission_allowed,false);assert.equal(again.reservation_id,first.reservation_id);
 await assert.rejects(reservePreparation(db,'u',request(fresh.revision,undefined,identity('8888')),context),/request_identity_conflict/);
 await assert.rejects(reservePreparation(db,'u',request(fresh.revision),{...context,owner:'different'}),/request_identity_conflict/);
 await assert.rejects(reservePreparation(db,'u',request(fresh.revision),{...context,applicantId:'different'}),/request_identity_conflict/);
 await assert.rejects(claimCandidate(db,{userId:'u',requestId:'native-race',owner:'other',applicantId:'other',company:canonical.employer,title:canonical.title,url:canonical.url,kind:'submission'}),/application_already_protected/);
});

test('five-minute age, nonfuture time, revision and current digest are checked even for replay',async t=>{
 const {db,raw}=await fixture(t),at=new Date().toISOString();
 await assert.rejects(reservePreparation(db,'u',request(1),{...context,at}),/fresh_snapshot_required/);
 const s=await exportPreparationLedger(db,'u',{at});
 await assert.rejects(reservePreparation(db,'u',request(s.revision),{...context,at:new Date(Date.parse(at)-1).toISOString()}),/fresh_snapshot_required/);
 await assert.rejects(reservePreparation(db,'u',request(s.revision),{...context,at:new Date(Date.parse(at)+300001).toISOString()}),/fresh_snapshot_required/);
 await assert.rejects(reservePreparation(db,'u',request(s.revision+1),{...context,at}),/snapshot_changed/);
 await assert.rejects(exportPreparationLedger(db,'u',{at:'not-a-date'}),/invalid_check_time/);
 await protect(raw);
 await assert.rejects(reservePreparation(db,'u',request(s.revision),{...context,at}),/snapshot_changed/);
 const fresh=await exportPreparationLedger(db,'u',{at});
 const blocked=await reservePreparation(db,'u',request(fresh.revision),{...context,at:new Date(Date.parse(at)+300000).toISOString()});
 assert.equal(blocked.decision,'blocked');assert.equal(blocked.reason_code,'protected_application');assert.equal(blocked.submission_allowed,false);
});

test('stopped account invalidates the snapshot and blocks new reservations after refresh',async t=>{
 const {db,raw}=await fixture(t),s=await exportPreparationLedger(db,'u');
 await raw.execute("UPDATE guard_accounts SET stopped=1 WHERE user_id='u'");
 await assert.rejects(reservePreparation(db,'u',request(s.revision),context),/snapshot_changed/);
 const fresh=await exportPreparationLedger(db,'u'),blocked=await reservePreparation(db,'u',request(fresh.revision),context);
 assert.equal(fresh.account_stopped,true);assert.equal(blocked.reason_code,'account_stopped');assert.equal(blocked.fresh,false);assert.equal(blocked.submission_allowed,false);
 assert.equal(await count(raw,'guard_claims'),0);
});

test('employer holds from another applicant apply account-wide and recheck an existing reservation',async t=>{
 const {db,raw}=await fixture(t),s=await exportPreparationLedger(db,'u');
 const first=await reservePreparation(db,'u',request(s.revision),context);
 await hold(raw,{job:identity('8888','Different Display Name','Different Role')});
 const fresh=await exportPreparationLedger(db,'u'),again=await reservePreparation(db,'u',request(fresh.revision),context);
 assert.equal(again.reason_code,'employer_hold');assert.equal(again.reservation_id,first.reservation_id);assert.equal(again.fresh,false);assert.equal(again.submission_allowed,false);
 const safe={...identity('4444','Unrelated Employer','Different Role'),url:'https://job-boards.greenhouse.io/unrelated/jobs/4444'};
 assert.equal((await reservePreparation(db,'u',request(fresh.revision,'another_request_0001',safe),context)).decision,'reserved');
});

test('invalid protected identities and excessive projection counts fail the whole export',async t=>{
 const {db,raw}=await fixture(t);
 await protect(raw,{job:{...identity(),url:identity().url+'?access_token=fictional'}});
 await assert.rejects(exportPreparationLedger(db,'u'),/invalid_protected_identity/);assert.equal(await count(raw,'guard_preparation_snapshots'),0);
 const many=await fixture(t);
 await many.raw.execute({sql:'INSERT INTO guard_identities VALUES(?,?,?,?,?)',args:['bulk','u','Example','Engineer',null]});
 await many.raw.execute("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20001) INSERT INTO guard_protections SELECT 'bulk:'||x,'u','bulk','uncertain','synthetic' FROM n");
 await assert.rejects(exportPreparationLedger(many.db,'u'),/incomplete_projection/);assert.equal(await count(many.raw,'guard_preparation_snapshots'),0);
});

test('projection byte limit fails closed before any snapshot is recorded',async t=>{
 const {db,raw}=await fixture(t);
 await raw.execute({sql:'INSERT INTO guard_identities VALUES(?,?,?,?,?)',args:['large','u','Example','Engineer','https://example.test/'+'x'.repeat(2800)]});
 await raw.execute("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4000) INSERT INTO guard_protections SELECT 'large:'||x,'u','large','uncertain','synthetic' FROM n");
 await assert.rejects(exportPreparationLedger(db,'u'),/incomplete_projection/);assert.equal(await count(raw,'guard_preparation_snapshots'),0);
});

test('projection bounds raw IDs and invalid identity payloads before returning them, and excludes irrelevant metadata',async t=>{
 const huge='x'.repeat(1024*1024),{db,raw}=await fixture(t);
 await raw.execute({sql:'INSERT INTO guard_identities VALUES(?,?,?,?,?)',args:['bounded','u','Example','Engineer',null]});
 await raw.execute({sql:'INSERT INTO guard_protections VALUES(?,?,?,?,?)',args:['bounded','u','bounded','uncertain',huge]});
 await raw.execute({sql:'INSERT INTO guard_holds VALUES(?,?,?,?,?)',args:['held','u','bounded',huge,'security']});
 const exported=await exportPreparationLedger(db,'u');
 assert.equal(exported.records.length,1);assert.equal(exported.employer_holds.length,1);assert(JSON.stringify(exported).length<5000);
 const invalidId=await fixture(t);
 await protect(invalidId.raw,{id:huge});
 await assert.rejects(exportPreparationLedger(invalidId.db,'u'),/invalid_projection_record/);assert.equal(await count(invalidId.raw,'guard_preparation_snapshots'),0);
 const invalidIdentity=await fixture(t);
 await protect(invalidIdentity.raw,{job:{...identity(),url:'https://example.test/'+huge}});
 await assert.rejects(exportPreparationLedger(invalidIdentity.db,'u'),/invalid_protected_identity/);assert.equal(await count(invalidIdentity.raw,'guard_preparation_snapshots'),0);
});

test('snapshot and reservation raw UPDATE, DELETE, REPLACE and upsert cannot weaken retained history',async t=>{
 const {db,raw}=await fixture(t),s=await exportPreparationLedger(db,'u');
 await reservePreparation(db,'u',request(s.revision),context);
 for(const table of ['guard_preparation_snapshots','guard_preparation_reservations']){
  await assert.rejects(raw.execute('DELETE FROM '+table),/immutable_preparation_record/);
  await assert.rejects(raw.execute('UPDATE '+table+' SET user_id=user_id'),/immutable_preparation_record/);
  await assert.rejects(raw.execute('INSERT OR REPLACE INTO '+table+' SELECT * FROM '+table),/immutable_preparation_record|invalid_snapshot_revision/);
  await assert.rejects(raw.execute('INSERT INTO '+table+' SELECT * FROM '+table+' WHERE 1 ON CONFLICT DO UPDATE SET user_id=excluded.user_id'),/immutable_preparation_record|invalid_snapshot_revision/);
 }
 assert.equal(await count(raw,'guard_preparation_reservations'),1);
});

test('reservation metadata failure rolls back the new claim, identity, protection and event together',async t=>{
 const {db,raw}=await fixture(t),s=await exportPreparationLedger(db,'u');
 await raw.execute("CREATE TRIGGER synthetic_reservation_failure BEFORE INSERT ON guard_preparation_reservations BEGIN SELECT RAISE(ABORT,'synthetic_reservation_failure'); END");
 await assert.rejects(reservePreparation(db,'u',request(s.revision),context),/synthetic_reservation_failure/);
 for(const table of ['guard_claims','guard_protections','guard_events','guard_identities','guard_preparation_reservations','guard_preparation_checks'])assert.equal(await count(raw,table),0);
});

test('independent clients sharing a snapshot produce one winner; loser cannot reuse stale revision',async t=>{
 const {db,raw,url}=await fixture(t,{file:true}),otherRaw=createClient({url,intMode:'bigint'});
 await otherRaw.executeMultiple('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=0;');
 const other=createLibsqlDatabase(otherRaw);t.after(()=>other.close());
 const s=await exportPreparationLedger(db,'u');
 const results=await Promise.allSettled([reservePreparation(db,'u',request(s.revision,'parallel_request_0001'),context),reservePreparation(other,'u',request(s.revision,'parallel_request_0002'),context)]);
 assert.equal(results.filter(row=>row.status==='fulfilled'&&row.value.decision==='reserved').length,1);
 assert.equal(results.filter(row=>row.status==='rejected').length,1);assert.equal(await count(raw,'guard_preparation_reservations'),1);
 await assert.rejects(reservePreparation(other,'u',request(s.revision,'parallel_request_0003'),context),/snapshot_changed/);
});

test('lost committed response never replays as fresh; reconciliation still requires a current projection',async t=>{
 const {db,raw}=await fixture(t),s=await exportPreparationLedger(db,'u');let armed=true;
 const fault=createLibsqlDatabase({close(){},async transaction(mode){const tx=await raw.transaction(mode);return {execute:value=>tx.execute(value),rollback:()=>tx.rollback(),close:()=>tx.close(),async commit(){await tx.commit();if(armed&&mode==='write'){armed=false;throw Error('synthetic_lost_commit_response');}}};}});
 t.after(()=>fault.close());
 await assert.rejects(reservePreparation(fault,'u',request(s.revision),context),UncertainCommitError);
 assert.equal(await count(raw,'guard_preparation_reservations'),1);
 await assert.rejects(reservePreparation(db,'u',request(s.revision),context),/snapshot_changed/);
 const fresh=await exportPreparationLedger(db,'u'),again=await reservePreparation(db,'u',request(fresh.revision),context);
 assert.equal(again.decision,'rechecked');assert.equal(again.fresh,false);assert.equal(again.submission_allowed,false);
 assert.equal(await count(raw,'guard_events'),1);
});

function nativeFixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,title TEXT,company TEXT,url TEXT,normalized_url TEXT,status TEXT DEFAULT 'saved',attempts INTEGER DEFAULT 0,local_attempt_at TEXT,confirmation TEXT,local_phase TEXT DEFAULT 'ready',notes TEXT DEFAULT '',challenge TEXT,created_at TEXT DEFAULT 'synthetic',updated_at TEXT DEFAULT 'synthetic');
 CREATE TABLE events(id INTEGER PRIMARY KEY,job_id TEXT,at TEXT,type TEXT,message TEXT);
 CREATE TABLE external_application_history(id TEXT,user_id TEXT,company TEXT,title TEXT,notes TEXT);`);
 installEmployerLimits(db);installCompanyApplicationPolicy(db);installPreparationHandoff(db);return db;
}

// Raw writers must satisfy the same SQL proof obligations with recursive
// triggers disabled. These helpers intentionally do not call the repository.
async function rawCandidate(raw,{id='raw-candidate',job=identity()}={}){
 const canonical=handoffIdentity(job,{candidate:true});
 await raw.execute({sql:'INSERT INTO guard_identities VALUES(?,?,?,?,?)',args:[id,'u',canonical.employer,canonical.title,canonical.url]});
 return {id,canonical};
}
function rawCheckArgs(snapshot,candidate,overrides={}){
 return Object.values({check_id:'raw-check',user_id:'u',request_id:'raw_request_00001',claim_id:'raw-claim',identity_id:candidate.id,applicant_id:context.applicantId,owner:context.owner,identity_json:JSON.stringify(candidate.canonical),snapshot_revision:snapshot.revision,protection_digest:snapshot.protection_digest,projection_epoch:snapshot.projection_epoch,checked_at:new Date().toISOString(),...overrides});
}
const insertCheck=(raw,args)=>raw.execute({sql:'INSERT INTO guard_preparation_checks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',args});
const rawClaimArgs=q=>[q[3],q[1],q[2],q[4],q[5],q[6],'preparation',q[11]];
const insertClaim=(raw,args,verb='INSERT')=>raw.execute({sql:verb+' INTO guard_claims VALUES(?,?,?,?,?,?,?,?)',args});
const beginSyntheticImport=(raw,user='u')=>raw.execute({sql:'INSERT INTO guard_history_imports VALUES(?,?,?,?,?,?)',args:['pending-'+user,user,'1'.repeat(64),'2'.repeat(64),new Date().toISOString(),new Date().toISOString()]});

test('pending import blocks raw preparation checks, claims, and snapshots including a once-valid check',async t=>{
 const {db,raw}=await fixture(t),s=await exportPreparationLedger(db,'u'),candidate=await rawCandidate(raw),q=rawCheckArgs(s,candidate);
 await insertCheck(raw,q);await beginSyntheticImport(raw);
 assert.equal(Number((await raw.execute("SELECT epoch FROM guard_preparation_epochs WHERE user_id='u'")).rows[0].epoch),s.projection_epoch+1);
 await assert.rejects(insertClaim(raw,rawClaimArgs(q)),/history_import_incomplete/);
 await assert.rejects(insertCheck(raw,rawCheckArgs(s,candidate,{check_id:'after-import'})),/history_import_incomplete/);
 await assert.rejects(raw.execute({sql:'INSERT INTO guard_preparation_snapshots VALUES(?,?,?,?,?)',args:['u',s.revision+1,new Date().toISOString(),'0'.repeat(64),s.projection_epoch+1]}),/history_import_incomplete/);
 const submission=rawClaimArgs(q);submission[6]='submission';
 await assert.rejects(insertClaim(raw,submission),/history_import_incomplete/);
 await assert.rejects(exportPreparationLedger(db,'u'),/history_import_incomplete/);
 await assert.rejects(reservePreparation(db,'u',request(s.revision),context),/history_import_incomplete/);
 assert.equal(await count(raw,'guard_claims'),0);assert.equal(await count(raw,'guard_preparation_checks'),1);assert.equal(await count(raw,'guard_preparation_snapshots'),1);
});

test('pending import blocks every generic claim replay and reconciliation but remains account-scoped',async t=>{
 const {db,raw}=await fixture(t),job=identity(),prepInput={userId:'u',requestId:'import_prep_request_01',applicantId:context.applicantId,owner:context.owner,company:job.employer,title:job.title,url:job.url,kind:'preparation'};
 const submissionInput={...prepInput,requestId:'import_submit_request_01',company:'Different Company',title:'Different Role',url:'https://job-boards.greenhouse.io/different/jobs/5678',kind:'submission'};
 await claimCandidate(db,submissionInput);
 const s=await exportPreparationLedger(db,'u');await claimCandidate(db,{...prepInput,preparationSnapshot:s});
 await raw.execute("INSERT INTO guard_accounts VALUES('foreign',0)");await beginSyntheticImport(raw,'foreign');
 const fresh=await exportPreparationLedger(db,'u');assert.equal(fresh.native_history_imported,true);
 assert.equal((await claimCandidate(db,submissionInput)).fresh,false);
 await beginSyntheticImport(raw);
 await assert.rejects(claimCandidate(db,submissionInput),/history_import_incomplete/);
 await assert.rejects(claimCandidate(db,{...submissionInput,requestId:'new_submit_request_01'}),/history_import_incomplete/);
 await assert.rejects(claimCandidate(db,{...prepInput,preparationSnapshot:fresh}),/history_import_incomplete/);
 await assert.rejects(reconcileClaim(db,submissionInput),/history_import_incomplete/);
 await assert.rejects(reconcileClaim(db,{...prepInput,preparationSnapshot:fresh}),/history_import_incomplete/);
 await assert.rejects(reservePreparation(db,'u',request(fresh.revision,prepInput.requestId,{...job,location:'Unknown'}),context),/history_import_incomplete/);
 await assert.rejects(exportPreparationLedger(db,'u'),/history_import_incomplete/);
 assert.equal(await count(raw,'guard_claims'),2);
});

test('generic preparation claims require snapshot digest and current replay checks',async t=>{
 const {db,raw}=await fixture(t),job=identity(),input={userId:'u',requestId:'generic_request_0001',applicantId:context.applicantId,owner:context.owner,company:job.employer,title:job.title,url:job.url,kind:'preparation'};
 await assert.rejects(claimCandidate(db,input),/preparation_snapshot_required/);
 const s=await exportPreparationLedger(db,'u');
 await assert.rejects(claimCandidate(db,{...input,preparationSnapshot:{...s,protection_digest:'0'.repeat(64)}}),/snapshot_changed/);
 const first=await claimCandidate(db,{...input,preparationSnapshot:s});
 assert.equal(first.fresh,true);assert.equal(first.submission_allowed,false);
 await assert.rejects(claimCandidate(db,{...input,preparationSnapshot:s}),/snapshot_changed/);
 const fresh=await exportPreparationLedger(db,'u'),again=await claimCandidate(db,{...input,preparationSnapshot:fresh});
 assert.equal(again.fresh,false);assert.equal(again.claimId,first.claimId);assert.equal(again.submission_allowed,false);
 await raw.execute("UPDATE guard_accounts SET stopped=1 WHERE user_id='u'");
 await assert.rejects(claimCandidate(db,{...input,preparationSnapshot:fresh}),/snapshot_changed/);
 const stopped=await exportPreparationLedger(db,'u');
 await assert.rejects(claimCandidate(db,{...input,preparationSnapshot:stopped}),/account_stopped/);
 assert.equal(await count(raw,'guard_claims'),1);assert.equal(await count(raw,'guard_intents'),0);
});

test('preparation reconciliation requires a fresh snapshot and reports new holds without permission',async t=>{
 const {db,raw}=await fixture(t),s=await exportPreparationLedger(db,'u'),first=await reservePreparation(db,'u',request(s.revision),context);
 const input={userId:'u',requestId:request(1).request_id,owner:context.owner};
 await assert.rejects(reconcileClaim(db,input),/preparation_snapshot_required/);
 await assert.rejects(reconcileClaim(db,{...input,preparationSnapshot:s}),/snapshot_changed/);
 const fresh=await exportPreparationLedger(db,'u'),again=await reconcileClaim(db,{...input,preparationSnapshot:fresh});
 assert.equal(again.claimId,first.reservation_id);assert.equal(again.decision,'rechecked');assert.equal(again.fresh,false);assert.equal(again.submission_allowed,false);
 await hold(raw);
 await assert.rejects(reconcileClaim(db,{...input,preparationSnapshot:fresh}),/snapshot_changed/);
 const held=await exportPreparationLedger(db,'u'),blocked=await reconcileClaim(db,{...input,preparationSnapshot:held});
 assert.equal(blocked.decision,'blocked');assert.equal(blocked.reason_code,'employer_hold');assert.equal(blocked.fresh,false);assert.equal(blocked.submission_allowed,false);
});

test('raw INSERT, REPLACE and upsert cannot create a preparation claim without a snapshot check',async t=>{
 const {db,raw}=await fixture(t),s=await exportPreparationLedger(db,'u'),candidate=await rawCandidate(raw),q=rawCheckArgs(s,candidate),args=rawClaimArgs(q);
 for(const verb of ['INSERT','INSERT OR REPLACE'])await assert.rejects(insertClaim(raw,args,verb),/preparation_snapshot_required/);
 await assert.rejects(raw.execute({sql:'INSERT INTO guard_claims VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET owner=excluded.owner',args}),/preparation_snapshot_required/);
 assert.equal(await count(raw,'guard_claims'),0);
 await insertCheck(raw,q);
 for(const field of [0,1,2,3,4,5,7]){
  const changed=[...args];changed[field]=field===7?new Date(Date.parse(args[field])-1).toISOString():args[field]+'_changed';
  await assert.rejects(insertClaim(raw,changed),/preparation_snapshot_required|history_import_incomplete/);
 }
 await insertClaim(raw,args);
 assert.equal(await count(raw,'guard_preparation_reservations'),1);assert.equal(await count(raw,'guard_claims'),1);assert.equal(await count(raw,'guard_intents'),0);
 assert.equal((await raw.execute('SELECT identity_json FROM guard_preparation_reservations')).rows[0].identity_json,q[7]);
 for(const verb of ['INSERT','INSERT OR REPLACE'])await assert.rejects(insertClaim(raw,args,verb),/immutable_guard_record|preparation_snapshot_required|application_already_protected/);
});

test('raw snapshot time, revision and epoch and raw check bindings cannot be forged',async t=>{
 const {db,raw}=await fixture(t),s=await exportPreparationLedger(db,'u'),candidate=await rawCandidate(raw);
 const insertSnapshot=args=>raw.execute({sql:'INSERT INTO guard_preparation_snapshots VALUES(?,?,?,?,?)',args});
 await assert.rejects(insertSnapshot(['u',99,new Date().toISOString(),'0'.repeat(64),0]),/invalid_snapshot_revision/);
 await assert.rejects(insertSnapshot(['u',2,'2999-01-01T00:00:00.000Z','0'.repeat(64),0]),/future_snapshot_time/);
 await assert.rejects(insertSnapshot(['u',2,new Date().toISOString(),'0'.repeat(64),10]),/snapshot_epoch_changed/);
 for(const overrides of [
  {snapshot_revision:s.revision+1},{projection_epoch:s.projection_epoch+1},{protection_digest:'0'.repeat(64)},
  {checked_at:'2999-01-01T00:00:00.000Z'},{checked_at:'2000-01-01T00:00:00.000Z'},
  {request_id:'too-short'},{request_id:'invalid request_0001'},{owner:'bad\nowner'},
  {identity_json:JSON.stringify({...candidate.canonical,url:identity('9999').url})}
 ])await assert.rejects(insertCheck(raw,rawCheckArgs(s,candidate,overrides)),/preparation_snapshot_changed_or_stale|invalid_preparation_check_time|invalid_preparation_request|invalid_preparation_context|invalid_preparation_identity/);
 await insertSnapshot(['u',2,'2000-01-01T00:00:00.000Z','0'.repeat(64),s.projection_epoch]);
 await assert.rejects(insertCheck(raw,rawCheckArgs({...s,revision:2,protection_digest:'0'.repeat(64)},candidate)),/preparation_snapshot_changed_or_stale/);
 assert.equal(await count(raw,'guard_preparation_checks'),0);assert.equal(await count(raw,'guard_claims'),0);
});

test('a fabricated matching digest never bypasses live SQL protection, hold or Stop checks',async t=>{
 for(const scenario of ['protection','hold','stop'])await t.test(scenario,async t=>{
  const {raw}=await fixture(t),candidate=await rawCandidate(raw);
  if(scenario==='protection')await protect(raw);
  if(scenario==='hold')await hold(raw);
  if(scenario==='stop')await raw.execute("UPDATE guard_accounts SET stopped=1 WHERE user_id='u'");
  const epoch=Number((await raw.execute("SELECT epoch FROM guard_preparation_epochs WHERE user_id='u'")).rows[0].epoch);
  const s={revision:1,protection_digest:'0'.repeat(64),projection_epoch:epoch};
  await raw.execute({sql:'INSERT INTO guard_preparation_snapshots VALUES(?,?,?,?,?)',args:['u',1,new Date().toISOString(),s.protection_digest,epoch]});
  await assert.rejects(insertCheck(raw,rawCheckArgs(s,candidate)),/application_already_protected|employer_hold|account_stopped_or_missing/);
  assert.equal(await count(raw,'guard_claims'),0);
 });
});

test('a separately committed once-valid check is fenced after every live projection transition',async t=>{
 for(const transition of ['protection','hold','stop','stop-and-resume','external-import-event','new-snapshot'])await t.test(transition,async t=>{
  const {db,raw}=await fixture(t),s=await exportPreparationLedger(db,'u'),candidate=await rawCandidate(raw),q=rawCheckArgs(s,candidate);
  await insertCheck(raw,q);
  if(transition==='protection')await protect(raw,{job:{...identity('9999','Other employer','Other role'),url:null}});
  if(transition==='hold')await hold(raw,{job:{...identity('9999','Other employer','Other role'),url:null}});
  if(transition.startsWith('stop'))await raw.execute("UPDATE guard_accounts SET stopped=1 WHERE user_id='u'");
  if(transition==='stop-and-resume')await raw.execute("UPDATE guard_accounts SET stopped=0 WHERE user_id='u'");
  if(transition==='external-import-event')await raw.execute("INSERT INTO guard_preparation_external_events(user_id,source) VALUES('u','history_import')");
  if(transition==='new-snapshot')await exportPreparationLedger(db,'u');
  await assert.rejects(insertClaim(raw,rawClaimArgs(q)),/preparation_snapshot_required|account_stopped_or_missing/);
  assert.equal(await count(raw,'guard_claims'),0);assert.equal(await count(raw,'guard_preparation_reservations'),0);
 });
});

test('append-only epoch and check records resist UPDATE, DELETE, REPLACE and upsert with recursive triggers off',async t=>{
 const {db,raw}=await fixture(t);
 await raw.execute("UPDATE guard_accounts SET stopped=1 WHERE user_id='u'");await raw.execute("UPDATE guard_accounts SET stopped=0 WHERE user_id='u'");
 await raw.execute("INSERT INTO guard_preparation_external_events(user_id,source) VALUES('u','history_import')");
 const s=await exportPreparationLedger(db,'u'),candidate=await rawCandidate(raw),q=rawCheckArgs(s,candidate);await insertCheck(raw,q);
 for(const table of ['guard_account_stop_events','guard_preparation_external_events','guard_preparation_checks']){
  await assert.rejects(raw.execute('UPDATE '+table+' SET user_id=user_id'),/immutable_preparation_record/);
  await assert.rejects(raw.execute('DELETE FROM '+table),/immutable_preparation_record/);
  await assert.rejects(raw.execute('INSERT OR REPLACE INTO '+table+' SELECT * FROM '+table),/immutable_preparation_record/);
  await assert.rejects(raw.execute('INSERT INTO '+table+' SELECT * FROM '+table+' WHERE 1 ON CONFLICT DO UPDATE SET user_id=excluded.user_id'),/immutable_preparation_record/);
 }
 assert.equal(Number((await raw.execute("SELECT epoch FROM guard_preparation_epochs WHERE user_id='u'")).rows[0].epoch),5);
 await insertClaim(raw,rawClaimArgs(q));assert.equal(await count(raw,'guard_claims'),1);
});

test('a raw snapshot rejects an invalid protected ID and the conservative SQL projection byte bound',async t=>{
 const bad=await fixture(t);await protect(bad.raw,{id:'bad\nid'});
 await assert.rejects(bad.raw.execute({sql:'INSERT INTO guard_preparation_snapshots VALUES(?,?,?,?,?)',args:['u',1,new Date().toISOString(),'0'.repeat(64),3]}),/incomplete_projection/);
 const large=await fixture(t);
 await large.raw.execute({sql:'INSERT INTO guard_identities VALUES(?,?,?,?,?)',args:['large','u','Example','Engineer','https://example.test/'+'x'.repeat(2800)]});
 await large.raw.execute("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO guard_protections SELECT 'large:'||x,'u','large','uncertain','synthetic' FROM n");
 // Exact JSON is below 10 MiB; the documented conservative SQL estimate is
 // intentionally stricter so forged snapshots cannot skip bounded projection.
 await assert.rejects(exportPreparationLedger(large.db,'u'),/incomplete_projection/);
 await assert.rejects(large.raw.execute({sql:'INSERT INTO guard_preparation_snapshots VALUES(?,?,?,?,?)',args:['u',1,new Date().toISOString(),'0'.repeat(64),1002]}),/incomplete_projection/);
});

test('native differential fixture agrees for URL-less history, different roles, canonical URLs and fresh replay',async t=>{
 const native=nativeFixture(t),{db,raw}=await fixture(t);
 native.prepare('INSERT INTO external_application_history VALUES(?,?,?,?,?)').run('history','u','Example Labs Inc.','Platform Engineer','not exported');
 await protect(raw,{job:{...identity(undefined,'Example Labs Inc.'),url:null}});
 const ns=nativeExport(native,'u'),gs=await exportPreparationLedger(db,'u');
 assert.deepEqual(gs.records.map(row=>({status:row.status,identity:row.identity})),ns.records.map(row=>({status:row.status,identity:row.identity})));
 assert.equal((await reservePreparation(db,'u',request(gs.revision),context)).decision,nativeReserve(native,'u',request(ns.revision)).decision);
 const other=identity('2345','Example Labs','Product Engineer');other.url='https://boards.greenhouse.io/example/jobs/2345/?utm_source=fixture';
 const gr=await reservePreparation(db,'u',request(gs.revision,'differential_req_0001',other),context),nr=nativeReserve(native,'u',request(ns.revision,'differential_req_0001',other));
 assert.equal(gr.decision,nr.decision);assert.deepEqual(gr.identity,nr.identity);assert.equal(gr.submission_allowed,nr.submission_allowed);
 const g2=await exportPreparationLedger(db,'u'),n2=nativeExport(native,'u');
 assert.equal((await reservePreparation(db,'u',request(g2.revision,'differential_req_0001',other),context)).decision,nativeReserve(native,'u',request(n2.revision,'differential_req_0001',other)).decision);
});
