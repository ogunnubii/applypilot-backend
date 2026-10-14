// Offline migration support. Never imports server.js, db.js, credentials or workers.
import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {closeSync,copyFileSync,existsSync,lstatSync,mkdirSync,mkdtempSync,openSync,opendirSync,readFileSync,readSync,readdirSync,realpathSync,rmdirSync,statfsSync,unlinkSync,writeFileSync,writeSync} from 'node:fs';
import {dirname,extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {copyReferencedResumes,verifyReferencedResumes} from './recovery-resumes.mjs';

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
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const [command,...args]=process.argv.slice(2);let result;
  if(command==='inspect'&&args.length===1)result=inspectDatabase(args[0]);
  else if(command==='snapshot'&&args.length===3)result=await createSnapshot(...args);
  else if(command==='recovery'&&args.length===3)result=await createRecoverySnapshot(args[0],args[2],{uploadsRoot:args[1]});
  else if(command==='verify-recovery'&&args.length===1){const m=await verifyRecoverySnapshot(args[0]);result={verified:true,kind:m.kind,table_count:Object.keys(m.database.tables).length,upload_count:m.uploads?.files.length??0,external_workflows_frozen:false,database_and_resumes_atomic:false}}
  else if(command==='verify'&&args.length===1){const m=verifySnapshot(args[0]);result={verified:true,table_count:Object.keys(m.database.tables).length,upload_count:m.uploads.length}}
  else if(command==='restore'&&args.length===2)result=restoreToEmpty(...args);
  else fail('usage: inspect database | snapshot database uploads NEW-folder | recovery database uploads NEW-folder | verify bundle | verify-recovery bundle | restore bundle NEW-folder');
  console.log(JSON.stringify(result));
 }catch(error){console.error('Migration operation failed; no application was started. '+(/^[a-z_]+$/.test(error.message)?error.message:'Check private local inputs.'));process.exitCode=1}
}
