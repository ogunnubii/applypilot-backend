// Offline migration support. Never imports server.js, db.js, credentials or workers.
import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const fail=code=>{throw Error(code)};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const encode=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?{integer:String(v)}:v instanceof Uint8Array?{blob:Buffer.from(v).toString('hex')}:v);
const quote=name=>'"'+name.replaceAll('"','""')+'"';
const inside=(root,path)=>{const r=relative(resolve(root),resolve(path));return r!==''&&!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r)};
function regular(path,directory=false){
 const value=resolve(path),stat=lstatSync(value);
 if(stat.isSymbolicLink()||(!directory&&(!stat.isFile()||stat.nlink!==1))||(directory&&!stat.isDirectory()))fail('linked_or_invalid_path');
 const real=realpathSync(value);
 if((process.platform==='win32'?real.toLowerCase():real)!==(process.platform==='win32'?value.toLowerCase():value))fail('linked_parent_path');
 return stat;
}
function openReadOnly(path){regular(path);const db=new DatabaseSync(resolve(path),{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');return db}
function inspectConnection(db){
 const before=db.prepare('PRAGMA data_version').get().data_version;
 db.exec('BEGIN');let result;
 try{
  if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')fail('database_integrity_failed');
  if(db.prepare('PRAGMA foreign_key_check').all().length)fail('foreign_key_check_failed');
  const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all();
  const tables={};
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()){
   const statement=db.prepare('SELECT * FROM '+quote(name));statement.setReadBigInts(true);
   const rows=statement.all().map(row=>hash(encode(Object.keys(row).sort().map(k=>[k,row[k]])))).sort();
   tables[name]={rows:rows.length,digest:hash(encode(rows))};
  }
  result={format:1,schema_digest:hash(encode(schema)),tables};db.exec('COMMIT');
 }catch(error){try{db.exec('ROLLBACK')}catch{}throw error}
 if(db.prepare('PRAGMA data_version').get().data_version!==before)fail('source_changed_during_inspection');
 return result;
}
export function inspectDatabase(path){const db=openReadOnly(path);try{return inspectConnection(db)}finally{db.close()}}
export function inspectUploads(root){
 regular(root,true);const files=[];
 function walk(folder){
  for(const name of readdirSync(folder).sort()){
   const path=join(folder,name),stat=lstatSync(path);
   if(stat.isDirectory()){regular(path,true);walk(path);continue}
   regular(path);
   if(!['.pdf','.docx'].includes(extname(name).toLowerCase()))fail('unexpected_upload_file_type');
   const bytes=readFileSync(path);
   files.push({path:relative(root,path).split(sep).join('/'),size:bytes.length,sha256:hash(bytes)});
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
  const state=inspectConnection(db),files=inspectUploads(uploads),target=emptyDestination(destination);
  // A failed run intentionally retains an incomplete bundle for diagnosis. It
  // cannot pass verifySnapshot and is never automatically restored or deleted.
  writeFileSync(join(target,'INCOMPLETE'),'Do not restore: verification has not completed.\n',{mode:0o600});
  await backup(db,join(target,'database.sqlite'));
  copyUploads(uploads,join(target,'resumes'),files);
  if(db.prepare('PRAGMA data_version').get().data_version!==version||encode(inspectConnection(db))!==encode(state)||encode(inspectUploads(uploads))!==encode(files))fail('source_changed_during_snapshot');
  if(encode(inspectDatabase(join(target,'database.sqlite')))!==encode(state)||encode(inspectUploads(join(target,'resumes')))!==encode(files))fail('snapshot_verification_failed');
  const manifest={format:1,complete:true,created_at:new Date().toISOString(),database:state,uploads:files,database_sha256:hash(readFileSync(join(target,'database.sqlite')))};
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
 if(hash(readFileSync(join(folder,'database.sqlite')))!==manifest.database_sha256)fail('database_file_changed');
 if(encode(inspectDatabase(join(folder,'database.sqlite')))!==encode(manifest.database))fail('database_state_changed');
 if(encode(inspectUploads(join(folder,'resumes')))!==encode(manifest.uploads))fail('upload_state_changed');
 return manifest;
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
  else if(command==='verify'&&args.length===1){const m=verifySnapshot(args[0]);result={verified:true,table_count:Object.keys(m.database.tables).length,upload_count:m.uploads.length}}
  else if(command==='restore'&&args.length===2)result=restoreToEmpty(...args);
  else fail('usage: inspect database | snapshot database uploads NEW-folder | verify bundle | restore bundle NEW-folder');
  console.log(JSON.stringify(result));
 }catch(error){console.error('Migration operation failed; no application was started. '+(/^[a-z_]+$/.test(error.message)?error.message:'Check private local inputs.'));process.exitCode=1}
}
