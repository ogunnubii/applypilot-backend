import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {closeSync,existsSync,linkSync,mkdirSync,mkdtempSync,openSync,readFileSync,rmSync,statSync,symlinkSync,unlinkSync,utimesSync,watch,writeFileSync,writeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,sep} from 'node:path';
import {copyReferencedResumes,verifyReferencedResumes} from './recovery-resumes.mjs';

function fixture(t,{schema=true}={}){
 const root=mkdtempSync(join(tmpdir(),'applypilot-recovery-resumes-')),databasePath=join(root,'snapshot.sqlite'),sourceRoot=join(root,'source'),destinationRoot=join(root,'destination');
 mkdirSync(sourceRoot);const db=new DatabaseSync(databasePath);
 if(schema)db.exec('CREATE TABLE applicants(id TEXT PRIMARY KEY,resume_path TEXT);CREATE TABLE resume_previous(applicant_id TEXT PRIMARY KEY,path TEXT);');
 t.after(()=>{try{db.close();}catch{}const rel=relative(resolve(tmpdir()),resolve(root));assert(rel&&rel!=='..'&&!rel.startsWith('..'+sep)&&root.includes('applypilot-recovery-resumes-'));rmSync(root,{recursive:true,force:true});});
 return {root,databasePath,sourceRoot,destinationRoot,db,options:{databasePath,sourceRoot,destinationRoot}};
}
function makeFile(path,blocks=1){
 const fd=openSync(path,'wx'),buffer=Buffer.alloc(64*1024,37),hash=createHash('sha256');
 try{for(let i=0;i<blocks;i++){writeSync(fd,buffer);hash.update(buffer);}}finally{closeSync(fd);}
 return {sha256:hash.digest('hex'),bytes:blocks*buffer.length};
}
function current(f,path){f.db.prepare('INSERT INTO applicants VALUES(?,?)').run('current',path);}

test('copies current and previous references, deduplicates paths, preserves relative paths and does not rewrite snapshot',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'profile'));
 const resume=join(f.sourceRoot,'profile','current.PDF'),previous=join(f.sourceRoot,'profile','previous.docx');
 const big=makeFile(resume,65),small=makeFile(previous,1);writeFileSync(join(f.sourceRoot,'unreferenced.txt'),'ignored fictional file');
 current(f,resume);f.db.prepare('INSERT INTO applicants VALUES(?,?)').run('shared',resume);f.db.prepare('INSERT INTO applicants VALUES(?,?)').run('none',null);
 f.db.prepare('INSERT INTO resume_previous VALUES(?,?)').run('previous','profile/previous.docx');f.db.prepare('INSERT INTO resume_previous VALUES(?,?)').run('shared',resume);f.db.close();
 const before=readFileSync(f.databasePath),manifest=await copyReferencedResumes(f.options);
 assert.equal(manifest.consistency,'referenced_files_observed_stable_in_interval_only');assert.equal(manifest.database_and_resumes_atomic,false);assert.equal(manifest.external_workflows_frozen,false);assert.equal(manifest.files.length,2);
 const now=Date.now();
 for(const file of manifest.files){
  const expected=file.relative_path.endsWith('.PDF')?big:small;assert.equal(file.sha256,expected.sha256);assert.equal(file.bytes,expected.bytes);
  assert.equal(createHash('sha256').update(readFileSync(join(f.destinationRoot,...file.relative_path.split('/')))).digest('hex'),file.sha256);
  const times=[file.source_observed_started_at,file.copy_started_at,file.copy_finished_at,file.source_observed_finished_at].map(Date.parse);assert(times.every(Number.isFinite));assert(times.every((value,i)=>!i||value>=times[i-1]));assert(times[3]<=now);
 }
 assert.deepEqual(manifest.files[0].reference_counts,{applicants:2,resume_previous:1});assert.deepEqual(manifest.files[1].reference_counts,{applicants:0,resume_previous:1});
 assert.deepEqual(readFileSync(f.databasePath),before);assert.equal(existsSync(join(f.destinationRoot,'unreferenced.txt')),false);
 assert.doesNotMatch(JSON.stringify(manifest),/ignored fictional file/);
});

test('required reference tables and columns fail closed even when no files are referenced',async t=>{
 for(const schema of ['CREATE TABLE applicants(id TEXT,resume_path TEXT)','CREATE TABLE applicants(id TEXT);CREATE TABLE resume_previous(path TEXT)','CREATE TABLE applicants(resume_path TEXT);CREATE TABLE resume_previous(id TEXT)']){
  const f=fixture(t,{schema:false});f.db.exec(schema);f.db.close();await assert.rejects(copyReferencedResumes(f.options),/recovery_resume_schema_missing/);assert.equal(existsSync(f.destinationRoot),false);
 }
});

test('null current references are absent; empty current and null previous references are invalid',async t=>{
 const f=fixture(t);current(f,null);f.db.close();assert.equal((await copyReferencedResumes(f.options)).files.length,0);
 const empty=fixture(t);current(empty,'');empty.db.close();await assert.rejects(copyReferencedResumes(empty.options),/recovery_invalid_resume_reference/);
 const previous=fixture(t);previous.db.exec("INSERT INTO resume_previous VALUES('p',NULL)");previous.db.close();await assert.rejects(copyReferencedResumes(previous.options),/recovery_invalid_resume_reference/);
});

test('missing current or previous referenced resume fails without changing the database',async t=>{
 for(const table of ['applicants','resume_previous']){
  const f=fixture(t);f.db.prepare(`INSERT INTO ${table} VALUES(?,?)`).run('missing',join(f.sourceRoot,'missing.pdf'));f.db.close();const before=readFileSync(f.databasePath);
  await assert.rejects(copyReferencedResumes(f.options),/recovery_resume_missing_or_changed/);assert.deepEqual(readFileSync(f.databasePath),before);
 }
});

test('parent traversal, sibling-prefix paths, extensions, relative roots and destination overlap fail closed',async t=>{
 for(const reference of ['../outside.pdf','profile/../current.pdf','current.txt','current.pdf/child.docx']){
  const f=fixture(t);current(f,reference);f.db.close();await assert.rejects(copyReferencedResumes(f.options),/recovery_(?:invalid_resume_reference|unexpected_resume_extension|resume_missing_or_changed)/);
 }
 const f=fixture(t);mkdirSync(f.sourceRoot+'-sibling');const outside=join(f.sourceRoot+'-sibling','outside.pdf');makeFile(outside);current(f,outside);f.db.close();await assert.rejects(copyReferencedResumes(f.options),/recovery_resume_path_outside_root/);
 await assert.rejects(copyReferencedResumes({...f.options,sourceRoot:'source'}),/recovery_absolute_path_required/);
 await assert.rejects(copyReferencedResumes({...f.options,destinationRoot:join(f.sourceRoot,'copy')}),/recovery_resume_roots_overlap/);
});

test('does not overwrite or adopt a nonempty destination',async t=>{
 const f=fixture(t),source=join(f.sourceRoot,'current.pdf');makeFile(source);current(f,source);f.db.close();mkdirSync(f.destinationRoot);writeFileSync(join(f.destinationRoot,'keep.pdf'),'preserved');
 await assert.rejects(copyReferencedResumes(f.options),/recovery_destination_not_empty/);assert.equal(readFileSync(join(f.destinationRoot,'keep.pdf'),'utf8'),'preserved');
});

for(const change of ['delete','replace','modify'])test(`detects source ${change} after prehash while copying`,async t=>{
 const f=fixture(t),source=join(f.sourceRoot,'current.pdf');makeFile(source,64);current(f,source);f.db.close();mkdirSync(f.destinationRoot);
 let changed=false,mutationError;
 const watcher=watch(f.destinationRoot,(_event,name)=>{
  if(changed||String(name)!=='current.pdf')return;changed=true;
  try{
   if(change==='delete')unlinkSync(source);
   else if(change==='replace'){unlinkSync(source);makeFile(source,64);}
   else {const before=statSync(source),fd=openSync(source,'r+');try{writeSync(fd,Buffer.from('changed'),0,7,65536);}finally{closeSync(fd);}utimesSync(source,before.atime,before.mtime);}
  }catch(error){mutationError=error;}
 });
 try{await assert.rejects(copyReferencedResumes(f.options),/recovery_(?:resume_(?:source_changed|missing_or_changed|hash_mismatch)|linked_or_invalid_file)/);}finally{watcher.close();}
 assert.equal(mutationError,undefined);assert.equal(changed,true,'mutation occurs after destination creation and source prehash');
});

test('rejects hard-linked source resumes when the sandbox permits creation',async t=>{
 const f=fixture(t),source=join(f.sourceRoot,'current.pdf');makeFile(source);
 try{linkSync(source,join(f.sourceRoot,'linked.pdf'));}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('Sandbox denies synthetic hard-link creation; no escalation attempted');return;}throw error;}
 current(f,source);f.db.close();await assert.rejects(copyReferencedResumes(f.options),/recovery_linked_or_invalid_file/);
});

test('rejects a symlink or junction anywhere in a source parent path',async t=>{
 const f=fixture(t),actual=join(f.root,'actual'),linked=join(f.sourceRoot,'linked');mkdirSync(actual);makeFile(join(actual,'current.pdf'));
 try{symlinkSync(actual,linked,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('Sandbox denies synthetic parent-link creation; no escalation attempted');return;}throw error;}
 current(f,join(linked,'current.pdf'));f.db.close();await assert.rejects(copyReferencedResumes(f.options),/recovery_linked_parent_path/);
});

test('offline verification uses copied DB references and succeeds after live resume files disappear',async t=>{
 const f=fixture(t),source=join(f.sourceRoot,'current.pdf');makeFile(source,2);current(f,source);f.db.prepare('INSERT INTO resume_previous VALUES(?,?)').run('previous',source);f.db.close();
 const manifest=await copyReferencedResumes(f.options);unlinkSync(source);
 const result=await verifyReferencedResumes({databasePath:f.databasePath,sourceRoot:f.sourceRoot,copyRoot:f.destinationRoot,manifest});
 assert.deepEqual(result,{verified:true,file_count:1,consistency:'referenced_files_observed_stable_in_interval_only',external_workflows_frozen:false,database_and_resumes_atomic:false});
});

test('offline verification rejects missing, changed and extra copied files or directories',async t=>{
 for(const change of ['missing','changed','extra-file','extra-directory']){
  const f=fixture(t),source=join(f.sourceRoot,'current.pdf');makeFile(source);current(f,source);f.db.close();const manifest=await copyReferencedResumes(f.options);
  if(change==='missing')unlinkSync(join(f.destinationRoot,'current.pdf'));
  if(change==='changed')writeFileSync(join(f.destinationRoot,'current.pdf'),'changed');
  if(change==='extra-file')writeFileSync(join(f.destinationRoot,'extra.pdf'),'extra');
  if(change==='extra-directory')mkdirSync(join(f.destinationRoot,'extra'));
  await assert.rejects(verifyReferencedResumes({databasePath:f.databasePath,sourceRoot:f.sourceRoot,copyRoot:f.destinationRoot,manifest}),/recovery_(?:resume_missing_or_changed|resume_copy_hash_mismatch|unexpected_copy_path)/);
 }
});

test('offline verification rejects altered file lists, counts, timestamps, flags, digests and paths',async t=>{
 const f=fixture(t),source=join(f.sourceRoot,'current.pdf');makeFile(source);current(f,source);f.db.close();const manifest=await copyReferencedResumes(f.options);
 const mutate=[m=>m.files.push({...m.files[0]}),m=>m.files.splice(0),m=>m.files[0].reference_counts.applicants++,m=>m.files[0].relative_path='../current.pdf',m=>m.files[0].relative_path='missing.pdf',m=>m.files[0].sha256='0'.repeat(64),m=>m.files[0].bytes++,m=>m.files[0].copy_started_at='not a time',m=>m.finished_at='2000-01-01T00:00:00.000Z',m=>m.database_and_resumes_atomic=true,m=>m.external_workflows_frozen=true,m=>m.files[0].unexpected='value'];
 for(const change of mutate){const bad=structuredClone(manifest);change(bad);await assert.rejects(verifyReferencedResumes({databasePath:f.databasePath,sourceRoot:f.sourceRoot,copyRoot:f.destinationRoot,manifest:bad}),/recovery_resume_(?:manifest_invalid|copy_hash_mismatch)/);}
});

test('offline verification detects copied DB reference changes rather than trusting a manifest inventory',async t=>{
 const f=fixture(t),source=join(f.sourceRoot,'current.pdf');makeFile(source);current(f,source);f.db.close();const manifest=await copyReferencedResumes(f.options);
 const changed=new DatabaseSync(f.databasePath);changed.prepare('INSERT INTO resume_previous VALUES(?,?)').run('new-reference',source);changed.close();
 await assert.rejects(verifyReferencedResumes({databasePath:f.databasePath,sourceRoot:f.sourceRoot,copyRoot:f.destinationRoot,manifest}),/recovery_resume_manifest_invalid/);
});

test('malformed oversized and BLOB reference values fail before copying',async t=>{
 for(const reference of ['a'.repeat(100000)+'.pdf',Buffer.alloc(100000,65)]){
  const f=fixture(t);current(f,reference);f.db.close();await assert.rejects(copyReferencedResumes(f.options),/recovery_invalid_resume_reference/);assert.equal(existsSync(f.destinationRoot),false);
 }
});
