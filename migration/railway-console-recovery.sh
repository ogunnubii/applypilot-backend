#!/bin/sh
# Approved private recovery backup only. No downloads, credentials, restart or cutover.
# Online SQLite + individually stable referenced resumes; no global freeze inferred.
# Node exits before tar/hash. Heap flags are not a cgroup memory limit.
set -eu
set -C
umask 077
for AP_BACKUP_COMMAND in node tar sha256sum date cat rm; do command -v "$AP_BACKUP_COMMAND" >/dev/null || { printf '%s\n' 'Backup stopped: required_tool_missing'; exit 1; }; done
ap_backup_check_memory() {
test -r /sys/fs/cgroup/memory.max && test -r /sys/fs/cgroup/memory.current || { printf '%s\n' 'Backup stopped: cgroup_memory_unavailable'; exit 1; }
AP_BACKUP_LIMIT=$(cat /sys/fs/cgroup/memory.max)
AP_BACKUP_CURRENT=$(cat /sys/fs/cgroup/memory.current)
case "$AP_BACKUP_LIMIT:$AP_BACKUP_CURRENT" in *[!0-9:]*|:*|*:) printf '%s\n' 'Backup stopped: cgroup_memory_not_bounded'; exit 1;; esac
AP_BACKUP_HEADROOM=$((AP_BACKUP_LIMIT-AP_BACKUP_CURRENT))
test "$AP_BACKUP_HEADROOM" -ge 100663296 || { printf '%s\n' 'Backup stopped: insufficient_container_memory_headroom'; exit 1; }
}
ap_backup_check_memory
AP_BACKUP_TARGET="/app/data/applypilot-recovery-$(date -u +%Y%m%dT%H%M%SZ)-$$"
test ! -e "$AP_BACKUP_TARGET" && test ! -e "$AP_BACKUP_TARGET.tar.gz" || { printf '%s\n' 'Backup stopped: destination_already_exists'; exit 1; }
node --max-old-space-size=24 --max-semi-space-size=1 --input-type=module - --approved-sqlite-recovery-backup /app/data/applypilot.sqlite /app/data/resumes "$AP_BACKUP_TARGET" <<'APPLYPILOT_BACKUP_MODULE'
// Offline migration support. Never imports server.js, db.js, credentials or workers.
import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {closeSync,copyFileSync,existsSync,lstatSync,mkdirSync,mkdtempSync,openSync,readFileSync,readSync,readdirSync,realpathSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
const {copyReferencedResumes,verifyReferencedResumes}=await (async()=>{
// Recovery checkpoint helper. It only reads the completed snapshot database and
// referenced source files; it never imports app startup or rewrites source paths.
const {DatabaseSync} = await import('node:sqlite');
const {createHash} = await import('node:crypto');
const {constants,realpathSync} = await import('node:fs');
const {lstat,mkdir,open,opendir} = await import('node:fs/promises');
const {dirname,extname,isAbsolute,join,parse,relative,resolve,sep} = await import('node:path');

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

async function copyReferencedResumes({databasePath,sourceRoot,destinationRoot}){
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
async function verifyReferencedResumes({databasePath,sourceRoot,copyRoot,manifest}){
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

return {copyReferencedResumes,verifyReferencedResumes};
})();

const fail=code=>{throw Error(code)};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const encode=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?{integer:String(v)}:v instanceof Uint8Array?{blob:Buffer.from(v).toString('hex')}:v);
const quote=name=>'"'+name.replaceAll('"','""')+'"';
const inside=(root,path)=>{const r=relative(resolve(root),resolve(path));return r!==''&&!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r)};
// Fixed-size file reads: a large resume/database/archive never becomes one
// Buffer. Row hashing below is bounded by one SQLite row, not a whole table.
export function hashFile(path){
 const fd=openSync(path,'r'),buffer=Buffer.allocUnsafe(64*1024),digest=createHash('sha256');
 try{for(;;){const bytes=readSync(fd,buffer,0,buffer.length,null);if(!bytes)break;digest.update(buffer.subarray(0,bytes));}return digest.digest('hex');}
 finally{closeSync(fd);}
}
function hashArray(values,serialize=encode){
 const digest=createHash('sha256');digest.update('[');let first=true;
 for(const value of values){if(!first)digest.update(',');if(serialize===encode)hashEncoded(digest,value);else digest.update(serialize(value));first=false;}
 digest.update(']');return digest.digest('hex');
}
// Byte-for-byte equivalent to encode(), without making one enormous JSON/hex
// string. SQLite still materializes a single row; its own row limit and the
// process/cgroup memory preflight remain relevant. Do not call this constant RSS.
function hashEncoded(digest,value){
 if(typeof value==='bigint'){digest.update('{"integer":'+JSON.stringify(String(value))+'}');return;}
 if(value instanceof Uint8Array){
  digest.update('{"blob":"');
  for(let offset=0;offset<value.byteLength;offset+=32*1024)digest.update(Buffer.from(value.buffer,value.byteOffset+offset,Math.min(32*1024,value.byteLength-offset)).toString('hex'));
  digest.update('"}');return;
 }
 if(typeof value==='string'){
  digest.update('"');let offset=0;
  while(offset<value.length){let end=Math.min(value.length,offset+32*1024);
   if(end<value.length&&value.charCodeAt(end-1)>=0xd800&&value.charCodeAt(end-1)<=0xdbff&&value.charCodeAt(end)>=0xdc00&&value.charCodeAt(end)<=0xdfff)end--;
   digest.update(JSON.stringify(value.slice(offset,end)).slice(1,-1));offset=end;
  }
  digest.update('"');return;
 }
 if(Array.isArray(value)){digest.update('[');value.forEach((item,index)=>{if(index)digest.update(',');hashEncoded(digest,item);});digest.update(']');return;}
 if(value&&typeof value==='object'){digest.update('{');Object.keys(value).forEach((key,index)=>{if(index)digest.update(',');digest.update(JSON.stringify(key)+':');hashEncoded(digest,value[key]);});digest.update('}');return;}
 digest.update(JSON.stringify(value));
}
function rowDigest(row){const digest=createHash('sha256');hashEncoded(digest,Object.keys(row).sort().map(k=>[k,row[k]]));return digest.digest('hex');}
function regular(path,directory=false){
 const value=resolve(path),stat=lstatSync(value);
 if(stat.isSymbolicLink()||(!directory&&(!stat.isFile()||stat.nlink!==1))||(directory&&!stat.isDirectory()))fail('linked_or_invalid_path');
 const real=realpathSync(value);
 if((process.platform==='win32'?real.toLowerCase():real)!==(process.platform==='win32'?value.toLowerCase():value))fail('linked_parent_path');
 return stat;
}
function openReadOnly(path){regular(path);const db=new DatabaseSync(resolve(path),{readOnly:true});db.limits.length=8*1024*1024;db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; PRAGMA cache_size=-512; PRAGMA mmap_size=0; PRAGMA temp_store=FILE');return db}
function inspectConnection(db,spoolParent){
 const before=db.prepare('PRAGMA data_version').get().data_version;
 regular(spoolParent,true);
 const spoolFolder=mkdtempSync(join(spoolParent,'.applypilot-hashes-'));
 const spoolPath=join(spoolFolder,'hashes.sqlite');let spool,result;
 db.exec('BEGIN');
 try{
  if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')fail('database_integrity_failed');
  if(db.prepare('PRAGMA foreign_key_check').get())fail('foreign_key_check_failed');
  const schema_digest=hashArray(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").iterate());
  // The disposable private spool contains hashes only, never source row values.
  // Its primary-key B-tree produces the same sorted multiset as format 1, with
  // duplicate hashes retained by n. No JS array or SQLite in-memory sort grows
  // with the number of rows. Cache limits do not claim to bound total RSS.
  spool=new DatabaseSync(spoolPath);
  spool.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-512; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; CREATE TABLE hashes(d TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(d,n)) WITHOUT ROWID; BEGIN');
  const insert=spool.prepare('INSERT INTO hashes VALUES(?,?)');
  const tables={};
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").iterate()){
   const statement=db.prepare('SELECT * FROM '+quote(name));statement.setReadBigInts(true);
   let rows=0;
   for(const row of statement.iterate())insert.run(rowDigest(row),++rows);
   tables[name]={rows,digest:hashArray(spool.prepare('SELECT d FROM hashes ORDER BY d,n').iterate(),row=>JSON.stringify(row.d))};
   spool.exec('DELETE FROM hashes');
  }
  result={format:1,schema_digest,tables};db.exec('COMMIT');
 }catch(error){try{db.exec('ROLLBACK')}catch{}throw error}
 finally{
  if(spool)spool.close();
  // Exact owned names only; never recursively remove a computed directory.
  if(!inside(spoolParent,spoolFolder)||!inside(spoolFolder,spoolPath))fail('invalid_spool_cleanup_path');
  if(existsSync(spoolPath)){regular(spoolPath);unlinkSync(spoolPath);}
  rmdirSync(spoolFolder);
 }
 if(db.prepare('PRAGMA data_version').get().data_version!==before)fail('source_changed_during_inspection');
 return result;
}
export function inspectDatabase(path){const db=openReadOnly(path);try{return inspectConnection(db,dirname(resolve(path)))}finally{db.close()}}
export function inspectUploads(root){
 regular(root,true);const files=[];
 function walk(folder){
  for(const name of readdirSync(folder).sort()){
   const path=join(folder,name),stat=lstatSync(path);
   if(stat.isDirectory()){regular(path,true);walk(path);continue}
   regular(path);
   if(!['.pdf','.docx'].includes(extname(name).toLowerCase()))fail('unexpected_upload_file_type');
   files.push({path:relative(root,path).split(sep).join('/'),size:stat.size,sha256:hashFile(path)});
  }
 }
 walk(resolve(root));return files;
}
function emptyDestination(destination){
 const target=resolve(destination);regular(dirname(target),true);
 if(existsSync(target))fail('destination_already_exists');
 mkdirSync(target,{mode:0o700});return target;
}
function copyUploads(source,destination,files){
 mkdirSync(destination,{mode:0o700});
 for(const file of files){
  const from=resolve(source,file.path),to=resolve(destination,file.path);
  if(!inside(source,from)||!inside(destination,to))fail('upload_path_outside_root');
  regular(from);mkdirSync(dirname(to),{recursive:true,mode:0o700});copyFileSync(from,to);
 }
}
export async function createSnapshot(source,uploads,destination){
 if(inside(uploads,destination)||resolve(uploads)===resolve(destination))fail('snapshot_inside_uploads');
 const db=openReadOnly(source);
 try{
  const version=db.prepare('PRAGMA data_version').get().data_version;
  const state=inspectConnection(db,dirname(resolve(source))),files=inspectUploads(uploads),target=emptyDestination(destination);
  // A failed run intentionally retains an incomplete bundle for diagnosis. It
  // cannot pass verifySnapshot and is never automatically restored or deleted.
  writeFileSync(join(target,'INCOMPLETE'),'Do not restore: verification has not completed.\n',{mode:0o600});
  await backup(db,join(target,'database.sqlite'),{rate:16});
  copyUploads(uploads,join(target,'resumes'),files);
  if(db.prepare('PRAGMA data_version').get().data_version!==version||encode(inspectConnection(db,dirname(resolve(source))))!==encode(state)||encode(inspectUploads(uploads))!==encode(files))fail('source_changed_during_snapshot');
  if(encode(inspectDatabase(join(target,'database.sqlite')))!==encode(state)||encode(inspectUploads(join(target,'resumes')))!==encode(files))fail('snapshot_verification_failed');
  const manifest={format:1,complete:true,created_at:new Date().toISOString(),database:state,uploads:files,database_sha256:hashFile(join(target,'database.sqlite'))};
  // A crash before removing the marker leaves a bundle that fails closed.
  writeFileSync(join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  unlinkSync(join(target,'INCOMPLETE'));
  return {complete:true,table_count:Object.keys(state.tables).length,upload_count:files.length};
 }finally{db.close()}
}
export function verifySnapshot(folder){
 regular(folder,true);
 if(existsSync(join(folder,'INCOMPLETE')))fail('incomplete_snapshot');
 regular(join(folder,'manifest.json'));regular(join(folder,'database.sqlite'));
 const manifest=JSON.parse(readFileSync(join(folder,'manifest.json'),'utf8'));
 if(manifest.format!==1||manifest.complete!==true)fail('incomplete_snapshot');
 if(hashFile(join(folder,'database.sqlite'))!==manifest.database_sha256)fail('database_file_changed');
 if(encode(inspectDatabase(join(folder,'database.sqlite')))!==encode(manifest.database))fail('database_state_changed');
 if(encode(inspectUploads(join(folder,'resumes')))!==encode(manifest.uploads))fail('upload_state_changed');
 return manifest;
}
// Recovery checkpoint only: SQLite's backup API supplies a consistent database
// image while source writers continue. Optional resumes come only from references
// in that image, with per-file stability checks. This never freezes an external
// workflow or qualifies a migration/cutover. Source SQL remains read-only.
export async function createRecoverySnapshot(source,destination,{uploadsRoot}={}){
 if(uploadsRoot&&(inside(uploadsRoot,destination)||resolve(uploadsRoot)===resolve(destination)))fail('snapshot_inside_uploads');
 const db=openReadOnly(source);
 try{
  const target=emptyDestination(destination);
  writeFileSync(join(target,'INCOMPLETE'),'Recovery snapshot is not verified.\n',{mode:0o600});
  const database_started_at=new Date().toISOString();
  await backup(db,join(target,'database.sqlite'),{rate:16});
  const database_completed_at=new Date().toISOString();
  const database=inspectDatabase(join(target,'database.sqlite'));
  const uploads=uploadsRoot?await copyReferencedResumes({databasePath:join(target,'database.sqlite'),sourceRoot:uploadsRoot,destinationRoot:join(target,'resumes')}):null;
  const manifest={format:1,kind:'sqlite-recovery',complete:true,created_at:new Date().toISOString(),database_started_at,database_completed_at,uploads_included:!!uploads,external_workflows_frozen:false,database_and_resumes_atomic:false,database,uploads_root:uploadsRoot?resolve(uploadsRoot):null,uploads,database_sha256:hashFile(join(target,'database.sqlite'))};
  writeFileSync(join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  unlinkSync(join(target,'INCOMPLETE'));
  return {complete:true,kind:manifest.kind,table_count:Object.keys(manifest.database.tables).length,upload_count:uploads?.files.length??0,uploads_included:!!uploads,external_workflows_frozen:false,database_and_resumes_atomic:false};
 }finally{db.close()}
}
export async function verifyRecoverySnapshot(folder){
 regular(folder,true);if(existsSync(join(folder,'INCOMPLETE')))fail('incomplete_snapshot');
 regular(join(folder,'manifest.json'));regular(join(folder,'database.sqlite'));
 const m=JSON.parse(readFileSync(join(folder,'manifest.json'),'utf8'));
 if(m.format!==1||m.kind!=='sqlite-recovery'||m.complete!==true||typeof m.uploads_included!=='boolean'||m.external_workflows_frozen!==false||m.database_and_resumes_atomic!==false)fail('invalid_recovery_snapshot');
 if(hashFile(join(folder,'database.sqlite'))!==m.database_sha256||encode(inspectDatabase(join(folder,'database.sqlite')))!==encode(m.database))fail('recovery_verification_failed');
 if(m.uploads_included)await verifyReferencedResumes({databasePath:join(folder,'database.sqlite'),sourceRoot:m.uploads_root,copyRoot:join(folder,'resumes'),manifest:m.uploads});
 return m;
}
export function restoreToEmpty(folder,destination){
 if(inside(folder,destination)||resolve(folder)===resolve(destination))fail('restore_inside_snapshot');
 const manifest=verifySnapshot(folder),target=emptyDestination(destination);
 writeFileSync(join(target,'INCOMPLETE'),'Do not use: restore verification has not completed.\n',{mode:0o600});
 copyFileSync(join(folder,'database.sqlite'),join(target,'database.sqlite'));
 copyUploads(join(folder,'resumes'),join(target,'resumes'),manifest.uploads);
 if(encode(inspectDatabase(join(target,'database.sqlite')))!==encode(manifest.database)||encode(inspectUploads(join(target,'resumes')))!==encode(manifest.uploads))fail('restore_verification_failed');
 const result={restored:true,table_count:Object.keys(manifest.database.tables).length,upload_count:manifest.uploads.length,application_started:false,resume_paths_rewritten:false};
 writeFileSync(join(target,'RESTORE-VERIFIED.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
 unlinkSync(join(target,'INCOMPLETE'));return result;
}

try{
 const [approval,source,uploads,target]=process.argv.slice(2);
 if(approval!=="--approved-sqlite-recovery-backup")fail('full_state_backup_approval_required');
 if(!source||!uploads||!target||!isAbsolute(source)||!isAbsolute(uploads)||!isAbsolute(target))fail('absolute_backup_paths_required');
 const result=await createRecoverySnapshot(source,target,{uploadsRoot:uploads});
 console.log(JSON.stringify({snapshot_ready:true,...result,target,source_rows_modified:false,peak_rss_kib:process.resourceUsage().maxRSS}));
}catch(error){console.error('Backup stopped: '+(/^[a-z_]+$/.test(error.message)?error.message:'private_input_unavailable'));process.exitCode=1}

APPLYPILOT_BACKUP_MODULE
# Native Node has now exited; archive/hash processes do not overlap its RSS.
ap_backup_check_memory
printf '%s\n' 'Archive has not completed.' > "$AP_BACKUP_TARGET/ARCHIVE_INCOMPLETE"
tar -czf - -C "$AP_BACKUP_TARGET" database.sqlite resumes manifest.json > "$AP_BACKUP_TARGET.tar.gz"
tar -tzf "$AP_BACKUP_TARGET.tar.gz" >/dev/null
AP_BACKUP_HASH=$(sha256sum "$AP_BACKUP_TARGET.tar.gz")
AP_BACKUP_HASH=${AP_BACKUP_HASH%% *}
rm -- "$AP_BACKUP_TARGET/ARCHIVE_INCOMPLETE"
printf '{"backup_ready":true,"kind":"sqlite-recovery","archive":"%s","sha256":"%s","source_rows_modified":false,"external_workflows_frozen":false}\n' "$AP_BACKUP_TARGET.tar.gz" "$AP_BACKUP_HASH"
