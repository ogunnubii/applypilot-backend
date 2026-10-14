// Run only in a NEW private scratch directory on a candidate host. Uses synthetic
// data, performs no network calls, reads no env secrets, and leaves its fixture
// for operator inspection. Never points at the restored or production database.
import {DatabaseSync} from 'node:sqlite';
import {existsSync,lstatSync,mkdirSync,realpathSync,statfsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {localDurableFilesystem} from './hosted-deployment.mjs';
import {sameApplication} from '../application-dedup.js';
const fail=code=>{throw Error(code)};
const register=db=>db.function('same_application',{deterministic:true},(ac,at,au,bc,bt,bu)=>Number(sameApplication({company:ac,title:at,url:au},{company:bc,title:bt,url:bu})));
export function probeHost(destination){
 const folder=resolve(destination),parent=dirname(folder);
 if(existsSync(folder))fail('probe_destination_must_not_exist');
 const stat=lstatSync(parent),same=process.platform==='win32'?s=>s.toLowerCase():s=>s;
 if(!stat.isDirectory()||stat.isSymbolicLink()||same(realpathSync(parent))!==same(parent))fail('probe_parent_must_be_regular');
 mkdirSync(folder,{mode:0o700});const path=join(folder,'synthetic.sqlite');
 let first=new DatabaseSync(path),second;
 const result={synthetic_only:true,node_24_or_later:Number(process.versions.node.split('.')[0])>=24,linux:process.platform==='linux',local_filesystem:localDurableFilesystem(statfsSync(folder).type)};
 try{
  first.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=50;');register(first);
  first.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);
   CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),company TEXT,title TEXT,url TEXT,status TEXT);
   CREATE TRIGGER duplicate_fence BEFORE UPDATE OF status ON jobs WHEN NEW.status='queued' AND EXISTS(SELECT 1 FROM jobs old WHERE old.id!=NEW.id AND old.status='uncertain' AND same_application(NEW.company,NEW.title,NEW.url,old.company,old.title,old.url)) BEGIN SELECT RAISE(ABORT,'synthetic_duplicate_blocked'); END;
   INSERT INTO users VALUES('fictional');
   INSERT INTO jobs VALUES('uncertain','fictional','Fictional Inc','Engineer','https://jobs.lever.co/fictional/role','uncertain');
   INSERT INTO jobs VALUES('retry','fictional','Fictional Inc','Engineer','https://jobs.lever.co/fictional/role','saved');`);
  result.wal=first.prepare('PRAGMA journal_mode').get().journal_mode==='wal';
  try{first.prepare('INSERT INTO jobs(id,user_id) VALUES(?,?)').run('invalid','missing');result.foreign_keys=false}catch(e){result.foreign_keys=/FOREIGN KEY/.test(e.message)}
  second=new DatabaseSync(path);second.exec('PRAGMA busy_timeout=50; PRAGMA foreign_keys=ON');register(second);
  first.exec('BEGIN IMMEDIATE');
  first.exec("UPDATE jobs SET title='Transient fictional value' WHERE id='uncertain'");
  try{second.exec('BEGIN IMMEDIATE');second.exec('ROLLBACK');result.single_writer=false}catch(e){result.single_writer=/locked|busy/i.test(e.message)}
  result.isolated_read=second.prepare("SELECT title FROM jobs WHERE id='uncertain'").get().title==='Engineer';
  first.exec('ROLLBACK');second.close();second=undefined;first.close();first=new DatabaseSync(path);register(first);
  result.rollback_survives_reopen=first.prepare("SELECT title FROM jobs WHERE id='uncertain'").get().title==='Engineer';
  try{first.exec("UPDATE jobs SET status='queued' WHERE id='retry'");result.duplicate_fence=false}catch(e){result.duplicate_fence=/synthetic_duplicate_blocked/.test(e.message)}
  result.history_retained=first.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('saved','uncertain')").get().n===2;
  for(const command of ['pdftotext','pdftoppm'])result[command]=spawnSync(command,['-v'],{stdio:'pipe',windowsHide:true,timeout:5000}).status===0;
  result.storage_semantics_verified=['wal','foreign_keys','single_writer','isolated_read','rollback_survives_reopen','duplicate_fence','history_retained'].every(k=>result[k]===true);
  result.host_ready=false; // TLS, provider durability, memory and PDF rendering need separate evidence.
  return result;
 }finally{try{second?.close()}finally{first.close()}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{if(process.argv.length!==3)fail('new_private_probe_directory_required');console.log(JSON.stringify(probeHost(process.argv[2])))}
 catch(error){console.error('Host probe stopped: '+(/^[a-z_]+$/.test(error.message)?error.message:'candidate_runtime_check_failed'));process.exitCode=1}
}
