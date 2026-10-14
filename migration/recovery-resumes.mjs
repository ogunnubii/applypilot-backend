// Recovery checkpoint helper. It only reads the completed snapshot database and
// referenced source files; it never imports app startup or rewrites source paths.
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {constants,realpathSync} from 'node:fs';
import {lstat,mkdir,open,opendir} from 'node:fs/promises';
import {dirname,extname,isAbsolute,join,parse,relative,resolve,sep} from 'node:path';

const CHUNK_BYTES=64*1024;
const fail=code=>{throw Object.assign(Error(code),{code});};
const now=()=>new Date().toISOString();
const comparable=path=>process.platform==='win32'?path.toLowerCase():path;
const inside=(root,path)=>{const part=relative(root,path);return part!==''&&part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part);};
function absolute(value){
 if(typeof value!=='string'||value.length>32767||!isAbsolute(value)||value.includes('\0')||value.split(/[\\/]/).includes('..'))fail('recovery_absolute_path_required');
 if(process.platform==='win32'&&/^\\\\[?.]\\/.test(value))fail('recovery_namespace_path_rejected');
 return resolve(value);
}
function equalStat(a,b){return ['dev','ino','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);}
function regular(stat){if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n)fail('recovery_linked_or_invalid_file');}
async function checkPath(path,directory=false){
 const root=parse(path).root,parts=relative(root,path).split(sep).filter(Boolean);let current=root;
 const base=await lstat(root,{bigint:true});if(base.isSymbolicLink()||!base.isDirectory())fail('recovery_linked_parent_path');
 for(let i=0;i<parts.length;i++){
  current=join(current,parts[i]);const stat=await lstat(current,{bigint:true}),isDirectory=i<parts.length-1||directory;
  if(stat.isSymbolicLink()||(isDirectory&&!stat.isDirectory()))fail('recovery_linked_parent_path');
  if(!isDirectory)regular(stat);
 }
 // The portable fs.realpathSync implementation works in Windows AppContainer;
 // promises.realpath uses a native handle operation unavailable there. Retain
 // both the explicit ancestor lstat checks and final canonical-path comparison.
 if(comparable(realpathSync(path))!==comparable(path))fail('recovery_linked_parent_path');
 return lstat(path,{bigint:true});
}
function referencePath(sourceRoot,value){
 if(typeof value!=='string'||!value||value.length>32767||value.trim()!==value||/[\x00-\x1f]/.test(value)||value.split(/[\\/]/).includes('..'))fail('recovery_invalid_resume_reference');
 if(process.platform==='win32'){
  if(/^\\\\[?.]\\/.test(value))fail('recovery_namespace_path_rejected');
  const withoutDrive=value.replace(/^[A-Za-z]:[\\/]/,'');
  if(withoutDrive.includes(':')||withoutDrive.split(/[\\/]/).some(part=>/[. ]$/.test(part)&&part!=='.'))fail('recovery_path_alias_rejected');
 }
 const full=isAbsolute(value)?resolve(value):resolve(sourceRoot,value);
 if(!inside(sourceRoot,full))fail('recovery_resume_path_outside_root');
 if(!['.pdf','.docx'].includes(extname(full).toLowerCase()))fail('recovery_unexpected_resume_extension');
 return full;
}
async function ensureDestination(root){
 await checkPath(dirname(root),true);
 try{await mkdir(root,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
 await checkPath(root,true);
 for await(const _entry of await opendir(root))fail('recovery_destination_not_empty');
}
async function ensureParents(root,file){
 let folder=root;
 for(const part of relative(root,dirname(file)).split(sep).filter(Boolean)){
  folder=join(folder,part);
  try{await mkdir(folder,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  await checkPath(folder,true);
 }
}
async function stableSource(path,handle,expected){
 const byPath=await checkPath(path),byHandle=await handle.stat({bigint:true});regular(byHandle);
 if(!equalStat(byPath,byHandle)||(expected&&!equalStat(expected,byHandle)))fail('recovery_resume_source_changed');
 return byHandle;
}
async function streamHash(handle,buffer){
 const digest=createHash('sha256');let offset=0;
 for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);if(!bytesRead)break;digest.update(buffer.subarray(0,bytesRead));offset+=bytesRead;}
 return {sha256:digest.digest('hex'),bytes:offset};
}
async function streamCopy(source,destination,buffer){
 const digest=createHash('sha256');let offset=0;
 for(;;){
  const {bytesRead}=await source.read(buffer,0,buffer.length,offset);if(!bytesRead)break;
  digest.update(buffer.subarray(0,bytesRead));let written=0;
  while(written<bytesRead){const result=await destination.write(buffer,written,bytesRead-written,offset+written);if(!result.bytesWritten)fail('recovery_resume_write_failed');written+=result.bytesWritten;}
  offset+=bytesRead;
 }
 return {sha256:digest.digest('hex'),bytes:offset};
}
async function copyOne(sourceRoot,destinationRoot,path,counts,buffer){
 const observedStart=now(),relativePath=relative(sourceRoot,path),target=resolve(destinationRoot,relativePath);
 if(!inside(destinationRoot,target))fail('recovery_resume_path_outside_root');
 await checkPath(path);let source,destination;
 try{
  source=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  const before=await stableSource(path,source);
  if(before.size>BigInt(Number.MAX_SAFE_INTEGER))fail('recovery_resume_size_unsupported');
  const sourceBefore=await streamHash(source,buffer);await stableSource(path,source,before);
  if(BigInt(sourceBefore.bytes)!==before.size)fail('recovery_resume_source_changed');
  await ensureParents(destinationRoot,target);await checkPath(dirname(target),true);
  const copyStart=now();destination=await open(target,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW||0),0o600);
  const initialDestination=await stableSource(target,destination);
  const copied=await streamCopy(source,destination,buffer);await destination.sync();const copyEnd=now();
  await stableSource(path,source,before);
  const sourceAfter=await streamHash(source,buffer);await stableSource(path,source,before);
  const destinationState=await stableSource(target,destination);
  if(initialDestination.dev!==destinationState.dev||initialDestination.ino!==destinationState.ino)fail('recovery_resume_destination_changed');
  const destinationHash=await streamHash(destination,buffer);await stableSource(target,destination,destinationState);
  await stableSource(path,source,before);
  if([copied,sourceAfter,destinationHash].some(value=>value.bytes!==sourceBefore.bytes||value.sha256!==sourceBefore.sha256))fail('recovery_resume_hash_mismatch');
  return {relative_path:relativePath.split(sep).join('/'),bytes:sourceBefore.bytes,sha256:sourceBefore.sha256,reference_counts:counts,copy_started_at:copyStart,copy_finished_at:copyEnd,source_observed_started_at:observedStart,source_observed_finished_at:now()};
 }finally{
  const closed=await Promise.allSettled([destination,source].filter(Boolean).map(handle=>handle.close()));
  if(closed.some(result=>result.status==='rejected'))fail('recovery_resume_close_failed');
 }
}

function collectReferences(db,sourceRoot){
 const files=new Map();
 for(const [table,column] of [['applicants','resume_path'],['resume_previous','path']]){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)||!db.prepare('PRAGMA table_info('+table+')').all().some(row=>row.name===column))fail('recovery_resume_schema_missing');
  // Never transfer an unbounded text/blob value from a malformed reference row
  // into JS. Metadata scales with unique files; file byte buffers stay 64 KiB.
  for(const row of db.prepare(`SELECT typeof(${column}) AS kind,CASE WHEN typeof(${column})='text' AND length(${column})<=32767 THEN ${column} ELSE NULL END AS reference FROM ${table}`).iterate()){
   if(row.kind==='null'&&table==='applicants')continue;
   const path=referencePath(sourceRoot,row.reference),key=comparable(path);
   if(!files.has(key))files.set(key,{path,counts:{applicants:0,resume_previous:0}});
   files.get(key).counts[table]++;
  }
 }
 return files;
}

function sanitize(error){
 if(typeof error?.code==='string'&&error.code.startsWith('recovery_'))throw error;
 if(error?.code==='ENOENT')fail('recovery_resume_missing_or_changed');
 fail('recovery_resume_copy_failed');
}

export async function copyReferencedResumes({databasePath,sourceRoot,destinationRoot}){
 let db;
 try{
  const database=absolute(databasePath),source=absolute(sourceRoot),destination=absolute(destinationRoot),started=now();
  if(comparable(source)===comparable(destination)||inside(source,destination)||inside(destination,source))fail('recovery_resume_roots_overlap');
  await checkPath(source,true);const databaseBefore=await checkPath(database);
  db=new DatabaseSync(database,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-512; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; BEGIN');
  const version=db.prepare('PRAGMA data_version').get().data_version,files=collectReferences(db,source);
  await ensureDestination(destination);const buffer=Buffer.allocUnsafe(CHUNK_BYTES),manifest=[];
  for(const file of files.values())manifest.push(await copyOne(source,destination,file.path,file.counts,buffer));
  db.exec('COMMIT');
  if(db.prepare('PRAGMA data_version').get().data_version!==version||!equalStat(databaseBefore,await checkPath(database)))fail('recovery_snapshot_database_changed');
  return {schema_version:1,consistency:'referenced_files_observed_stable_in_interval_only',external_workflows_frozen:false,database_and_resumes_atomic:false,started_at:started,finished_at:now(),files:manifest};
 }catch(error){
  if(db)try{db.exec('ROLLBACK');}catch{}
  sanitize(error);
 }finally{if(db)db.close();}
}

const sameKeys=(object,keys)=>object&&typeof object==='object'&&!Array.isArray(object)&&Object.keys(object).sort().join(',')===[...keys].sort().join(',');
function time(value){const parsed=Date.parse(value);if(typeof value!=='string'||!Number.isFinite(parsed)||new Date(parsed).toISOString()!==value)fail('recovery_resume_manifest_invalid');return parsed;}

// This verifies a copied recovery bundle after the live files have moved or
// disappeared. sourceRoot is a lexical reference boundary only; it is not read.
// The manifest is not signed: authenticate a received bundle separately using a
// previously trusted archive hash. Matching mutable bytes plus a mutable manifest
// alone cannot prove origin or an unobserved point-in-time filesystem snapshot.
export async function verifyReferencedResumes({databasePath,sourceRoot,copyRoot,manifest}){
 let db;
 try{
  const database=absolute(databasePath),source=absolute(sourceRoot),copiedRoot=absolute(copyRoot);
  await checkPath(copiedRoot,true);const databaseBefore=await checkPath(database);
  db=new DatabaseSync(database,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-512; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; BEGIN');
  const version=db.prepare('PRAGMA data_version').get().data_version,referenced=collectReferences(db,source);
  if(!sameKeys(manifest,['schema_version','consistency','external_workflows_frozen','database_and_resumes_atomic','started_at','finished_at','files'])||manifest.schema_version!==1||manifest.consistency!=='referenced_files_observed_stable_in_interval_only'||manifest.external_workflows_frozen!==false||manifest.database_and_resumes_atomic!==false||!Array.isArray(manifest.files)||manifest.files.length!==referenced.size)fail('recovery_resume_manifest_invalid');
  const started=time(manifest.started_at),finished=time(manifest.finished_at);if(finished<started)fail('recovery_resume_manifest_invalid');
  const expected=new Map([...referenced.values()].map(file=>[relative(source,file.path).split(sep).join('/'),file.counts])),seen=new Set(),allowedDirs=new Set(),verifiedStats=new Map(),buffer=Buffer.allocUnsafe(CHUNK_BYTES);
  for(const entry of manifest.files){
   if(!sameKeys(entry,['relative_path','bytes','sha256','reference_counts','copy_started_at','copy_finished_at','source_observed_started_at','source_observed_finished_at'])||typeof entry.relative_path!=='string'||seen.has(entry.relative_path)||!expected.has(entry.relative_path)||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256)||!sameKeys(entry.reference_counts,['applicants','resume_previous'])||entry.reference_counts.applicants!==expected.get(entry.relative_path).applicants||entry.reference_counts.resume_previous!==expected.get(entry.relative_path).resume_previous)fail('recovery_resume_manifest_invalid');
   const times=[started,time(entry.source_observed_started_at),time(entry.copy_started_at),time(entry.copy_finished_at),time(entry.source_observed_finished_at),finished];if(times.some((value,i)=>i&&value<times[i-1]))fail('recovery_resume_manifest_invalid');
   seen.add(entry.relative_path);const path=resolve(copiedRoot,...entry.relative_path.split('/'));if(!inside(copiedRoot,path))fail('recovery_resume_path_outside_root');
   let parent=dirname(path);while(parent!==copiedRoot){allowedDirs.add(comparable(parent));parent=dirname(parent);}
   await checkPath(path);let handle;
   try{handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const before=await stableSource(path,handle),observed=await streamHash(handle,buffer);await stableSource(path,handle,before);if(observed.bytes!==entry.bytes||observed.sha256!==entry.sha256)fail('recovery_resume_copy_hash_mismatch');verifiedStats.set(comparable(path),before);}
   finally{if(handle)await handle.close();}
  }
  async function inspect(folder){
   for await(const entry of await opendir(folder)){
    const path=join(folder,entry.name),stat=await lstat(path,{bigint:true});
    if(stat.isDirectory()){await checkPath(path,true);if(!allowedDirs.has(comparable(path)))fail('recovery_unexpected_copy_path');await inspect(path);}
    else {const fresh=await checkPath(path);if(!seen.has(relative(copiedRoot,path).split(sep).join('/')))fail('recovery_unexpected_copy_path');if(!equalStat(verifiedStats.get(comparable(path)),fresh))fail('recovery_resume_copy_changed');}
   }
  }
  await inspect(copiedRoot);db.exec('COMMIT');
  if(db.prepare('PRAGMA data_version').get().data_version!==version||!equalStat(databaseBefore,await checkPath(database)))fail('recovery_snapshot_database_changed');
  return {verified:true,file_count:seen.size,consistency:manifest.consistency,external_workflows_frozen:false,database_and_resumes_atomic:false};
 }catch(error){if(db)try{db.exec('ROLLBACK');}catch{}sanitize(error);}
 finally{if(db)db.close();}
}
