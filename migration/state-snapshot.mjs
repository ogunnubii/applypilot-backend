// Offline migration support. Never imports server.js, db.js, credentials or workers.
import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {closeSync,copyFileSync,existsSync,lstatSync,mkdirSync,mkdtempSync,openSync,readFileSync,readSync,readdirSync,realpathSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {copyReferencedResumes,verifyReferencedResumes} from './recovery-resumes.mjs';

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
