import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createClient} from '@libsql/client';
import {createLibsqlDatabase,openRemoteDatabase} from '../database/libsql.js';
import {openNativeDatabase} from '../database/native.js';
import {UncertainCommitError} from '../database/async-database.js';
import {installPreparationHandoff,exportPreparationLedger as nativeExport} from '../preparation-handoff.js';
import {installEmployerLimits} from '../employer-limits.js';
import {installCompanyApplicationPolicy} from '../company-application-policy.js';
import {exportPreparationLedger,reservePreparation} from './preparation-handoff.js';

const at='2026-10-13T12:00:00.000Z';
const identity=(n='1234',employer='Fictional Labs',title='Platform Engineer')=>({url:`https://job-boards.greenhouse.io/fictional/jobs/${n}`,employer,title,location:'Canada'});
const request=(revision,id='fictional_request_0001',job=identity())=>({schema_version:2,request_id:id,expected_revision:revision,identity:job});
function fixture(t,kind){
 const root=process.env.APPLYPILOT_ASYNC_TEST_ROOT,inside=root&&relative(resolve(tmpdir()),resolve(root));
 if(!inside||inside.startsWith('..'))throw Error('Run via checks/run-async-tests.mjs');
 const path=join(mkdtempSync(join(root,'native-preparation-')),'fixture.sqlite'),raw=new DatabaseSync(path);
 raw.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=0;
 CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES('u'),('other');
 CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,title TEXT,company TEXT,url TEXT,normalized_url TEXT,status TEXT DEFAULT 'saved',attempts INTEGER DEFAULT 0,local_attempt_at TEXT,confirmation TEXT,local_phase TEXT DEFAULT 'ready',notes TEXT DEFAULT '',challenge TEXT,created_at TEXT DEFAULT '2026',updated_at TEXT DEFAULT '2026');
 CREATE TABLE events(id INTEGER PRIMARY KEY,job_id TEXT,at TEXT,type TEXT,message TEXT);
 CREATE TABLE external_application_history(id TEXT,user_id TEXT,company TEXT,title TEXT,notes TEXT);
 CREATE TABLE autonomous_attempts(job_id TEXT PRIMARY KEY,owner TEXT,created_at TEXT);`);
 installEmployerLimits(raw);installCompanyApplicationPolicy(raw);installPreparationHandoff(raw);
 const url=pathToFileURL(path).href;
 const db=kind==='native'?openNativeDatabase(path):createLibsqlDatabase(createClient({url,intMode:'bigint'}));
 t.after(async()=>{await db.close();raw.close();});
 return {db,raw,path,url};
}
function add(raw,id,{job=identity(),user='u',status='saved',attempts=0,confirmation=null}={}){
 raw.prepare('INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,attempts,confirmation) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,user,user+'-profile',job.title,job.employer,job.url,job.url,status,attempts,confirmation);
}
for(const kind of ['native','libsql']){
 test(kind+': async preparation projection matches native history, tombstones, aliases and account isolation',async t=>{
  const {db,raw}=fixture(t,kind);add(raw,'uncertain',{attempts:1,status:'paused',confirmation:'Pending, not a receipt'});add(raw,'deleted',{job:identity('2222','Deleted Employer','SRE'),status:'archived'});add(raw,'other',{job:identity('3333','Other Account','Support'),user:'other',status:'interview'});
  raw.exec("DELETE FROM jobs WHERE id='deleted';INSERT INTO external_application_history VALUES('history','u','Outside Employer','Support','PRIVATE_SYNTHETIC_NOTE');UPDATE jobs SET notes='PRIVATE_SYNTHETIC_NOTE'");
  const before=raw.prepare('SELECT * FROM jobs ORDER BY id').all(),oracle=nativeExport(raw,'u',{at}),actual=await exportPreparationLedger(db,'u',{at});
  assert.deepEqual(actual,{...oracle,revision:oracle.revision+1});assert.doesNotMatch(JSON.stringify(actual),/Other Account|PRIVATE_SYNTHETIC|Pending/);
  assert.deepEqual(raw.prepare('SELECT * FROM jobs ORDER BY id').all(),before);
  const blocked=await reservePreparation(db,'u',request(actual.revision),{at});assert.equal(blocked.decision,'blocked');assert.equal(blocked.submission_allowed,false);
  await assert.rejects(exportPreparationLedger(db,'missing',{at}),/account_missing/);
 });
 test(kind+': an async reservation fences every native job/attempt writer and replay never creates a second reservation',async t=>{
  const {db,raw}=fixture(t,kind);add(raw,'candidate');const snapshot=await exportPreparationLedger(db,'u',{at});
  const claim=await reservePreparation(db,'u',request(snapshot.revision),{at});assert.equal(claim.decision,'reserved');assert.equal(claim.submission_allowed,false);
  for(const change of ["status='queued'","status='running'","status='local_browser'","attempts=1","local_attempt_at='2026-10-13T12:00:00.000Z'"])
   assert.throws(()=>raw.exec('UPDATE jobs SET '+change+" WHERE id='candidate'"),/reserved by ApplyPilot 2/);
  assert.throws(()=>add(raw,'insert-claimed',{status:'queued'}),/reserved by ApplyPilot 2/);
  assert.throws(()=>raw.exec("INSERT INTO autonomous_attempts VALUES('candidate','hosted-worker','2026-10-13T12:00:00.000Z')"),/reserved by ApplyPilot 2/);
  const fresh=await exportPreparationLedger(db,'u',{at}),replay=await reservePreparation(db,'u',request(fresh.revision),{at});
  assert.equal(replay.decision,'rechecked');assert.equal(replay.reservation_id,claim.reservation_id);
  assert.equal(raw.prepare('SELECT count(*) n FROM preparation_handoff_reservations').get().n,1);
  assert.equal(raw.prepare('SELECT count(*) n FROM autonomous_attempts').get().n,0);
  add(raw,'other-role',{job:identity('4444','Fictional Labs','Accountant')});assert.doesNotThrow(()=>raw.exec("UPDATE jobs SET status='queued' WHERE id='other-role'"));
 });
 test(kind+': stale or changed snapshots and identity-changing replays fail without losing protection',async t=>{
  const {db,raw}=fixture(t,kind);
  await assert.rejects(reservePreparation(db,'u',request(1),{at}),/fresh_snapshot_required/);
  const s=await exportPreparationLedger(db,'u',{at});
  await assert.rejects(reservePreparation(db,'u',request(s.revision),{at:'2026-10-13T12:06:00.000Z'}),/fresh_snapshot_required/);
  await assert.rejects(reservePreparation(db,'u',request(s.revision),{at:'2026-10-13T11:59:59.000Z'}),/fresh_snapshot_required/);
  add(raw,'attempt',{job:identity('2222','Protected','Engineer'),attempts:1});
  await assert.rejects(reservePreparation(db,'u',request(s.revision),{at}),/snapshot_changed/);
  const fresh=await exportPreparationLedger(db,'u',{at}),claim=await reservePreparation(db,'u',request(fresh.revision),{at});
  await assert.rejects(reservePreparation(db,'u',request(fresh.revision,'fictional_request_0001',identity('9999')),{at}),/request_identity_conflict/);
  assert.equal(raw.prepare('SELECT reservation_id FROM preparation_handoff_reservations').get().reservation_id,claim.reservation_id);
 });
 test(kind+': quota refresh uses the native receipt chronology, and a late snapshot failure rolls the refresh back',async t=>{
  const {db,raw}=fixture(t,kind);add(raw,'received',{status:'interview',confirmation:'Your application has been received.'});
  raw.exec("INSERT INTO events VALUES(1,'received','2026-10-12T12:00:00.000Z','submitted','Synthetic receipt');INSERT INTO employer_limits VALUES('u','u-profile','greenhouse:fictional','Fictional Labs','2026-10-12T12:00:00.000Z','old-value',1,30,'Synthetic','fixture',NULL,NULL)");
  const oracle=nativeExport(raw,'u',{at}),expected=raw.prepare('SELECT hold_until FROM employer_limits').get();
  raw.exec("UPDATE employer_limits SET hold_until='old-value';CREATE TRIGGER synthetic_late_failure BEFORE INSERT ON preparation_handoff_snapshots BEGIN SELECT RAISE(ABORT,'synthetic_late_failure');END;");
  await assert.rejects(exportPreparationLedger(db,'u',{at}),/synthetic_late_failure/);assert.equal(raw.prepare('SELECT hold_until FROM employer_limits').get().hold_until,'old-value');
  raw.exec('DROP TRIGGER synthetic_late_failure');const actual=await exportPreparationLedger(db,'u',{at});assert.deepEqual(actual,{...oracle,revision:oracle.revision+1});assert.deepEqual(raw.prepare('SELECT hold_until FROM employer_limits').get(),expected);
 });
 test(kind+': projection pages retain all records and a bad identity never creates a complete snapshot',async t=>{
  const {db,raw}=fixture(t,kind);raw.exec('BEGIN');for(let n=0;n<201;n++)raw.prepare('INSERT INTO external_application_history VALUES(?,?,?,?,?)').run('h'+String(n).padStart(3,'0'),'u','History '+n,'Engineer','PRIVATE');raw.exec('COMMIT');
  const actual=await exportPreparationLedger(db,'u',{at});assert.equal(actual.records.length,201);assert.equal(actual.records[200].record_id,'history:h200');
  raw.exec("INSERT INTO external_application_history VALUES('invalid','u','','Engineer','PRIVATE')");await assert.rejects(exportPreparationLedger(db,'u',{at}),/invalid_identity/);
  assert.equal(raw.prepare('SELECT revision FROM preparation_handoff_snapshots').get().revision,actual.revision);
 });
 test(kind+': competing adapters cannot both reserve from the same snapshot; persisted reservation survives reconnect',async t=>{
  const {db,path,url}=fixture(t,kind),other=kind==='native'?openNativeDatabase(path):createLibsqlDatabase(createClient({url,intMode:'bigint'}));t.after(()=>other.close());
  const snapshot=await exportPreparationLedger(db,'u',{at}),results=await Promise.allSettled([reservePreparation(db,'u',request(snapshot.revision),{at}),reservePreparation(other,'u',request(snapshot.revision,'fictional_request_0002'),{at})]);
  assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value.decision==='reserved').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  await other.close();const reopened=kind==='native'?openNativeDatabase(path):createLibsqlDatabase(createClient({url,intMode:'bigint'}));t.after(()=>reopened.close());
  const fresh=await exportPreparationLedger(reopened,'u',{at});assert.equal((await reservePreparation(reopened,'u',request(fresh.revision,'fictional_request_0003'),{at})).decision,'blocked');
 });
}
test('lost committed reservation response is uncertain, and retry requires a fresh ledger before reconciling',async t=>{
 const {db,url,raw}=fixture(t,'libsql'),client=createClient({url,intMode:'bigint'});let armed=true;
 const fault=createLibsqlDatabase({close:()=>client.close(),async transaction(mode){const tx=await client.transaction(mode);return {execute:s=>tx.execute(s),rollback:()=>tx.rollback(),close:()=>tx.close(),async commit(){await tx.commit();if(armed){armed=false;throw Error('synthetic_lost_commit');}}};}});t.after(()=>fault.close());
 const s=await exportPreparationLedger(db,'u',{at});await assert.rejects(reservePreparation(fault,'u',request(s.revision),{at}),UncertainCommitError);
 assert.equal(raw.prepare('SELECT count(*) n FROM preparation_handoff_reservations').get().n,1);
 await assert.rejects(reservePreparation(db,'u',request(s.revision),{at}),/snapshot_changed/);
 const fresh=await exportPreparationLedger(db,'u',{at});assert.equal((await reservePreparation(db,'u',request(fresh.revision),{at})).decision,'rechecked');
});
test('remote runtime factory cannot interpret protected-history completion or caller flags as full import qualification',async()=>{
 await assert.rejects(openRemoteDatabase({url:'https://synthetic.invalid',authToken:'synthetic-never-sent',qualified:true,importComplete:true}),/remote_runtime_not_qualified/);
});
