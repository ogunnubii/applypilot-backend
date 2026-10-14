// This entry point never reads an env file or creates credentials. Its default
// command is a read-only preflight. Activation is a later, explicit operator step.
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {closeSync,existsSync,lstatSync,openSync,readFileSync,realpathSync,unlinkSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inspectDatabase,inspectUploads,verifySnapshot} from './state-snapshot.mjs';
import {resolveResumePath} from '../storage-paths.js';

const fail=code=>{throw Error(code)};
const digest=data=>createHash('sha256').update(data).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const validHash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function regular(path,directory=false){
 const stat=lstatSync(path),actual=realpathSync(path),expected=resolve(path);
 if(stat.isSymbolicLink()||(directory?!stat.isDirectory():!stat.isFile()||stat.nlink!==1)||actual.toLowerCase()!==expected.toLowerCase())fail('linked_or_invalid_deployment_path');
}
export function validateConfig(config){
 if(config?.format!==1||!isAbsolute(config.data_dir||'')||!isAbsolute(config.source_bundle||''))fail('absolute_private_data_paths_required');
 if(config.public_origin!=='http://localhost:8080'||config.bind_host!=='127.0.0.1'||config.port!==8080||config.local_browser_only!==true)fail('only_loopback_pc_deployment_supported');
 if(config.background_work!==false)fail('background_work_must_remain_paused');
 if(!validHash(config.source_manifest_sha256)||!config.legacy_upload_dir)fail('verified_source_manifest_and_upload_root_required');
 regular(config.data_dir,true);regular(config.source_bundle,true);
 const r=relative(resolve(config.source_bundle),resolve(config.data_dir));
 if(!r||(!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r)))fail('runtime_must_be_separate_from_backup');
 return config;
}
function configDigest(c){return digest(JSON.stringify({format:c.format,data_dir:resolve(c.data_dir),source_manifest_sha256:c.source_manifest_sha256,public_origin:c.public_origin,legacy_upload_dir:c.legacy_upload_dir,background_work:c.background_work}))}
function checkResumeReferences(dbPath,root,legacyRoot){
 const db=new DatabaseSync(dbPath,{readOnly:true});let references=0;
 try{
  for(const [table,column] of [['applicants','resume_path'],['resume_previous','path']]){
   if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))fail('resume_schema_missing');
   for(const row of db.prepare('SELECT '+column+' AS path FROM '+table+' WHERE '+column+' IS NOT NULL').all()){
    const path=resolveResumePath(row.path,{root,legacyRoot});regular(path);references++;
   }
  }
 }finally{db.close()}
 return references;
}
export function preflight(config){
 const c=validateConfig(config),manifestPath=join(c.source_bundle,'manifest.json');regular(manifestPath);
 if(digest(readFileSync(manifestPath))!==c.source_manifest_sha256)fail('source_manifest_mismatch');
 const database=join(c.data_dir,'database.sqlite'),uploads=join(c.data_dir,'resumes'),receipt=join(c.data_dir,'ACTIVE-DEPLOYMENT.json');
 if(existsSync(join(c.data_dir,'INCOMPLETE')))fail('incomplete_restore');
 // Opening read-only ensures that a missing path cannot initialize a blank DB.
 const state=inspectDatabase(database);inspectUploads(uploads);
 const resume_references=checkResumeReferences(database,uploads,c.legacy_upload_dir);
 let activated=false;
 if(existsSync(receipt)){
  regular(receipt);const old=JSON.parse(readFileSync(receipt,'utf8'));
  if(old.format!==1||old.config_digest!==configDigest(c)||old.source_manifest_sha256!==c.source_manifest_sha256)fail('active_deployment_identity_mismatch');
  activated=true;
 }else{
  const baseline=verifySnapshot(c.source_bundle);
  if(!same(state,baseline.database)||!same(inspectUploads(uploads),baseline.uploads))fail('restored_state_mismatch');
 }
 return {ready:true,activated,table_count:Object.keys(state.tables).length,resume_references,background_work:false,hosted_browser:false};
}
export function activationEnvironment(config,approval,env={}){
 validateConfig(config);
 if(approval?.format!==1||approval.source_manifest_sha256!==config.source_manifest_sha256||approval.target_origin!==config.public_origin||approval.source_writers_frozen!==true||approval.backup_verified!==true||approval.same_extension_transition_reviewed!==true||approval.chrome_helper_stopped!==true||approval.ap2_stopped!==true||approval.secrets_provisioning_approved!==true||approval.cutover_approved!==true)fail('explicit_cutover_approval_required');
 if(typeof env.SESSION_SECRET!=='string'||env.SESSION_SECRET.length<32||typeof env.REGISTRATION_CODE!=='string'||!env.REGISTRATION_CODE)fail('existing_identity_configuration_required');
 return {...env,DATABASE_PATH:join(config.data_dir,'database.sqlite'),UPLOAD_DIR:join(config.data_dir,'resumes'),LEGACY_UPLOAD_DIR:config.legacy_upload_dir,PORT:'8080',BIND_HOST:'127.0.0.1',PUBLIC_ORIGIN:config.public_origin,SERVICE_ORIGIN:config.public_origin,LOCAL_BROWSER_ONLY:'true',APPLYPILOT_BACKGROUND_TASKS:'paused',PUBLIC_SIGNUP:'false'};
}
export function acquireRuntimeLock(dataDir){
 const path=join(dataDir,'api-runtime.lock');let fd;
 try{fd=openSync(path,'wx',0o600)}catch{fail('runtime_already_locked_operator_review_required')}
 writeFileSync(fd,JSON.stringify({pid:process.pid,started_at:new Date().toISOString()})+'\n');
 let released=false;return ()=>{if(!released){released=true;closeSync(fd);unlinkSync(path)}};
}
export async function activate(config,approval,env=process.env){
 const prepared=activationEnvironment(config,approval,env);
 const release=acquireRuntimeLock(config.data_dir);
 try{
  preflight(config);
  const marker=join(config.data_dir,'ACTIVE-DEPLOYMENT.json');
  if(!existsSync(marker))writeFileSync(marker,JSON.stringify({format:1,config_digest:configDigest(config),source_manifest_sha256:config.source_manifest_sha256})+'\n',{flag:'wx',mode:0o600});
  Object.assign(process.env,prepared);process.once('exit',release);
  await import('../start.js');
 }catch(error){release();throw error}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const [command='preflight',file,approvalFile]=process.argv.slice(2);
  if(!file)fail('configuration_file_required');regular(file);
  const config=JSON.parse(readFileSync(file,'utf8'));
  if(command==='preflight'&&!approvalFile)console.log(JSON.stringify(preflight(config)));
  else if(command==='activate'&&approvalFile){regular(approvalFile);await activate(config,JSON.parse(readFileSync(approvalFile,'utf8')))}
  else fail('use_preflight_or_explicit_activate');
 }catch(error){console.error('Local deployment stopped: '+(/^[a-z_]+$/.test(error.message)?error.message:'invalid_or_unavailable_private_input'));process.exitCode=1}
}
