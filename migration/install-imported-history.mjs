import {DatabaseSync} from 'node:sqlite';
import {constants,copyFileSync,existsSync,lstatSync,realpathSync,writeFileSync,unlinkSync} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import {hashFile,inspectDatabase} from './state-snapshot.mjs';
import {GUARD_SCHEMA_SQL} from './turso-guard/guard-schema.mjs';
import {importNativeHistory} from './turso-guard/history-import.mjs';
import {registerNativeFunctions} from '../database/native-functions.js';
import {BOUNDARY_MARKER_DENY_SQL,NATIVE_HISTORY_BOUNDARY_SQL} from '../database/imported-history-boundary.js';

const fail=code=>{throw Error(code);};
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function regular(path,directory=false){
 const s=lstatSync(path);if(s.isSymbolicLink()||!(directory?s.isDirectory():s.isFile()&&s.nlink===1)||!samePath(realpathSync(path),path))fail('import_path_not_regular');
}
// Trusted offline installer client only; never passed to application handlers.
function installerClient(engine){return {async transaction(){
 engine.exec('BEGIN IMMEDIATE');let closed=false;
 return {get closed(){return closed;},async execute(input){const {sql,args=[]}=typeof input==='string'?{sql:input}:input,stmt=engine.prepare(sql);stmt.setReadBigInts(true);return stmt.columns().length?{rows:stmt.all(...args)}:{...stmt.run(...args),rows:[]};},async executeMultiple(sql){engine.exec(sql);},async commit(){engine.exec('COMMIT');closed=true;},async rollback(){if(engine.isTransaction)engine.exec('ROLLBACK');closed=true;},close(){if(engine.isTransaction)engine.exec('ROLLBACK');closed=true;}};
}};}

// Explicitly creates a NEW offline native verification copy. Never accepts an
// existing target, opens a remote database, starts a server/worker, changes an
// origin or copies credentials into logs/public metadata. Real source bundles
// contain private runtime data and require separately authorized operator care.
// Resume files/paths and remote schema qualification remain separate gates.
export async function installImportedHistory({databasePath,manifest,targetPath}){
 if(!isAbsolute(databasePath)||!isAbsolute(targetPath))fail('absolute_import_paths_required');
 const source=resolve(databasePath),target=resolve(targetPath);regular(source);regular(dirname(target),true);
 if(existsSync(target)||existsSync(target+'.INCOMPLETE'))fail('new_import_target_required');
 if(existsSync(source+'-wal')&&lstatSync(source+'-wal').size)fail('completed_snapshot_required');
 if(manifest?.format!==1||manifest.complete!==true||hashFile(source)!==manifest.database_sha256||JSON.stringify(inspectDatabase(source))!==JSON.stringify(manifest.database))fail('source_snapshot_verification_failed');
 writeFileSync(target+'.INCOMPLETE','Offline history import incomplete. Application startup is blocked.\n',{flag:'wx',mode:0o600});
 copyFileSync(source,target,constants.COPYFILE_EXCL);
 if(hashFile(target)!==manifest.database_sha256||JSON.stringify(inspectDatabase(target))!==JSON.stringify(manifest.database))fail('copied_runtime_state_mismatch');
 const db=new DatabaseSync(target);registerNativeFunctions(db);db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=0;');
 try{
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name IN ('guard_accounts','runtime_history_boundary')").get())fail('source_already_has_import_boundary');
  const accounts=db.prepare('SELECT id FROM users ORDER BY id').all();if(accounts.length>1000)fail('import_account_limit');
  db.exec('BEGIN IMMEDIATE');try{
   db.exec(GUARD_SCHEMA_SQL);
   db.exec("CREATE TABLE runtime_history_boundary(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL CHECK(schema_version=1),source_sha256 TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('importing','complete')))" );
   db.prepare("INSERT INTO runtime_history_boundary VALUES(1,1,?,'importing')").run(manifest.database_sha256);
   db.exec(BOUNDARY_MARKER_DENY_SQL+NATIVE_HISTORY_BOUNDARY_SQL);
   for(const {id} of accounts)db.prepare('INSERT INTO guard_accounts(user_id,stopped) VALUES(?,1)').run(id);
   db.exec('COMMIT');
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  let projected=0;
  for(const {id} of accounts){const result=await importNativeHistory({client:installerClient(db),databasePath:source,manifest,userId:id});if(!result.complete)fail('history_import_incomplete');projected+=result.rows;}
  if(hashFile(source)!==manifest.database_sha256||existsSync(source+'-wal')&&lstatSync(source+'-wal').size)fail('source_changed_during_import');
  db.exec('BEGIN IMMEDIATE');try{
   if(db.prepare('SELECT 1 FROM guard_history_import_status WHERE pending!=0 OR completed<1 OR source_snapshot_sha IS NULL').get())fail('history_import_incomplete');
   db.exec("DROP TRIGGER runtime_history_marker_no_update;UPDATE runtime_history_boundary SET phase='complete' WHERE id=1;CREATE TRIGGER runtime_history_marker_no_update BEFORE UPDATE ON runtime_history_boundary BEGIN SELECT RAISE(ABORT,'immutable_import_boundary');END;COMMIT;");
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok'||db.prepare('PRAGMA foreign_key_check').get())fail('imported_state_integrity_failed');
  unlinkSync(target+'.INCOMPLETE');
  return {complete:true,native_history_integrated:true,account_count:accounts.length,projected_rows:projected,accounts_stopped:true,application_started:false,remote_runtime_qualified:false,resume_paths_rewritten:false};
 }finally{db.close();}
}
