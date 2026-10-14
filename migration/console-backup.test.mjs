import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,sep} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {inspectDatabase,verifySnapshot} from './state-snapshot.mjs';

test('the standalone console command creates a WAL-consistent archive without printing row values',async()=>{
 // Generate the exact portable command used by the later approved operator.
 const {consoleProgram}=await import('./build-console-backup.mjs');
 const root=mkdtempSync(join(tmpdir(),'applypilot-console-fixture-')),source=join(root,'source.sqlite'),uploads=join(root,'uploads');
 const db=new DatabaseSync(source);
 try{
  db.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE users(id TEXT PRIMARY KEY,password_hash TEXT);INSERT INTO users VALUES('fictional','SYNTHETIC_VERIFIER_MUST_NOT_PRINT');CREATE TABLE attempts(id TEXT,phase TEXT);INSERT INTO attempts VALUES('uncertain','uncertain')");
  mkdirSync(uploads);writeFileSync(join(uploads,'fictional.pdf'),'%PDF-FICTIONAL');const before=inspectDatabase(source);
  const rejected=spawnSync(process.execPath,['--input-type=module','-'],{input:consoleProgram,encoding:'utf8'});assert.equal(rejected.status,1);assert.match(rejected.stderr,/full_state_backup_approval_required/);
  const result=spawnSync(process.execPath,['--input-type=module','-','--approved-full-state-backup',source,uploads,root],{input:consoleProgram,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout+result.stderr,/SYNTHETIC_VERIFIER_MUST_NOT_PRINT/);
  const report=JSON.parse(result.stdout);assert.equal(report.backup_ready,true);assert(existsSync(report.archive));assert.match(report.sha256,/^[a-f0-9]{64}$/);
  const restored=join(root,'readback');mkdirSync(restored);execFileSync('tar',['-xzf',report.archive,'-C',restored]);
  assert.deepEqual(verifySnapshot(restored).database,before);assert.deepEqual(inspectDatabase(source),before);
 }finally{
  db.close();const r=relative(resolve(tmpdir()),resolve(root));assert(r&&!r.startsWith('..'+sep)&&r!=='..');rmSync(root,{recursive:true,force:true});
 }
});
