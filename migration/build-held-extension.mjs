import {cpSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {publicOrigin} from './hosted-deployment.mjs';

export function heldBackground(source,targetOrigin='http://localhost:8080'){
 if(targetOrigin!=='http://localhost:8080')publicOrigin(targetOrigin);
 const substitute=(before,after)=>{if(source.split(before).length!==2)throw Error('extension_source_changed_review_required');source=source.replace(before,after)};
 const old=source.match(/^const environments=.*;\r?$/m)?.[0];
 if(!old)throw Error('extension_environment_configuration_missing');
 substitute(old,'const environments='+JSON.stringify({hosted:{dashboard:targetOrigin+'/assistant',api:targetOrigin+'/api'},local:{dashboard:'http://localhost:8080/assistant',api:'http://localhost:8080/api'}})+';');
 if(targetOrigin!=='http://localhost:8080'){
  const prior="const allowed=['https://marvelous-vitality-production-c2d8.up.railway.app','https://applypilot-jobs.pages.dev','https://applypilot-jobs.netlify.app','http://localhost:8080'];";
  if(source.split(prior).length!==5)throw Error('trusted_dashboard_sites_changed_review_required');
  source=source.replaceAll(prior,'const allowed='+JSON.stringify([targetOrigin,'http://localhost:8080'])+';');
 }
 substitute("async function api(path,method='GET',data){","async function api(path,method='GET',data){\n throw Error('Migration review build is held. No server request was sent.');");
 substitute('async function tick(){','async function tick(){\n return; // Migration review build: no preparation or pending-write replay.');
 substitute('async function initialize(){',"async function initialize(){\n await chrome.storage.local.set({enabled:false,userPaused:true,error:'Migration review build is held. Existing records and device identity are retained.'});return;\n");
 substitute('chrome.runtime.onStartup.addListener(()=>serial(async()=>{await initialize();','chrome.runtime.onStartup.addListener(()=>serial(async()=>{await initialize();return;');
 return source;
}
export function buildHeldExtension(destination,targetOrigin='http://localhost:8080'){
 if(targetOrigin!=='http://localhost:8080')publicOrigin(targetOrigin);
 const target=resolve(destination);if(existsSync(target))throw Error('destination_already_exists');
 const background=heldBackground(readFileSync(new URL('../extension/background.js',import.meta.url),'utf8'),targetOrigin);
 cpSync(new URL('../extension/',import.meta.url),target,{recursive:true,errorOnExist:true,force:false});
 const file=resolve(target,'background.js');writeFileSync(file,background);
 if(targetOrigin!=='http://localhost:8080'){
  const manifestFile=resolve(target,'manifest.json'),manifest=JSON.parse(readFileSync(manifestFile,'utf8'));
  const oldOrigins=new Set(['https://marvelous-vitality-production-c2d8.up.railway.app/*','https://applypilot-jobs.pages.dev/*','https://applypilot-jobs.netlify.app/*']);
  manifest.host_permissions=[...manifest.host_permissions.filter(x=>!oldOrigins.has(x)),targetOrigin+'/*'];
  const bridge=manifest.content_scripts.filter(x=>x.js.includes('dashboard-bridge.js'));
  if(bridge.length!==1)throw Error('dashboard_bridge_configuration_changed');
  bridge[0].matches=[targetOrigin+'/*','http://localhost:8080/*'];
  writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');
 }
 writeFileSync(resolve(target,'MIGRATION-HOLD.json'),JSON.stringify({format:1,target_origin:targetOrigin,held:true,installation_performed:false,requires_reviewed_release:true},null,2)+'\n');
 return {built:true,held:true,installed:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(![3,4].includes(process.argv.length))throw Error('new_output_directory_and_optional_public_origin_required');
 console.log(JSON.stringify(buildHeldExtension(process.argv[2],process.argv[3])));
}
