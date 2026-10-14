import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {installEmployerLimits} from '../employer-limits.js';
import {installCompanyApplicationPolicy} from '../company-application-policy.js';
import {installPreparationHandoff,exportPreparationLedger,reservePreparation} from '../preparation-handoff.js';
import {createSnapshot,inspectDatabase,restoreToEmpty,verifySnapshot} from './state-snapshot.mjs';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'applypilot-migration-fixture-'));
 const source=join(root,'source.sqlite'),uploads=join(root,'uploads'),bundle=join(root,'bundle'),restored=join(root,'restored');
 const db=new DatabaseSync(source);
 t.after(()=>{
  try{db.close()}catch{}
  // Only remove this test's freshly-created directory inside the OS temp root.
  const boundary=resolve(tmpdir()),target=resolve(root),r=relative(boundary,target);
  assert(r&&!r.startsWith('..'+sep)&&r!=='..'&&target.includes('applypilot-migration-fixture-'));
  rmSync(target,{recursive:true,force:true});
 });
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA foreign_keys=ON;
 CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,title TEXT,company TEXT,url TEXT,normalized_url TEXT,status TEXT DEFAULT 'saved',attempts INTEGER DEFAULT 0,local_attempt_at TEXT,confirmation TEXT,local_phase TEXT DEFAULT 'ready',notes TEXT DEFAULT '',challenge TEXT,created_at TEXT DEFAULT '2026',updated_at TEXT DEFAULT '2026');
 CREATE TABLE events(id INTEGER PRIMARY KEY,job_id TEXT REFERENCES jobs(id),at TEXT,type TEXT,message TEXT);
 CREATE TABLE external_application_history(id TEXT,user_id TEXT,company TEXT,title TEXT,notes TEXT);
 CREATE TABLE users(id TEXT PRIMARY KEY,password_hash TEXT);
 CREATE TABLE manual_submit_clicks(id TEXT PRIMARY KEY,job_id TEXT,phase TEXT,observed_at TEXT);
 CREATE TABLE employer_receipts(id TEXT PRIMARY KEY,job_id TEXT,evidence TEXT);
 CREATE TABLE unresolved_attempt_quarantines(id TEXT PRIMARY KEY,job_id TEXT,reason TEXT);
 CREATE TABLE resume_previous(id TEXT PRIMARY KEY,path TEXT);
 CREATE TABLE arbitrary_future_state(id INTEGER PRIMARY KEY,big INTEGER,raw BLOB,nullable TEXT);
 `);
 installEmployerLimits(db);installCompanyApplicationPolicy(db);installPreparationHandoff(db);
 const add=db.prepare('INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,attempts,local_phase,local_attempt_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
 const url='https://job-boards.greenhouse.io/fictional/jobs/1234';
 add.run('uncertain','user','profile','Engineer','Fictional Inc',url,url,'paused',1,'uncertain','2026-10-13T23:22:00Z');
 const reservedURL='https://job-boards.greenhouse.io/another/jobs/4567';
 add.run('reserved','user','profile','Designer','Another Fictional',reservedURL,reservedURL,'saved',0,'ready',null);
 db.exec(`INSERT INTO users VALUES('user','FAKE_PASSWORD_HASH_ONLY');
 INSERT INTO events VALUES(1,'uncertain','2026-10-13T23:22:00Z','submission_started','FICTIONAL_PRIVATE_EVIDENCE');
 INSERT INTO manual_submit_clicks VALUES('click','uncertain','intent','2026-10-13T23:22:00Z');
 INSERT INTO unresolved_attempt_quarantines VALUES('hold','uncertain','No receipt; do not retry');
 INSERT INTO employer_receipts VALUES('receipt','historical','FICTIONAL_RECEIPT');
 INSERT INTO external_application_history VALUES('history','user','Past Fictional','Engineer','FICTIONAL_HISTORY');
 INSERT INTO resume_previous VALUES('previous','/app/data/resumes/profile/previous.docx');
 INSERT INTO arbitrary_future_state VALUES(1,9223372036854775807,x'010203FF',NULL);`);
 db.prepare('INSERT INTO employer_security_holds VALUES(?,?,?,?,?,?,?,?)').run('user','profile','greenhouse:held','Held Fictional','old','2026-10-13','Synthetic rejection','fixture');
 const snapshot=exportPreparationLedger(db,'user');
 const reservation=reservePreparation(db,'user',{schema_version:2,request_id:'fixture_migration_0001',expected_revision:snapshot.revision,identity:{url:reservedURL,employer:'Another Fictional',title:'Designer',location:'Canada'}});
 assert.equal(reservation.decision,'reserved');
 mkdirSync(join(uploads,'profile'),{recursive:true});
 writeFileSync(join(uploads,'profile','current.pdf'),'%PDF-1.4\nFICTIONAL_RESUME');
 writeFileSync(join(uploads,'profile','previous.docx'),'FICTIONAL_DOCX_BYTES');
 return {root,source,uploads,bundle,restored,db,reservation};
}

test('WAL-aware snapshot and offline restore preserve every table, schema, upload and protected state',async t=>{
 const f=fixture(t),before=inspectDatabase(f.source);
 assert(statSync(f.source+'-wal').size>0,'committed fixture rows still exist in WAL');
 const result=await createSnapshot(f.source,f.uploads,f.bundle);
 assert.equal(result.complete,true);assert.equal(result.upload_count,2);
 assert(!existsSync(join(f.bundle,'INCOMPLETE')));
 const manifest=verifySnapshot(f.bundle);
 assert.deepEqual(manifest.database,before);
 assert.doesNotMatch(JSON.stringify(manifest),/FAKE_PASSWORD_HASH_ONLY|FICTIONAL_PRIVATE_EVIDENCE|FICTIONAL_RECEIPT|FICTIONAL_HISTORY|FICTIONAL_RESUME/);
 assert.deepEqual(inspectDatabase(f.source),before,'source rows and schema were unchanged');
 assert.deepEqual(restoreToEmpty(f.bundle,f.restored),{restored:true,table_count:Object.keys(before.tables).length,upload_count:2,application_started:false,resume_paths_rewritten:false});
 assert(!existsSync(join(f.restored,'INCOMPLETE')));
 assert.equal(JSON.parse(readFileSync(join(f.restored,'RESTORE-VERIFIED.json'),'utf8')).restored,true);
 const restoredPath=join(f.restored,'database.sqlite');
 assert.deepEqual(inspectDatabase(restoredPath),before);
 assert.equal(readFileSync(join(f.restored,'resumes','profile','current.pdf'),'utf8'),'%PDF-1.4\nFICTIONAL_RESUME');
 const db=new DatabaseSync(restoredPath);
 try{
  assert.equal(db.prepare("SELECT local_phase FROM jobs WHERE id='uncertain'").get().local_phase,'uncertain');
  assert.equal(db.prepare("SELECT attempts FROM jobs WHERE id='uncertain'").get().attempts,1);
  assert.equal(db.prepare("SELECT confirmation FROM jobs WHERE id='uncertain'").get().confirmation,null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM manual_submit_clicks').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM unresolved_attempt_quarantines').get().n,1);
  assert.equal(db.prepare('SELECT path FROM resume_previous').get().path,'/app/data/resumes/profile/previous.docx');
  const big=db.prepare('SELECT big FROM arbitrary_future_state');big.setReadBigInts(true);
  assert.equal(big.get().big,9223372036854775807n);
  // Register the real application's connection-local callbacks on the restored
  // fixture, using pure installers only. No server, worker or live DB import.
  installEmployerLimits(db);installCompanyApplicationPolicy(db);installPreparationHandoff(db);
  assert.throws(()=>db.exec("UPDATE jobs SET status='queued' WHERE id='reserved'"),/reserved by ApplyPilot 2/);
  assert.throws(()=>db.exec("UPDATE jobs SET local_attempt_at='2026-10-14' WHERE id='reserved'"),/reserved by ApplyPilot 2/);
  assert.equal(db.prepare('SELECT reservation_id FROM preparation_handoff_reservations').get().reservation_id,f.reservation.reservation_id);
  assert.throws(()=>db.exec("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status) VALUES('held','user','profile','Engineer','Held Fictional','https://job-boards.greenhouse.io/held/jobs/7890','https://job-boards.greenhouse.io/held/jobs/7890','queued')"),/security rejection/);
 }finally{db.close()}
});

test('never overwrites a snapshot or an existing restore destination',async t=>{
 const f=fixture(t);await createSnapshot(f.source,f.uploads,f.bundle);
 const original=readFileSync(join(f.bundle,'database.sqlite'));
 await assert.rejects(createSnapshot(f.source,f.uploads,f.bundle),/destination_already_exists/);
 mkdirSync(f.restored);writeFileSync(join(f.restored,'keep.txt'),'keep');
 assert.throws(()=>restoreToEmpty(f.bundle,f.restored),/destination_already_exists/);
 assert.equal(readFileSync(join(f.restored,'keep.txt'),'utf8'),'keep');
 assert.deepEqual(readFileSync(join(f.bundle,'database.sqlite')),original);
 assert.throws(()=>restoreToEmpty(f.bundle,join(f.bundle,'nested')),/restore_inside_snapshot/);
});

test('rejects upload files outside the resume allowlist',async t=>{
 const f=fixture(t);writeFileSync(join(f.uploads,'.env'),'FICTIONAL_NOT_A_SECRET');
 await assert.rejects(createSnapshot(f.source,f.uploads,f.bundle),/unexpected_upload_file_type/);
 assert(!existsSync(f.bundle));
});

test('rejects hard-linked upload files when the sandbox permits fixture creation',async t=>{
 const f=fixture(t);
 try{linkSync(join(f.uploads,'profile','current.pdf'),join(f.uploads,'linked.pdf'))}
 catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('Windows sandbox denies hard-link fixture creation; no escalation attempted');return}throw error}
 await assert.rejects(createSnapshot(f.source,f.uploads,f.bundle),/linked_or_invalid_path/);
 assert(!existsSync(f.bundle));
});

test('tampered database bytes and resume bytes fail verification and cannot restore',async t=>{
 const f=fixture(t);await createSnapshot(f.source,f.uploads,f.bundle);
 const dbPath=join(f.bundle,'database.sqlite'),bytes=readFileSync(dbPath);
 const changed=new DatabaseSync(dbPath);changed.exec('UPDATE arbitrary_future_state SET big=0');changed.close();
 assert.throws(()=>verifySnapshot(f.bundle),/database_file_changed|database_state_changed/);
 assert.throws(()=>restoreToEmpty(f.bundle,f.restored),/database_file_changed|database_state_changed/);
 assert(!existsSync(f.restored));
 writeFileSync(dbPath,bytes);verifySnapshot(f.bundle);
 writeFileSync(join(f.bundle,'resumes','profile','current.pdf'),'changed');
 assert.throws(()=>verifySnapshot(f.bundle),/upload_state_changed/);
});

test('incomplete marker and missing manifest fail closed',async t=>{
 const f=fixture(t);await createSnapshot(f.source,f.uploads,f.bundle);
 writeFileSync(join(f.bundle,'INCOMPLETE'),'unfinished');
 assert.throws(()=>verifySnapshot(f.bundle),/incomplete_snapshot/);
 assert.throws(()=>restoreToEmpty(f.bundle,f.restored),/incomplete_snapshot/);
 assert(!existsSync(f.restored));
 rmSync(join(f.bundle,'INCOMPLETE'));rmSync(join(f.bundle,'manifest.json'));
 assert.throws(()=>verifySnapshot(f.bundle));
});

test('CLI errors do not print private paths or input contents',t=>{
 const f=fixture(t),path=join(f.root,'FICTIONAL_PRIVATE_NAME.sqlite');
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('./state-snapshot.mjs',import.meta.url)),'inspect',path],{encoding:'utf8'});
 assert.equal(result.status,1);
 assert.match(result.stderr,/Migration operation failed/);
 assert.doesNotMatch(result.stdout+result.stderr,/FICTIONAL_PRIVATE_NAME|FAKE_PASSWORD_HASH_ONLY/);
});

test('rejects inconsistent foreign keys and a snapshot placed inside uploads',async t=>{
 const f=fixture(t);
 await assert.rejects(createSnapshot(f.source,f.uploads,join(f.uploads,'nested')),/snapshot_inside_uploads/);
 f.db.exec("PRAGMA foreign_keys=OFF; INSERT INTO events VALUES(99,'missing','2026','synthetic','invalid reference')");
 await assert.rejects(createSnapshot(f.source,f.uploads,f.bundle),/foreign_key_check_failed/);
 assert(!existsSync(f.bundle));
});
