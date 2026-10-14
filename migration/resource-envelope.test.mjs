import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join,relative,resolve,sep} from 'node:path';
import {CONSOLE_RESOURCE_LIMITS,normalizeResourceLimits,assertResourceSpace,createRecoverySnapshot,verifyRecoverySnapshot,createSnapshot,verifySnapshot,inspectDatabase} from './state-snapshot.mjs';
import {copyReferencedResumes} from './recovery-resumes.mjs';

// Synthetic local files only. Mocks instrument built-ins in this test process;
// they are restored before another test and never enter the generated wrapper.
function fixture(t){
 const root=fs.mkdtempSync(join(tmpdir(),'applypilot-resource-envelope-')),source=join(root,'source.sqlite'),uploads=join(root,'uploads'),target=join(root,'target');fs.mkdirSync(uploads);
 const db=new DatabaseSync(source);db.exec('CREATE TABLE applicants(id TEXT PRIMARY KEY,resume_path TEXT);CREATE TABLE resume_previous(id TEXT PRIMARY KEY,path TEXT);CREATE TABLE payload(value);');
 t.after(()=>{try{db.close();}catch{}const rel=relative(resolve(tmpdir()),resolve(root));assert(rel&&rel!=='..'&&!rel.startsWith('..'+sep)&&root.includes('applypilot-resource-envelope-'));fs.rmSync(root,{recursive:true,force:true});});
 return {root,source,uploads,target,db};
}
const limits=overrides=>({...CONSOLE_RESOURCE_LIMITS,...overrides});
const recover=(f,overrides={})=>createRecoverySnapshot(f.source,f.target,{uploadsRoot:f.uploads,resourceLimits:limits(overrides)});
function resetMocks(t){t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});}
function addResume(f,name,bytes){fs.writeFileSync(join(f.uploads,name),Buffer.alloc(bytes,37));f.db.prepare('INSERT INTO applicants VALUES(?,?)').run(name,name);}
function assertIncomplete(f){assert.equal(fs.existsSync(join(f.target,'INCOMPLETE')),true);assert.equal(fs.existsSync(join(f.target,'manifest.json')),false);}

test('reviewed resource limits cannot be loosened and disk availability errors fail closed',t=>{
 const f=fixture(t);assert.equal(normalizeResourceLimits(undefined),null);
 for(const value of [null,[],{extra:1},{maxDatabaseBytes:8388609},{minFreeBytes:1},{maxResumeBytes:0}])assert.throws(()=>normalizeResourceLimits(value),/resource_limits_invalid/);
 assert.throws(()=>assertResourceSpace(join(f.root,'missing'),CONSOLE_RESOURCE_LIMITS),/resource_disk_unavailable/);
 assert.throws(()=>assertResourceSpace(f.root,limits({minFreeBytes:Number.MAX_SAFE_INTEGER})),/resource_insufficient_disk/);
});

test('bounded recovery accepts exactly 52 KiB unique references and verifies after sources disappear',async t=>{
 const f=fixture(t);addResume(f,'one.pdf',53248);f.db.prepare('INSERT INTO resume_previous VALUES(?,?)').run('old','one.pdf');f.db.close();
 assert.equal((await recover(f)).complete,true);fs.unlinkSync(join(f.uploads,'one.pdf'));
 const m=await verifyRecoverySnapshot(f.target,{resourceLimits:CONSOLE_RESOURCE_LIMITS});assert.equal(m.uploads.files.length,1);assert.equal(m.uploads.files[0].bytes,53248);
});

test('full snapshot opts into the same envelope while ordinary offline defaults remain unchanged',async t=>{
 const f=fixture(t);addResume(f,'one.pdf',53249);f.db.close();
 await assert.rejects(createSnapshot(f.source,f.uploads,f.target,{resourceLimits:CONSOLE_RESOURCE_LIMITS}),/resource_upload_limit/);assert.equal(fs.existsSync(f.target),false);
 await createSnapshot(f.source,f.uploads,f.target);assert.equal(verifySnapshot(f.target).uploads[0].size,53249);
});

test('logical WAL image and physical source image are capped before destination writes',async t=>{
 for(const wal of [false,true])await t.test(wal?'WAL logical image':'physical image',async t=>{
  const f=fixture(t);if(wal)f.db.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0');f.db.exec('INSERT INTO payload VALUES(zeroblob(9*1024*1024))');
  if(wal)assert(fs.statSync(f.source).size<8*1024*1024);else f.db.close();
  await assert.rejects(recover(f),/resource_database_size/);assert.equal(fs.existsSync(f.target),false);
 });
});

test('oversized WAL and SHM sidecars are separate fail-closed resource gates',async t=>{
 for(const suffix of ['-wal','-shm'])await t.test(suffix,async t=>{
  const f=fixture(t);f.db.close();fs.writeFileSync(f.source+suffix,Buffer.alloc(101));
  await assert.rejects(recover(f,{[suffix==='-wal'?'maxWalBytes':'maxShmBytes']:100}),/resource_source_sidecar_size/);assert.equal(fs.existsSync(f.target),false);
 });
});

test('backup progress throw rejects early and preserves an incomplete bundle',async t=>{
 const f=fixture(t);f.db.exec('INSERT INTO payload VALUES(zeroblob(512*1024))');f.db.close();
 await assert.rejects(recover(f,{maxBackupSteps:1}),/resource_backup_budget/);assertIncomplete(f);
});

test('final copied image is checked before expensive inspection even without progress evidence',async t=>{
 const f=fixture(t);f.db.exec('INSERT INTO payload VALUES(1)');f.db.close();resetMocks(t);
 const original=fs.lstatSync;let targetChecks=0;
 t.mock.method(fs,'lstatSync',function(path,...args){const stat=original.call(this,path,...args);if(String(path)===join(f.target,'database.sqlite')){targetChecks++;return new Proxy(stat,{get(value,key){return key==='size'?9*1024*1024:Reflect.get(value,key);}});}return stat;});syncBuiltinESMExports();
 await assert.rejects(recover(f),/resource_database_size/);assert(targetChecks>0);assertIncomplete(f);assert(!fs.readdirSync(f.target).some(name=>name.startsWith('.applypilot-hashes-')));
});

test('row counts, schema cardinality, columns and hard spool allocation reject independently',async t=>{
 for(const scenario of ['table-rows','total-rows','tables','objects','schema-bytes','columns','spool'])await t.test(scenario,async t=>{
  const f=fixture(t);f.db.exec('WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<200) INSERT INTO payload SELECT x FROM n');f.db.close();
  const cap=scenario==='table-rows'?{maxTableRows:199}:scenario==='total-rows'?{maxTotalRows:199}:scenario==='tables'?{maxTables:2}:scenario==='objects'?{maxSchemaObjects:2}:scenario==='schema-bytes'?{maxSchemaBytes:200}:scenario==='columns'?{maxColumns:1}:{maxSpoolBytes:8192};
  assert.throws(()=>inspectDatabase(f.source,{resourceLimits:limits(cap)}),/resource_row_limit|resource_schema_limit|resource_column_limit|resource_spool_limit|too many columns|malformed database schema|too long/);
  assert(!fs.readdirSync(f.root).some(name=>name.startsWith('.applypilot-hashes-')));
 });
});

test('virtual/generated tables are outside the reviewed envelope and legal special names retain inventory',t=>{
 const f=fixture(t);f.db.exec("CREATE TABLE '__proto__'(x);INSERT INTO '__proto__' VALUES(1)");f.db.close();
 const state=inspectDatabase(f.source,{resourceLimits:CONSOLE_RESOURCE_LIMITS});assert(Object.hasOwn(state.tables,'__proto__'));assert.equal(state.tables.__proto__.rows,1);
 for(const sql of ["CREATE VIRTUAL TABLE search USING fts5(value)","CREATE TABLE generated(x,y GENERATED ALWAYS AS (zeroblob(1024)) VIRTUAL)"]){const g=fixture(t);g.db.exec(sql);g.db.close();assert.throws(()=>inspectDatabase(g.source,{resourceLimits:CONSOLE_RESOURCE_LIMITS}),/resource_virtual_table|resource_generated_column/);}
});

test('all unique resume sizes are checked before first hash/copy, including aggregate overflow',async t=>{
 const f=fixture(t);addResume(f,'one.pdf',30000);addResume(f,'two.pdf',23249);f.db.close();
 await assert.rejects(recover(f),/recovery_resource_resume_bytes/);assertIncomplete(f);assert.equal(fs.existsSync(join(f.target,'resumes')),false);
});

test('reference row, unique file, path metadata and depth limits fail before resume destination writes',async t=>{
 for(const scenario of ['rows','files','bytes','path','depth'])await t.test(scenario,async t=>{
  const f=fixture(t);f.db.prepare('INSERT INTO applicants VALUES(?,?)').run('one','a/b/one.pdf');f.db.prepare('INSERT INTO applicants VALUES(?,?)').run('two','a/b/two.pdf');f.db.close();
  const cap=scenario==='rows'?{maxReferenceRows:1}:scenario==='files'?{maxResumeFiles:1}:scenario==='bytes'?{maxReferenceBytes:12}:scenario==='path'?{maxPathBytes:5}:{maxPathDepth:2};
  const destination=join(f.root,'copied');await assert.rejects(copyReferencedResumes({databasePath:f.source,sourceRoot:f.uploads,destinationRoot:destination,resourceLimits:limits(cap)}),/recovery_resource_/);assert.equal(fs.existsSync(destination),false);
 });
});

test('resume growth during its first hash or copy cannot stream past the observed size',async t=>{
 for(const stage of [1,3])await t.test(stage===1?'first hash':'copy',async t=>{
  const f=fixture(t);addResume(f,'one.pdf',1024);f.db.close();resetMocks(t);const original=fsp.open;let reads=0;
  t.mock.method(fsp,'open',async function(path,...args){const handle=await original.call(this,path,...args);if(String(path)===join(f.uploads,'one.pdf')){const read=handle.read.bind(handle);handle.read=async(...readArgs)=>{if(++reads===stage)fs.appendFileSync(path,Buffer.from([1]));return read(...readArgs);};}return handle;});syncBuiltinESMExports();
  await assert.rejects(recover(f),/recovery_resource_resume_growth|recovery_resume_source_changed/);assertIncomplete(f);
 });
});

test('disk free-space gates reject before destination and before spool creation',async t=>{
 for(const phase of ['destination','spool'])await t.test(phase,async t=>{
  const f=fixture(t);f.db.close();resetMocks(t);const original=fs.statfsSync;
  t.mock.method(fs,'statfsSync',function(path,...args){if(phase==='destination'||String(path)===f.target)return {bavail:1n,bsize:4096n};return original.call(this,path,...args);});syncBuiltinESMExports();
  await assert.rejects(recover(f),/resource_insufficient_disk/);
  if(phase==='destination')assert.equal(fs.existsSync(f.target),false);else{assertIncomplete(f);assert(!fs.readdirSync(f.target).some(name=>name.startsWith('.applypilot-hashes-')));}
 });
});

test('oversized verification manifest is refused before JSON parsing',async t=>{
 const f=fixture(t);f.db.close();await recover(f);fs.writeFileSync(join(f.target,'manifest.json'),' '.repeat(1048577));
 await assert.rejects(verifyRecoverySnapshot(f.target,{resourceLimits:CONSOLE_RESOURCE_LIMITS}),/resource_manifest_size/);
});

test('mixed dense/schema/reference shape remains bounded and keeps exact distinct bytes',async t=>{
 const f=fixture(t);
 f.db.exec('CREATE TABLE wide('+Array.from({length:128},(_,i)=>'c'+i+' TEXT').join(',')+');INSERT INTO wide(c0) VALUES(\'wide 😀\');');
 for(let i=0;i<60;i++)f.db.exec('CREATE TABLE empty_'+i+'(id INTEGER,value TEXT);CREATE INDEX idx_'+i+' ON empty_'+i+'(value)');
 for(let i=0;i<64;i++)fs.writeFileSync(join(f.uploads,'r'+i+'.pdf'),Buffer.alloc(832));
 const add=f.db.prepare('INSERT INTO applicants VALUES(?,?)');for(let i=0;i<1024;i++)add.run('app-'+i,'r'+(i%64)+'.pdf');
 f.db.exec('WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO payload SELECT x FROM n');f.db.close();
 await recover(f);const m=await verifyRecoverySnapshot(f.target,{resourceLimits:CONSOLE_RESOURCE_LIMITS});assert.equal(m.uploads.files.length,64);assert.equal(m.uploads.files.reduce((n,r)=>n+r.bytes,0),53248);assert.equal(m.database.tables.payload.rows,10000);
});
