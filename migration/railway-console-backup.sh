#!/bin/sh
# Approved private migration backup only. No downloads, credentials, restart or cutover.
# Requires a coordinated writer freeze for the complete DB+resume interval.
# Node exits before tar/hash. Heap flags are not a cgroup memory limit.
# Usage: sh script.sh ABSOLUTE_DATABASE ABSOLUTE_UPLOADS ABSOLUTE_OUTPUT_PARENT
# The operator must verify these paths; source defaults are not runtime evidence.
set -eu
set -C
umask 077
test "$#" -eq 3 || { printf '%s\n' 'Backup stopped: three_verified_absolute_paths_required'; exit 1; }
for AP_BACKUP_PATH in "$@"; do case "$AP_BACKUP_PATH" in /*) ;; *) printf '%s\n' 'Backup stopped: absolute_backup_paths_required'; exit 1;; esac; done
AP_BACKUP_SOURCE=$1
AP_BACKUP_UPLOADS=$2
AP_BACKUP_OUTPUT_PARENT=$3
test -d "$AP_BACKUP_OUTPUT_PARENT" || { printf '%s\n' 'Backup stopped: output_parent_missing'; exit 1; }
for AP_BACKUP_COMMAND in node tar sha256sum date cat rm df awk wc; do command -v "$AP_BACKUP_COMMAND" >/dev/null || { printf '%s\n' 'Backup stopped: required_tool_missing'; exit 1; }; done
ap_backup_check_memory() {
test -r /sys/fs/cgroup/memory.max && test -r /sys/fs/cgroup/memory.current || { printf '%s\n' 'Backup stopped: cgroup_memory_unavailable'; exit 1; }
AP_BACKUP_LIMIT=$(cat /sys/fs/cgroup/memory.max)
AP_BACKUP_CURRENT=$(cat /sys/fs/cgroup/memory.current)
case "$AP_BACKUP_LIMIT:$AP_BACKUP_CURRENT" in *[!0-9:]*|:*|*:) printf '%s\n' 'Backup stopped: cgroup_memory_not_bounded'; exit 1;; esac
AP_BACKUP_HEADROOM=$((AP_BACKUP_LIMIT-AP_BACKUP_CURRENT))
test "$AP_BACKUP_HEADROOM" -ge 268435456 || { printf '%s\n' 'Backup stopped: insufficient_container_memory_headroom'; exit 1; }
}
ap_backup_check_disk() {
AP_BACKUP_FREE_KIB=$(df -Pk "$AP_BACKUP_OUTPUT_PARENT" | awk 'NR==2 {print $4}')
case "$AP_BACKUP_FREE_KIB" in ''|*[!0-9]*) printf '%s\n' 'Backup stopped: filesystem_space_unavailable'; exit 1;; esac
test "$AP_BACKUP_FREE_KIB" -ge 262144 || { printf '%s\n' 'Backup stopped: insufficient_filesystem_space'; exit 1; }
}
ap_backup_check_memory
ap_backup_check_disk
AP_BACKUP_TARGET="$AP_BACKUP_OUTPUT_PARENT/applypilot-migration-$(date -u +%Y%m%dT%H%M%SZ)-$$"
test ! -e "$AP_BACKUP_TARGET" && test ! -e "$AP_BACKUP_TARGET.tar.gz" || { printf '%s\n' 'Backup stopped: destination_already_exists'; exit 1; }
node --max-old-space-size=24 --max-semi-space-size=1 --input-type=module - --approved-full-state-backup "$AP_BACKUP_SOURCE" "$AP_BACKUP_UPLOADS" "$AP_BACKUP_TARGET" <<'APPLYPILOT_BACKUP_MODULE'
// Offline migration support. Never imports server.js, db.js, credentials or workers.
import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {closeSync,copyFileSync,existsSync,lstatSync,mkdirSync,mkdtempSync,openSync,opendirSync,readFileSync,readSync,readdirSync,realpathSync,rmdirSync,statfsSync,unlinkSync,writeFileSync,writeSync} from 'node:fs';
import {dirname,extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
const {copyReferencedResumes,verifyReferencedResumes}=await (async()=>{
// Recovery checkpoint helper. It only reads the completed snapshot database and
// referenced source files; it never imports app startup or rewrites source paths.
const {DatabaseSync} = await import('node:sqlite');
const {createHash} = await import('node:crypto');
const {constants,realpathSync} = await import('node:fs');
const {lstat,mkdir,open,opendir,statfs} = await import('node:fs/promises');
const {dirname,extname,isAbsolute,join,parse,relative,resolve,sep} = await import('node:path');

const CHUNK_BYTES=64*1024;
const fail=code=>{throw Object.assign(Error(code),{code});};
const now=()=>new Date().toISOString();
const resumeCaps={maxDatabaseBytes:8*1024*1024,maxResumeBytes:53248,maxReferenceRows:1024,maxResumeFiles:64,maxPathBytes:4096,maxReferenceBytes:256*1024,maxPathDepth:32,maxManifestBytes:1024*1024,minFreeBytes:256*1024*1024};
function resourceEnvelope(value){
 if(value===undefined)return null;if(!value||typeof value!=='object'||Array.isArray(value))fail('recovery_resource_limits_invalid');
 const limits={};for(const [key,cap] of Object.entries(resumeCaps)){const n=value[key]??cap;if(!Number.isSafeInteger(n)||n<1||(key==='minFreeBytes'?n<cap:n>cap))fail('recovery_resource_limits_invalid');limits[key]=n;}return limits;
}
async function diskSpace(path,limits){
 if(!limits)return;let fs;try{fs=await statfs(path,{bigint:true});}catch{fail('recovery_resource_disk_unavailable');}
 if(typeof fs.bavail!=='bigint'||typeof fs.bsize!=='bigint'||fs.bavail<0n||fs.bsize<=0n)fail('recovery_resource_disk_unavailable');
 if(fs.bavail*fs.bsize<BigInt(limits.minFreeBytes))fail('recovery_resource_insufficient_disk');
}
function databaseEnvelope(db,stat,limits){
 if(!limits)return;
 if(stat.size>BigInt(limits.maxDatabaseBytes))fail('recovery_resource_database_size');
 if(db.prepare('PRAGMA page_count').get().page_count*db.prepare('PRAGMA page_size').get().page_size>limits.maxDatabaseBytes)fail('recovery_resource_database_size');
}
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
async function streamHash(handle,buffer,maxBytes){
 const digest=createHash('sha256');let offset=0;
 for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);if(!bytesRead)break;if(maxBytes!==undefined&&offset+bytesRead>maxBytes)fail('recovery_resource_resume_growth');digest.update(buffer.subarray(0,bytesRead));offset+=bytesRead;}
 return {sha256:digest.digest('hex'),bytes:offset};
}
async function streamCopy(source,destination,buffer,maxBytes,limits,destinationRoot){
 const digest=createHash('sha256');let offset=0;
 for(;;){
  const {bytesRead}=await source.read(buffer,0,buffer.length,offset);if(!bytesRead)break;
  if(maxBytes!==undefined&&offset+bytesRead>maxBytes)fail('recovery_resource_resume_growth');
  await diskSpace(destinationRoot,limits);
  digest.update(buffer.subarray(0,bytesRead));let written=0;
  while(written<bytesRead){const result=await destination.write(buffer,written,bytesRead-written,offset+written);if(!result.bytesWritten)fail('recovery_resume_write_failed');written+=result.bytesWritten;}
  offset+=bytesRead;
 }
 return {sha256:digest.digest('hex'),bytes:offset};
}
async function copyOne(sourceRoot,destinationRoot,path,counts,buffer,limits,observed){
 const observedStart=now(),relativePath=relative(sourceRoot,path),target=resolve(destinationRoot,relativePath);
 if(!inside(destinationRoot,target))fail('recovery_resume_path_outside_root');
 await checkPath(path);let source,destination;
 try{
  source=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  const before=await stableSource(path,source);
  if(limits&&(!equalStat(before,observed)||before.size>BigInt(limits.maxResumeBytes)))fail('recovery_resource_resume_growth');
  if(before.size>BigInt(Number.MAX_SAFE_INTEGER))fail('recovery_resume_size_unsupported');
  const maxBytes=limits?Number(before.size):undefined;
  const sourceBefore=await streamHash(source,buffer,maxBytes);await stableSource(path,source,before);
  if(BigInt(sourceBefore.bytes)!==before.size)fail('recovery_resume_source_changed');
  await ensureParents(destinationRoot,target);await checkPath(dirname(target),true);
  await diskSpace(dirname(target),limits);
  const copyStart=now();destination=await open(target,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW||0),0o600);
  const initialDestination=await stableSource(target,destination);
  const copied=await streamCopy(source,destination,buffer,maxBytes,limits,destinationRoot);await destination.sync();const copyEnd=now();
  await stableSource(path,source,before);
  const sourceAfter=await streamHash(source,buffer,maxBytes);await stableSource(path,source,before);
  const destinationState=await stableSource(target,destination);
  if(initialDestination.dev!==destinationState.dev||initialDestination.ino!==destinationState.ino)fail('recovery_resume_destination_changed');
  const destinationHash=await streamHash(destination,buffer,maxBytes);await stableSource(target,destination,destinationState);
  await stableSource(path,source,before);
  if([copied,sourceAfter,destinationHash].some(value=>value.bytes!==sourceBefore.bytes||value.sha256!==sourceBefore.sha256))fail('recovery_resume_hash_mismatch');
  return {relative_path:relativePath.split(sep).join('/'),bytes:sourceBefore.bytes,sha256:sourceBefore.sha256,reference_counts:counts,copy_started_at:copyStart,copy_finished_at:copyEnd,source_observed_started_at:observedStart,source_observed_finished_at:now()};
 }finally{
  const closed=await Promise.allSettled([destination,source].filter(Boolean).map(handle=>handle.close()));
  if(closed.some(result=>result.status==='rejected'))fail('recovery_resume_close_failed');
 }
}

function collectReferences(db,sourceRoot,limits){
 const files=new Map();let rows=0,bytes=0;
 for(const [table,column] of [['applicants','resume_path'],['resume_previous','path']]){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)||!db.prepare('PRAGMA table_info('+table+')').all().some(row=>row.name===column))fail('recovery_resume_schema_missing');
  // Never transfer an unbounded text/blob value from a malformed reference row
  // into JS. Metadata scales with unique files; file byte buffers stay 64 KiB.
  for(const row of db.prepare(`SELECT typeof(${column}) AS kind,CASE WHEN typeof(${column})='text' AND length(${column})<=32767 THEN ${column} ELSE NULL END AS reference FROM ${table}`).iterate()){
   if(limits&&++rows>limits.maxReferenceRows)fail('recovery_resource_reference_rows');
   if(row.kind==='null'&&table==='applicants')continue;
   if(limits&&typeof row.reference==='string'){const n=Buffer.byteLength(row.reference);bytes+=n;if(n>limits.maxPathBytes||bytes>limits.maxReferenceBytes)fail('recovery_resource_reference_bytes');}
   const path=referencePath(sourceRoot,row.reference),key=comparable(path);
   if(limits&&(Buffer.byteLength(path)>limits.maxPathBytes||relative(sourceRoot,path).split(sep).length>limits.maxPathDepth))fail('recovery_resource_reference_path');
   if(!files.has(key))files.set(key,{path,counts:{applicants:0,resume_previous:0}});
   if(limits&&files.size>limits.maxResumeFiles)fail('recovery_resource_file_count');
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

async function copyReferencedResumes({databasePath,sourceRoot,destinationRoot,resourceLimits}){
 let db;
 try{
  const limits=resourceEnvelope(resourceLimits);
  const database=absolute(databasePath),source=absolute(sourceRoot),destination=absolute(destinationRoot),started=now();
  if(comparable(source)===comparable(destination)||inside(source,destination)||inside(destination,source))fail('recovery_resume_roots_overlap');
  await checkPath(source,true);const databaseBefore=await checkPath(database);
  if(limits&&databaseBefore.size>BigInt(limits.maxDatabaseBytes))fail('recovery_resource_database_size');
  db=new DatabaseSync(database,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-512; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; BEGIN');
  databaseEnvelope(db,databaseBefore,limits);
  const version=db.prepare('PRAGMA data_version').get().data_version,files=collectReferences(db,source,limits);
  // Discover every distinct file's size before hashing or writing any resume.
  // The same observed stat is checked again immediately before its first read.
  if(limits){let total=0n;for(const file of files.values()){file.observed=await checkPath(file.path);total+=file.observed.size;if(total>BigInt(limits.maxResumeBytes))fail('recovery_resource_resume_bytes');}await diskSpace(dirname(destination),limits);}
  await ensureDestination(destination);const buffer=Buffer.allocUnsafe(CHUNK_BYTES),manifest=[];
  for(const file of files.values())manifest.push(await copyOne(source,destination,file.path,file.counts,buffer,limits,file.observed));
  await diskSpace(destination,limits);
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
async function verifyReferencedResumes({databasePath,sourceRoot,copyRoot,manifest,resourceLimits}){
 let db;
 try{
  const limits=resourceEnvelope(resourceLimits);
  const database=absolute(databasePath),source=absolute(sourceRoot),copiedRoot=absolute(copyRoot);
  await checkPath(copiedRoot,true);const databaseBefore=await checkPath(database);
  if(limits&&databaseBefore.size>BigInt(limits.maxDatabaseBytes))fail('recovery_resource_database_size');
  db=new DatabaseSync(database,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-512; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; BEGIN');
  databaseEnvelope(db,databaseBefore,limits);
  const version=db.prepare('PRAGMA data_version').get().data_version,referenced=collectReferences(db,source,limits);
  if(!sameKeys(manifest,['schema_version','consistency','external_workflows_frozen','database_and_resumes_atomic','started_at','finished_at','files'])||manifest.schema_version!==1||manifest.consistency!=='referenced_files_observed_stable_in_interval_only'||manifest.external_workflows_frozen!==false||manifest.database_and_resumes_atomic!==false||!Array.isArray(manifest.files)||manifest.files.length!==referenced.size)fail('recovery_resume_manifest_invalid');
  const started=time(manifest.started_at),finished=time(manifest.finished_at);if(finished<started)fail('recovery_resume_manifest_invalid');
  if(limits&&manifest.files.reduce((n,row)=>n+(Number.isSafeInteger(row?.bytes)&&row.bytes>=0?row.bytes:Infinity),0)>limits.maxResumeBytes)fail('recovery_resource_resume_bytes');
  const expected=new Map([...referenced.values()].map(file=>[relative(source,file.path).split(sep).join('/'),file.counts])),seen=new Set(),allowedDirs=new Set(),verifiedStats=new Map(),buffer=Buffer.allocUnsafe(CHUNK_BYTES);
  for(const entry of manifest.files){
   if(!sameKeys(entry,['relative_path','bytes','sha256','reference_counts','copy_started_at','copy_finished_at','source_observed_started_at','source_observed_finished_at'])||typeof entry.relative_path!=='string'||seen.has(entry.relative_path)||!expected.has(entry.relative_path)||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256)||!sameKeys(entry.reference_counts,['applicants','resume_previous'])||entry.reference_counts.applicants!==expected.get(entry.relative_path).applicants||entry.reference_counts.resume_previous!==expected.get(entry.relative_path).resume_previous)fail('recovery_resume_manifest_invalid');
   const times=[started,time(entry.source_observed_started_at),time(entry.copy_started_at),time(entry.copy_finished_at),time(entry.source_observed_finished_at),finished];if(times.some((value,i)=>i&&value<times[i-1]))fail('recovery_resume_manifest_invalid');
   seen.add(entry.relative_path);const path=resolve(copiedRoot,...entry.relative_path.split('/'));if(!inside(copiedRoot,path))fail('recovery_resume_path_outside_root');
   let parent=dirname(path);while(parent!==copiedRoot){allowedDirs.add(comparable(parent));parent=dirname(parent);}
   await checkPath(path);let handle;
   try{handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const before=await stableSource(path,handle);if(limits&&before.size!==BigInt(entry.bytes))fail('recovery_resource_resume_growth');const observed=await streamHash(handle,buffer,limits?entry.bytes:undefined);await stableSource(path,handle,before);if(observed.bytes!==entry.bytes||observed.sha256!==entry.sha256)fail('recovery_resume_copy_hash_mismatch');verifiedStats.set(comparable(path),before);}
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
// Opt-in admission envelope, not a peak-RSS/cgroup guarantee. The dense measured
// fixture had 849,000 rows plus two resume rows. Explicit cardinality and spool
// limits prevent a smaller but denser image from silently broadening that case.
export const CONSOLE_RESOURCE_LIMITS=Object.freeze({
 maxDatabaseBytes:8*1024*1024,maxRowBytes:8*1024*1024,maxWalBytes:32*1024*1024,maxShmBytes:1024*1024,
 maxTotalRows:849002,maxTableRows:849000,maxSpoolBytes:96*1024*1024,maxTables:128,maxSchemaObjects:512,maxSchemaBytes:256*1024,maxColumns:128,
 maxResumeBytes:53248,maxReferenceRows:1024,maxResumeFiles:64,maxPathBytes:4096,maxReferenceBytes:256*1024,maxPathDepth:32,
 maxManifestBytes:1024*1024,maxBackupSteps:4096,maxBackupMs:60000,minFreeBytes:256*1024*1024
});
export function normalizeResourceLimits(value){
 if(value===undefined)return null;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(CONSOLE_RESOURCE_LIMITS,k)))fail('resource_limits_invalid');
 const limits={...CONSOLE_RESOURCE_LIMITS,...value};
 for(const [key,n] of Object.entries(limits))if(!Number.isSafeInteger(n)||n<1||(key==='minFreeBytes'?n<CONSOLE_RESOURCE_LIMITS[key]:n>CONSOLE_RESOURCE_LIMITS[key]))fail('resource_limits_invalid');
 return limits;
}
export function assertResourceSpace(path,limits){
 if(!limits)return;
 let fs;try{fs=statfsSync(path,{bigint:true});}catch{fail('resource_disk_unavailable');}
 if(typeof fs.bavail!=='bigint'||typeof fs.bsize!=='bigint'||fs.bavail<0n||fs.bsize<=0n)fail('resource_disk_unavailable');
 if(fs.bavail*fs.bsize<BigInt(limits.minFreeBytes))fail('resource_insufficient_disk');
}
function boundedFile(path,maxBytes,code='resource_database_size'){
 const stat=regular(path);if(!Number.isSafeInteger(stat.size)||stat.size>maxBytes)fail(code);return stat;
}
function sourceSidecars(path,limits){
 if(!limits)return;
 boundedFile(path,limits.maxDatabaseBytes);
 for(const [suffix,limit] of [['-wal',limits.maxWalBytes],['-shm',limits.maxShmBytes]])if(existsSync(path+suffix))boundedFile(path+suffix,limit,'resource_source_sidecar_size');
}
function databaseBytes(db,limits){
 const pages=db.prepare('PRAGMA page_count').get().page_count,size=db.prepare('PRAGMA page_size').get().page_size;
 if(!Number.isSafeInteger(pages)||pages<0||!Number.isSafeInteger(size)||size<512||size>65536||pages*size>limits.maxDatabaseBytes)fail('resource_database_size');
 return size;
}
function databaseEnvelope(db,path,limits){
 if(!limits)return;
 boundedFile(path,limits.maxDatabaseBytes);databaseBytes(db,limits);
 const schema=db.prepare("SELECT count(*) objects,coalesce(sum(length(CAST(coalesce(sql,'') AS BLOB))+length(CAST(name AS BLOB))+length(CAST(tbl_name AS BLOB))),0) bytes,sum(type='table') tables FROM sqlite_master").get();
 if(schema.objects>limits.maxSchemaObjects||schema.bytes>limits.maxSchemaBytes||schema.tables>limits.maxTables)fail('resource_schema_limit');
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND upper(ltrim(sql)) LIKE 'CREATE VIRTUAL TABLE%' LIMIT 1").get())fail('resource_virtual_table');
 let total=0;
 for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").iterate()){
  let columns=0;for(const column of db.prepare('PRAGMA table_xinfo('+quote(name)+')').iterate()){if(++columns>limits.maxColumns)fail('resource_column_limit');if(column.hidden!==0)fail('resource_generated_column');}
  const n=db.prepare('SELECT count(*) n FROM (SELECT 1 FROM '+quote(name)+' LIMIT ?)').get(Math.min(limits.maxTableRows,limits.maxTotalRows-total)+1).n;
  total+=n;if(n>limits.maxTableRows||total>limits.maxTotalRows)fail('resource_row_limit');
 }
}
async function boundedBackup(db,source,destination,limits){
 if(!limits){await backup(db,destination,{rate:16});return;}
 sourceSidecars(source,limits);const pageSize=databaseBytes(db,limits),started=Date.now();let steps=0;
 assertResourceSpace(dirname(destination),limits);
 await backup(db,destination,{rate:16,progress:({totalPages})=>{
  if(!Number.isSafeInteger(totalPages)||totalPages<0||totalPages*pageSize>limits.maxDatabaseBytes)fail('resource_database_growth');
  if(++steps>limits.maxBackupSteps||Date.now()-started>limits.maxBackupMs)fail('resource_backup_budget');
  sourceSidecars(source,limits);databaseBytes(db,limits);assertResourceSpace(dirname(destination),limits);
 }});
 // The final batch may complete without a progress callback; validate its file
 // and logical image before integrity scans, row hashing, or resume inspection.
 boundedFile(destination,limits.maxDatabaseBytes);sourceSidecars(source,limits);
 if(Date.now()-started>limits.maxBackupMs)fail('resource_backup_budget');
 const copied=openReadOnly(destination,limits);try{databaseEnvelope(copied,destination,limits);}finally{copied.close();}
}
// Fixed-size file reads: a large resume/database/archive never becomes one
// Buffer. Row hashing below is bounded by one SQLite row, not a whole table.
export function hashFile(path,{maxBytes}={}){
 if(maxBytes!==undefined)boundedFile(path,maxBytes,'resource_file_size');
 const fd=openSync(path,'r'),buffer=Buffer.allocUnsafe(64*1024),digest=createHash('sha256');
 let total=0;
 try{for(;;){const bytes=readSync(fd,buffer,0,buffer.length,null);if(!bytes)break;total+=bytes;if(maxBytes!==undefined&&total>maxBytes)fail('resource_file_growth');digest.update(buffer.subarray(0,bytes));}return digest.digest('hex');}
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
function openReadOnly(path,limits){regular(path);const db=new DatabaseSync(resolve(path),{readOnly:true});try{db.limits.length=limits?.maxRowBytes??8*1024*1024;if(limits){db.limits.column=limits.maxColumns;db.limits.sqlLength=limits.maxSchemaBytes;}db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; PRAGMA cache_size=-512; PRAGMA mmap_size=0; PRAGMA temp_store=FILE');return db}catch(error){db.close();throw error}}
function inspectConnection(db,spoolParent,limits,databasePath){
 const before=db.prepare('PRAGMA data_version').get().data_version;
 regular(spoolParent,true);
 assertResourceSpace(spoolParent,limits);databaseEnvelope(db,databasePath,limits);
 const spoolFolder=mkdtempSync(join(spoolParent,'.applypilot-hashes-'));
 const spoolPath=join(spoolFolder,'hashes.sqlite');let spool,result;
 db.exec('BEGIN');
 try{
  databaseEnvelope(db,databasePath,limits);
  if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')fail('database_integrity_failed');
  if(db.prepare('PRAGMA foreign_key_check').get())fail('foreign_key_check_failed');
  const schema_digest=hashArray(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").iterate());
  // The disposable private spool contains hashes only, never source row values.
  // Its primary-key B-tree produces the same sorted multiset as format 1, with
  // duplicate hashes retained by n. No JS array or SQLite in-memory sort grows
  // with the number of rows. Cache limits do not claim to bound total RSS.
  spool=new DatabaseSync(spoolPath);
  if(limits){spool.exec('PRAGMA page_size=4096');const cap=Math.floor(limits.maxSpoolBytes/4096);if(cap<2||spool.prepare('PRAGMA max_page_count='+cap).get().max_page_count!==cap)fail('resource_spool_limit');}
  spool.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-512; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; CREATE TABLE hashes(d TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(d,n)) WITHOUT ROWID; BEGIN');
  const insert=spool.prepare('INSERT INTO hashes VALUES(?,?)');
  const tables={};let totalRows=0;
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").iterate()){
   const statement=db.prepare('SELECT * FROM '+quote(name));statement.setReadBigInts(true);
   let rows=0;
   for(const row of statement.iterate()){
    if(limits&&(rows>=limits.maxTableRows||totalRows>=limits.maxTotalRows))fail('resource_row_limit');
    insert.run(rowDigest(row),++rows);totalRows++;
    if(limits&&rows%1024===0){assertResourceSpace(spoolParent,limits);boundedFile(spoolPath,limits.maxSpoolBytes,'resource_spool_limit');}
   }
   if(limits)boundedFile(spoolPath,limits.maxSpoolBytes,'resource_spool_limit');
   Object.defineProperty(tables,name,{value:{rows,digest:hashArray(spool.prepare('SELECT d FROM hashes ORDER BY d,n').iterate(),row=>JSON.stringify(row.d))},enumerable:true,configurable:true,writable:true});
   spool.exec('DELETE FROM hashes');
  }
  result={format:1,schema_digest,tables};db.exec('COMMIT');
 }catch(error){try{db.exec('ROLLBACK')}catch{}if(limits&&error.errcode===13)fail('resource_spool_limit');throw error}
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
export function inspectDatabase(path,{resourceLimits}={}){const limits=normalizeResourceLimits(resourceLimits);if(limits)boundedFile(path,limits.maxDatabaseBytes);const db=openReadOnly(path,limits);try{return inspectConnection(db,dirname(resolve(path)),limits,path)}finally{db.close()}}
export function inspectUploads(root,{resourceLimits}={}){
 const limits=normalizeResourceLimits(resourceLimits);let total=0,pathBytes=0,entries=0;
 regular(root,true);const files=[];
 function walk(folder,depth=0){
  if(limits&&depth>limits.maxPathDepth)fail('resource_path_depth');
  let names;
  if(limits){const directory=opendirSync(folder);names=[];try{for(let entry;(entry=directory.readSync());){if(++entries>limits.maxReferenceRows)fail('resource_upload_limit');names.push(entry.name);}}finally{directory.closeSync();}}
  else names=readdirSync(folder);
  for(const name of names.sort()){
   const path=join(folder,name),stat=lstatSync(path);
   if(stat.isDirectory()){regular(path,true);walk(path,depth+1);continue}
   regular(path);
   if(!['.pdf','.docx'].includes(extname(name).toLowerCase()))fail('unexpected_upload_file_type');
   const relativePath=relative(root,path).split(sep).join('/');total+=stat.size;pathBytes+=Buffer.byteLength(relativePath);
   if(limits&&(files.length>=limits.maxResumeFiles||total>limits.maxResumeBytes||Buffer.byteLength(relativePath)>limits.maxPathBytes||pathBytes>limits.maxReferenceBytes))fail('resource_upload_limit');
   files.push({path:relativePath,size:stat.size});
  }
 }
 walk(resolve(root));return files.map(file=>({...file,sha256:hashFile(join(root,file.path),limits?{maxBytes:file.size}:undefined)}));
}
function emptyDestination(destination,limits){
 const target=resolve(destination);regular(dirname(target),true);
 if(existsSync(target))fail('destination_already_exists');
 assertResourceSpace(dirname(target),limits);
 mkdirSync(target,{mode:0o700});return target;
}
function copyUploads(source,destination,files,limits){
 assertResourceSpace(dirname(destination),limits);
 mkdirSync(destination,{mode:0o700});
 for(const file of files){
  const from=resolve(source,file.path),to=resolve(destination,file.path);
  if(!inside(source,from)||!inside(destination,to))fail('upload_path_outside_root');
  regular(from);mkdirSync(dirname(to),{recursive:true,mode:0o700});
  if(!limits){copyFileSync(from,to);continue;}
  boundedFile(from,file.size,'resource_upload_growth');assertResourceSpace(dirname(to),limits);
  const input=openSync(from,'r'),output=openSync(to,'wx',0o600),buffer=Buffer.allocUnsafe(65536);let total=0;
  try{for(;;){const n=readSync(input,buffer,0,buffer.length,null);if(!n)break;total+=n;if(total>file.size)fail('resource_upload_growth');let written=0;while(written<n){const size=writeSync(output,buffer,written,n-written);if(!size)fail('resource_upload_write');written+=size;}}if(total!==file.size)fail('resource_upload_growth');}
  finally{closeSync(input);closeSync(output);}
 }
}
function readManifest(path,limits){
 if(!limits)return readFileSync(path,'utf8');
 boundedFile(path,limits.maxManifestBytes,'resource_manifest_size');
 const fd=openSync(path,'r'),parts=[];let total=0;
 try{for(;;){const buffer=Buffer.allocUnsafe(Math.min(65536,limits.maxManifestBytes-total+1)),n=readSync(fd,buffer,0,buffer.length,null);if(!n)break;total+=n;if(total>limits.maxManifestBytes)fail('resource_manifest_size');parts.push(buffer.subarray(0,n));}return Buffer.concat(parts,total).toString('utf8');}finally{closeSync(fd);}
}
export async function createSnapshot(source,uploads,destination,{resourceLimits}={}){
 const limits=normalizeResourceLimits(resourceLimits),options=limits?{resourceLimits:limits}:undefined;
 if(inside(uploads,destination)||resolve(uploads)===resolve(destination))fail('snapshot_inside_uploads');
 sourceSidecars(source,limits);const db=openReadOnly(source,limits);
 try{
  const version=db.prepare('PRAGMA data_version').get().data_version;
  if(limits)databaseBytes(db,limits);
  assertResourceSpace(dirname(resolve(destination)),limits);
  const state=inspectConnection(db,dirname(resolve(source)),limits,source),files=inspectUploads(uploads,options),target=emptyDestination(destination,limits);
  // A failed run intentionally retains an incomplete bundle for diagnosis. It
  // cannot pass verifySnapshot and is never automatically restored or deleted.
  writeFileSync(join(target,'INCOMPLETE'),'Do not restore: verification has not completed.\n',{mode:0o600});
  await boundedBackup(db,source,join(target,'database.sqlite'),limits);
  copyUploads(uploads,join(target,'resumes'),files,limits);
  if(db.prepare('PRAGMA data_version').get().data_version!==version||encode(inspectConnection(db,dirname(resolve(source)),limits,source))!==encode(state)||encode(inspectUploads(uploads,options))!==encode(files))fail('source_changed_during_snapshot');
  if(encode(inspectDatabase(join(target,'database.sqlite'),options))!==encode(state)||encode(inspectUploads(join(target,'resumes'),options))!==encode(files))fail('snapshot_verification_failed');
  const manifest={format:1,complete:true,created_at:new Date().toISOString(),database:state,uploads:files,database_sha256:hashFile(join(target,'database.sqlite'),limits?{maxBytes:limits.maxDatabaseBytes}:undefined)};
  if(limits&&Buffer.byteLength(JSON.stringify(manifest,null,2)+'\n')>limits.maxManifestBytes)fail('resource_manifest_size');
  // A crash before removing the marker leaves a bundle that fails closed.
  writeFileSync(join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  assertResourceSpace(target,limits);
  unlinkSync(join(target,'INCOMPLETE'));
  return {complete:true,table_count:Object.keys(state.tables).length,upload_count:files.length};
 }finally{db.close()}
}
export function verifySnapshot(folder,{resourceLimits}={}){
 const limits=normalizeResourceLimits(resourceLimits),options=limits?{resourceLimits:limits}:undefined;
 regular(folder,true);
 if(existsSync(join(folder,'INCOMPLETE')))fail('incomplete_snapshot');
 regular(join(folder,'manifest.json'));regular(join(folder,'database.sqlite'));
 if(limits){boundedFile(join(folder,'manifest.json'),limits.maxManifestBytes,'resource_manifest_size');boundedFile(join(folder,'database.sqlite'),limits.maxDatabaseBytes);}
 const manifest=JSON.parse(readManifest(join(folder,'manifest.json'),limits));
 if(manifest.format!==1||manifest.complete!==true)fail('incomplete_snapshot');
 if(hashFile(join(folder,'database.sqlite'),limits?{maxBytes:limits.maxDatabaseBytes}:undefined)!==manifest.database_sha256)fail('database_file_changed');
 if(encode(inspectDatabase(join(folder,'database.sqlite'),options))!==encode(manifest.database))fail('database_state_changed');
 if(encode(inspectUploads(join(folder,'resumes'),options))!==encode(manifest.uploads))fail('upload_state_changed');
 return manifest;
}
// Recovery checkpoint only: SQLite's backup API supplies a consistent database
// image while source writers continue. Optional resumes come only from references
// in that image, with per-file stability checks. This never freezes an external
// workflow or qualifies a migration/cutover. Source SQL remains read-only.
export async function createRecoverySnapshot(source,destination,{uploadsRoot,resourceLimits}={}){
 const limits=normalizeResourceLimits(resourceLimits),options=limits?{resourceLimits:limits}:undefined;
 if(uploadsRoot&&(inside(uploadsRoot,destination)||resolve(uploadsRoot)===resolve(destination)))fail('snapshot_inside_uploads');
 sourceSidecars(source,limits);const db=openReadOnly(source,limits);
 try{
  if(limits)databaseBytes(db,limits);
  const target=emptyDestination(destination,limits);
  writeFileSync(join(target,'INCOMPLETE'),'Recovery snapshot is not verified.\n',{mode:0o600});
  const database_started_at=new Date().toISOString();
  await boundedBackup(db,source,join(target,'database.sqlite'),limits);
  const database_completed_at=new Date().toISOString();
  const database=inspectDatabase(join(target,'database.sqlite'),options);
  const uploads=uploadsRoot?await copyReferencedResumes({databasePath:join(target,'database.sqlite'),sourceRoot:uploadsRoot,destinationRoot:join(target,'resumes'),...(limits?{resourceLimits:limits}:{})}):null;
  const manifest={format:1,kind:'sqlite-recovery',complete:true,created_at:new Date().toISOString(),database_started_at,database_completed_at,uploads_included:!!uploads,external_workflows_frozen:false,database_and_resumes_atomic:false,database,uploads_root:uploadsRoot?resolve(uploadsRoot):null,uploads,database_sha256:hashFile(join(target,'database.sqlite'),limits?{maxBytes:limits.maxDatabaseBytes}:undefined)};
  if(limits&&Buffer.byteLength(JSON.stringify(manifest,null,2)+'\n')>limits.maxManifestBytes)fail('resource_manifest_size');
  writeFileSync(join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  assertResourceSpace(target,limits);
  unlinkSync(join(target,'INCOMPLETE'));
  return {complete:true,kind:manifest.kind,table_count:Object.keys(manifest.database.tables).length,upload_count:uploads?.files.length??0,uploads_included:!!uploads,external_workflows_frozen:false,database_and_resumes_atomic:false};
 }finally{db.close()}
}
export async function verifyRecoverySnapshot(folder,{resourceLimits}={}){
 const limits=normalizeResourceLimits(resourceLimits),options=limits?{resourceLimits:limits}:undefined;
 regular(folder,true);if(existsSync(join(folder,'INCOMPLETE')))fail('incomplete_snapshot');
 regular(join(folder,'manifest.json'));regular(join(folder,'database.sqlite'));
 if(limits){boundedFile(join(folder,'manifest.json'),limits.maxManifestBytes,'resource_manifest_size');boundedFile(join(folder,'database.sqlite'),limits.maxDatabaseBytes);}
 const m=JSON.parse(readManifest(join(folder,'manifest.json'),limits));
 if(m.format!==1||m.kind!=='sqlite-recovery'||m.complete!==true||typeof m.uploads_included!=='boolean'||m.external_workflows_frozen!==false||m.database_and_resumes_atomic!==false)fail('invalid_recovery_snapshot');
 if(hashFile(join(folder,'database.sqlite'),limits?{maxBytes:limits.maxDatabaseBytes}:undefined)!==m.database_sha256||encode(inspectDatabase(join(folder,'database.sqlite'),options))!==encode(m.database))fail('recovery_verification_failed');
 if(m.uploads_included)await verifyReferencedResumes({databasePath:join(folder,'database.sqlite'),sourceRoot:m.uploads_root,copyRoot:join(folder,'resumes'),manifest:m.uploads,...(limits?{resourceLimits:limits}:{})});
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
 if(approval!=="--approved-full-state-backup")fail('full_state_backup_approval_required');
 if(!source||!uploads||!target||!isAbsolute(source)||!isAbsolute(uploads)||!isAbsolute(target))fail('absolute_backup_paths_required');
 const result=await createSnapshot(source,uploads,target,{resourceLimits:CONSOLE_RESOURCE_LIMITS});
 console.log(JSON.stringify({snapshot_ready:true,...result,target,source_rows_modified:false,peak_rss_kib:process.resourceUsage().maxRSS}));
}catch(error){console.error('Backup stopped: '+(/^[a-z_]+$/.test(error.message)?error.message:'private_input_unavailable'));process.exitCode=1}

APPLYPILOT_BACKUP_MODULE
# Native Node has now exited; archive/hash processes do not overlap its RSS.
ap_backup_check_memory
ap_backup_check_disk
printf '%s\n' 'Archive has not completed.' > "$AP_BACKUP_TARGET/ARCHIVE_INCOMPLETE"
tar -czf - -C "$AP_BACKUP_TARGET" database.sqlite resumes manifest.json > "$AP_BACKUP_TARGET.tar.gz"
AP_BACKUP_ARCHIVE_BYTES=$(wc -c < "$AP_BACKUP_TARGET.tar.gz" | awk '{print $1}')
case "$AP_BACKUP_ARCHIVE_BYTES" in ''|*[!0-9]*) printf '%s\n' 'Backup stopped: archive_size_unavailable'; exit 1;; esac
test "$AP_BACKUP_ARCHIVE_BYTES" -le 16777216 || { printf '%s\n' 'Backup stopped: archive_outside_resource_envelope'; exit 1; }
tar -tzf "$AP_BACKUP_TARGET.tar.gz" >/dev/null
AP_BACKUP_HASH=$(sha256sum "$AP_BACKUP_TARGET.tar.gz")
AP_BACKUP_HASH=${AP_BACKUP_HASH%% *}
rm -- "$AP_BACKUP_TARGET/ARCHIVE_INCOMPLETE"
printf '{"backup_ready":true,"kind":"migration-snapshot","archive":"%s","sha256":"%s","source_rows_modified":false,"requires_coordinated_freeze":true}\n' "$AP_BACKUP_TARGET.tar.gz" "$AP_BACKUP_HASH"
