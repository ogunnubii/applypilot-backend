// Native Linux/SQLite public-host candidate. No remote provisioner and no secrets
// loader. Preflight is read-only; activation is a separate, approved operator step.
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,lstatSync,readFileSync,realpathSync,statfsSync,writeFileSync} from 'node:fs';
import {isIP} from 'node:net';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inspectDatabase,inspectUploads,verifySnapshot} from './state-snapshot.mjs';
import {acquireRuntimeLock} from './local-deployment.mjs';
import {resolveResumePath} from '../storage-paths.js';
const fail=code=>{throw Error(code)};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const inside=(a,b)=>{const r=relative(resolve(a),resolve(b));return !r||r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r)};
function regular(path,directory=false){
 const stat=lstatSync(path),same=process.platform==='win32'?s=>s.toLowerCase():s=>s;
 if(stat.isSymbolicLink()||(directory?!stat.isDirectory():!stat.isFile()||stat.nlink!==1)||same(realpathSync(path))!==same(resolve(path)))fail('linked_or_invalid_hosted_path');
}
export function publicOrigin(value){
 let url;try{url=new URL(value)}catch{fail('public_https_origin_required')}
 if(url.protocol!=='https:'||url.origin!==value||url.username||url.password||url.port||isIP(url.hostname)||!url.hostname.includes('.')||url.hostname.endsWith('.localhost')||url.hostname.endsWith('.local'))fail('public_https_origin_required');
 return url.origin;
}
export function validateHostedConfig(c){
 if(c?.format!==1||!['alwaysdata','oci'].includes(c.provider))fail('supported_public_host_required');
 publicOrigin(c.public_origin);
 if(!isAbsolute(c.data_dir||'')||!isAbsolute(c.source_bundle||'')||!hash(c.source_manifest_sha256)||!c.legacy_upload_dir)fail('verified_private_storage_required');
 if(!Number.isInteger(c.port)||c.port<1024||c.port>65535||!isIP(c.bind_host))fail('explicit_proxy_listener_required');
 if(c.local_browser_only!==true||c.background_work!==false)fail('initial_hosted_execution_must_be_paused');
 if(inside(c.data_dir,c.source_bundle)||inside(c.source_bundle,c.data_dir))fail('runtime_and_backup_must_be_separate');
 regular(c.data_dir,true);regular(c.source_bundle,true);return c;
}
export const hostedConfigDigest=c=>digest(JSON.stringify({format:c.format,provider:c.provider,data_dir:resolve(c.data_dir),source_bundle:resolve(c.source_bundle),source_manifest_sha256:c.source_manifest_sha256,legacy_upload_dir:c.legacy_upload_dir,public_origin:c.public_origin,bind_host:c.bind_host,port:c.port,local_browser_only:c.local_browser_only,background_work:c.background_work}));
export function hostedPreflight(config){
 const c=validateHostedConfig(config),manifest=join(c.source_bundle,'manifest.json');regular(manifest);
 if(digest(readFileSync(manifest))!==c.source_manifest_sha256)fail('source_manifest_mismatch');
 if(existsSync(join(c.data_dir,'INCOMPLETE')))fail('incomplete_restore');
 const database=join(c.data_dir,'database.sqlite'),uploads=join(c.data_dir,'resumes'),state=inspectDatabase(database),files=inspectUploads(uploads);
 const db=new DatabaseSync(database,{readOnly:true});let references=0;
 try{
  for(const [table,column] of [['applicants','resume_path'],['resume_previous','path']]){
   if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))fail('resume_schema_missing');
   for(const r of db.prepare('SELECT '+column+' AS path FROM '+table+' WHERE '+column+' IS NOT NULL').all()){regular(resolveResumePath(r.path,{root:uploads,legacyRoot:c.legacy_upload_dir}));references++}
  }
 }finally{db.close()}
 const marker=join(c.data_dir,'ACTIVE-HOSTED-DEPLOYMENT.json');let activated=false;
 if(existsSync(marker)){
  regular(marker);const receipt=JSON.parse(readFileSync(marker,'utf8'));
  if(receipt.format!==1||receipt.config_digest!==hostedConfigDigest(c))fail('active_hosted_identity_mismatch');activated=true;
 }else{
  const baseline=verifySnapshot(c.source_bundle);
  if(JSON.stringify(state)!==JSON.stringify(baseline.database)||JSON.stringify(files)!==JSON.stringify(baseline.uploads))fail('restored_state_mismatch');
 }
 return {state_verified:true,activated,table_count:Object.keys(state.tables).length,resume_references:references,background_work:false,hosted_browser:false,host_platform_verified:process.platform==='linux'};
}
export function hostedEnvironment(config,approval,env={}){
 const c=validateHostedConfig(config);
 const gates=['source_writers_frozen','backup_verified','same_extension_transition_reviewed','chrome_helper_stopped','ap2_stopped','secrets_provisioning_approved','cutover_approved','host_account_approved','durable_local_filesystem_verified','host_pdf_and_memory_test_passed','public_tls_and_proxy_verified'];
 if(approval?.format!==1||approval.config_digest!==hostedConfigDigest(c)||gates.some(g=>approval[g]!==true))fail('explicit_hosted_cutover_approval_required');
 if(typeof env.SESSION_SECRET!=='string'||env.SESSION_SECRET.length<32||typeof env.REGISTRATION_CODE!=='string'||!env.REGISTRATION_CODE)fail('existing_identity_configuration_required');
 return {...env,DATABASE_PATH:join(c.data_dir,'database.sqlite'),UPLOAD_DIR:join(c.data_dir,'resumes'),LEGACY_UPLOAD_DIR:c.legacy_upload_dir,PORT:String(c.port),BIND_HOST:c.bind_host,PUBLIC_ORIGIN:c.public_origin,SERVICE_ORIGIN:c.public_origin,LOCAL_BROWSER_ONLY:'true',APPLYPILOT_BACKGROUND_TASKS:'paused',PUBLIC_SIGNUP:'false'};
}
export function localDurableFilesystem(type){return [0xef53,0x58465342,0x9123683e,0x2fc12fc1].includes(Number(type))}
export async function activateHosted(config,approval,env=process.env){
 if(process.platform!=='linux'||Number(process.versions.node.split('.')[0])<24)fail('linux_node_twenty_four_required');
 const prepared=hostedEnvironment(config,approval,env);
 // Reject tmpfs, NFS, CIFS, overlay and unknown storage. The operator must also
 // verify that this local filesystem is provider-persistent, not an ephemeral disk.
 if(!localDurableFilesystem(statfsSync(config.data_dir).type))fail('supported_local_persistent_filesystem_required');
 const release=acquireRuntimeLock(config.data_dir);
 try{
  hostedPreflight(config);const marker=join(config.data_dir,'ACTIVE-HOSTED-DEPLOYMENT.json');
  if(!existsSync(marker))writeFileSync(marker,JSON.stringify({format:1,config_digest:hostedConfigDigest(config)})+'\n',{flag:'wx',mode:0o600});
  Object.assign(process.env,prepared);process.once('exit',release);await import('../start.js');
 }catch(error){release();throw error}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const [command='preflight',file,approvalFile]=process.argv.slice(2);if(!file)fail('configuration_file_required');regular(file);
  const config=JSON.parse(readFileSync(file,'utf8'));
  if(command==='preflight'&&!approvalFile)console.log(JSON.stringify({...hostedPreflight(config),config_digest:hostedConfigDigest(config)}));
  else if(command==='activate'&&approvalFile){regular(approvalFile);await activateHosted(config,JSON.parse(readFileSync(approvalFile,'utf8')))}
  else fail('use_preflight_or_explicit_activate');
 }catch(error){console.error('Hosted deployment stopped: '+(/^[a-z_]+$/.test(error.message)?error.message:'invalid_or_unavailable_private_input'));process.exitCode=1}
}
