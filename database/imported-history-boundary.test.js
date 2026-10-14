import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {runtimeFixture,fixtureJobId,fixtureURL,FIXTURE_OWNER,FIXTURE_AT} from './runtime-fixture.js';
import {registerNativeFunctions} from './native-functions.js';
import {openNativeDatabase} from './native.js';
import {installImportedHistory} from '../migration/install-imported-history.mjs';
import {hashFile,inspectDatabase} from '../migration/state-snapshot.mjs';
import {exportPreparationLedger,reservePreparation} from '../api/preparation-handoff.js';
import {authorizePreparationStep} from '../api/preparation-authorization.js';
import {syncLocalReceipt} from '../receipt-sync.js';

async function imported(t){const f=runtimeFixture(process.env.APPLYPILOT_ASYNC_TEST_ROOT);f.add(1,{status:'local_browser',attempt:true});f.add(2);f.add(3);const snapshot=f.finish(),targetPath=join(f.dir,'imported.sqlite'),result=await installImportedHistory({...snapshot,targetPath});const raw=new DatabaseSync(targetPath);registerNativeFunctions(raw);raw.exec('PRAGMA foreign_keys=ON');const db=openNativeDatabase(targetPath);t.after(async()=>{await db.close();raw.close();});return {...f,snapshot,targetPath,raw,db,result};}
const identity=n=>({url:fixtureURL(n),employer:'Fictional '+n,title:'Engineer '+n,location:'Canada'});
const request=(s,n=2)=>({schema_version:2,request_id:'native_import_request_'+n,expected_revision:s.revision,identity:identity(n)});

test('installer integrates a verified source with native runtime fences, retains original tables and stops all accounts',async t=>{
 const f=await imported(t);assert.equal(f.result.native_history_integrated,true);assert.equal(f.result.accounts_stopped,true);assert.equal(f.result.application_started,false);
 assert.equal(hashFile(f.path),f.snapshot.manifest.database_sha256);assert.equal(existsSync(f.targetPath+'.INCOMPLETE'),false);
 const target=inspectDatabase(f.targetPath);for(const [name,table] of Object.entries(f.snapshot.manifest.database.tables))if(name!=='sqlite_sequence')assert.deepEqual(target.tables[name],table,name);
 assert.equal(f.raw.prepare('SELECT count(*) n FROM guard_history_completions').get().n,2);
 assert.equal(f.raw.prepare('SELECT count(*) n FROM guard_accounts WHERE stopped=1').get().n,2);
 const ledger=await exportPreparationLedger(f.db,'u');assert(ledger.records.some(r=>r.record_id.startsWith('imported:')));assert(!('history_boundary' in ledger));
 assert.equal((await reservePreparation(f.db,'u',request(ledger))).decision,'blocked');
 await assert.rejects(installImportedHistory({...f.snapshot,targetPath:f.targetPath}),/new_import_target_required/);
 for(const sql of ['DELETE FROM runtime_history_boundary',"UPDATE runtime_history_boundary SET phase='complete'",'INSERT OR REPLACE INTO runtime_history_boundary SELECT * FROM runtime_history_boundary'])assert.throws(()=>f.raw.exec(sql),/immutable_import_boundary/);
});

test('all native queue, ownership, resume, attempt and reservation writes obey imported Stop and protections',async t=>{
 const {raw,db}=await imported(t),id=fixtureJobId(2);
 for(const change of ["status='queued'","status='running'","status='local_browser'","local_owner='other-owner'","local_attempt_at='2026-10-13T13:00:00.000Z'","attempts=1","handoff_available=1","local_phase='verifying'"])
  assert.throws(()=>raw.prepare('UPDATE jobs SET '+change+' WHERE id=?').run(id),/imported_history_not_ready_or_stopped/);
 assert.throws(()=>raw.prepare('INSERT INTO autonomous_attempts VALUES(?,?,?)').run(id,'hosted-worker',FIXTURE_AT),/imported_history_not_ready_or_stopped/);
 assert.throws(()=>raw.prepare('INSERT INTO preparation_handoff_reservations VALUES(?,?,?,?,?)').run('u','synthetic_raw_reservation','synthetic',JSON.stringify(identity(2)),FIXTURE_AT),/imported_history_not_ready_or_stopped/);
 // Test-only activation of this synthetic copied account, never exposed by an
 // installer option or an application endpoint.
 raw.exec("UPDATE guard_accounts SET stopped=0 WHERE user_id='u'");
 assert.throws(()=>raw.prepare("UPDATE jobs SET status='running' WHERE id=?").run(fixtureJobId(1)),/imported_application_protected|repeat|already/i);
 raw.prepare("UPDATE jobs SET status='local_browser',local_owner=? WHERE id=?").run(FIXTURE_OWNER,id);
 assert.equal((await authorizePreparationStep(db,{uid:'u',jobId:id,owner:FIXTURE_OWNER})).status,200);
 raw.exec("UPDATE guard_accounts SET stopped=1 WHERE user_id='u'");assert.equal((await authorizePreparationStep(db,{uid:'u',jobId:id,owner:FIXTURE_OWNER})).status,409);
});

test('unknown attempts remain intact until attributable receipt reconciliation, including while imported account is stopped',async t=>{
 const {raw}=await imported(t),id=fixtureJobId(1),before=raw.prepare('SELECT * FROM jobs WHERE id=?').get(id);
 assert.equal(raw.prepare('SELECT count(*) n FROM employer_receipts').get().n,0);assert.equal(before.challenge,'Unconfirmed submission');
 syncLocalReceipt(raw,id,'u',FIXTURE_OWNER,{url:fixtureURL(1),receipt:'Your application has been received.',afterSubmit:true});
 const after=raw.prepare('SELECT * FROM jobs WHERE id=?').get(id);assert.equal(after.status,'submitted');assert.equal(after.local_attempt_at,before.local_attempt_at);assert.equal(raw.prepare('SELECT count(*) n FROM guard_protections').get().n>0,true);
 assert.equal(raw.prepare('SELECT count(*) n FROM employer_receipts').get().n,1);assert.equal(raw.prepare("SELECT stopped FROM guard_accounts WHERE user_id='u'").get().stopped,1);
});

test('failed source import keeps a durable startup block and never mutates the source',async t=>{
 const f=runtimeFixture(process.env.APPLYPILOT_ASYNC_TEST_ROOT);f.source.exec('DROP TABLE employer_receipts');const snapshot=f.finish(),targetPath=join(f.dir,'incomplete.sqlite');
 await assert.rejects(installImportedHistory({...snapshot,targetPath}),/history_required_table_missing/);assert.equal(existsSync(targetPath+'.INCOMPLETE'),true);assert.equal(hashFile(f.path),snapshot.manifest.database_sha256);
 assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',"import './db.js'"],{env:{...process.env,DATABASE_PATH:targetPath},stdio:'pipe',windowsHide:true}),error=>error.stderr.toString().includes('history_import_incomplete'));
});
