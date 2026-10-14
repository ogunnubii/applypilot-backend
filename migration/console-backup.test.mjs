import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,sep} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {inspectDatabase,verifySnapshot,verifyRecoverySnapshot,hashFile} from './state-snapshot.mjs';
import {consoleProgram,recoveryProgram,MINIMUM_HEADROOM_BYTES} from './build-console-backup.mjs';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'applypilot-console-fixture-')),source=join(root,'source.sqlite'),uploads=join(root,'uploads'),target=join(root,'bundle');
 const db=new DatabaseSync(source);
 db.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE users(id TEXT PRIMARY KEY,password_hash TEXT);INSERT INTO users VALUES('fictional','SYNTHETIC_VERIFIER_MUST_NOT_PRINT');CREATE TABLE attempts(id TEXT,phase TEXT);INSERT INTO attempts VALUES('uncertain','uncertain');CREATE TABLE applicants(resume_path TEXT);CREATE TABLE resume_previous(path TEXT)");
 mkdirSync(uploads);writeFileSync(join(uploads,'fictional.pdf'),'%PDF-FICTIONAL');writeFileSync(join(uploads,'previous.docx'),'SYNTHETIC-DOCX');
 db.prepare('INSERT INTO applicants VALUES(?)').run(join(uploads,'fictional.pdf'));db.prepare('INSERT INTO resume_previous VALUES(?)').run(join(uploads,'previous.docx'));
 t.after(()=>{db.close();const r=relative(resolve(tmpdir()),resolve(root));assert(r&&!r.startsWith('..'+sep)&&r!=='..');rmSync(root,{recursive:true,force:true});});
 return {root,source,uploads,target,db};
}
function execute(program,approval,f){
 return spawnSync(process.execPath,['--max-old-space-size=24','--max-semi-space-size=1','--input-type=module','-',approval,f.source,f.uploads,f.target],{input:program,encoding:'utf8'});
}
for(const recovery of [false,true])test(`${recovery?'recovery':'full'} inline Node phase exits before archive and round-trips without printing row values`,async t=>{
 const f=fixture(t),before=inspectDatabase(f.source),program=recovery?recoveryProgram:consoleProgram;
 const rejected=spawnSync(process.execPath,['--input-type=module','-'],{input:program,encoding:'utf8'});assert.equal(rejected.status,1);assert.match(rejected.stderr,/full_state_backup_approval_required/);
 const result=execute(program,recovery?'--approved-sqlite-recovery-backup':'--approved-full-state-backup',f);
 assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout+result.stderr,/SYNTHETIC_VERIFIER_MUST_NOT_PRINT/);
 const report=JSON.parse(result.stdout);assert.equal(report.snapshot_ready,true);assert.equal(report.source_rows_modified,false);assert.equal(report.target,f.target);assert(report.peak_rss_kib>0);assert.equal(report.archive,undefined);
 if(recovery){assert.equal(report.external_workflows_frozen,false);assert.equal(report.database_and_resumes_atomic,false);assert.equal(report.upload_count,2);}
 // spawnSync returned: the Node process has exited before any archive process.
 const archive=f.target+'.tar.gz';execFileSync('tar',['-czf',archive,'-C',f.target,'database.sqlite','resumes','manifest.json']);execFileSync('tar',['-tzf',archive]);assert.match(hashFile(archive),/^[a-f0-9]{64}$/);
 const restored=join(f.root,'readback');mkdirSync(restored);execFileSync('tar',['-xzf',archive,'-C',restored]);
 const manifest=recovery?await verifyRecoverySnapshot(restored):verifySnapshot(restored);
 assert.deepEqual(manifest.database,before);assert.deepEqual(inspectDatabase(f.source),before);
});

test('inline recovery fails closed when a copied DB resume reference is missing',t=>{
 const f=fixture(t);f.db.prepare('INSERT INTO resume_previous VALUES(?)').run(join(f.uploads,'missing.pdf'));
 const result=execute(recoveryProgram,'--approved-sqlite-recovery-backup',f);
 assert.equal(result.status,1);assert.match(result.stderr,/recovery_resume_missing_or_changed/);assert.doesNotMatch(result.stdout,/snapshot_ready|backup_ready/);assert(existsSync(join(f.target,'INCOMPLETE')));assert(!existsSync(f.target+'.tar.gz'));
});

test('generated shell retains memory rejection before Node and tar, with no overlapping archive child',()=>{
 const source=readFileSync(new URL('./railway-console-recovery.sh',import.meta.url),'utf8');
 assert.equal(MINIMUM_HEADROOM_BYTES,100663296);assert(80*1024*1024<MINIMUM_HEADROOM_BYTES);
 assert(source.includes('test "$AP_BACKUP_HEADROOM" -ge '+MINIMUM_HEADROOM_BYTES));assert(source.includes('case "$AP_BACKUP_LIMIT:$AP_BACKUP_CURRENT" in *[!0-9:]*|:*|*:)'));
 const node=source.indexOf('node --max-old-space-size=24'),end=source.lastIndexOf('\nAPPLYPILOT_BACKUP_MODULE\n'),tar=source.indexOf('tar -czf -');
 assert(source.indexOf('\nap_backup_check_memory\n')<node);assert(end>node);assert(source.indexOf('\nap_backup_check_memory\n',end)>end);assert(tar>end);assert(!recoveryProgram.includes('node:child_process'));assert(source.indexOf('tar -tzf')<source.lastIndexOf('"backup_ready":true'));
 // This is a source-structure check; POSIX execution requires the Linux worker.
});
