import {cpSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function heldBackground(source){
 const substitute=(before,after)=>{if(source.split(before).length!==2)throw Error('extension_source_changed_review_required');source=source.replace(before,after)};
 const old=source.match(/^const environments=.*;\r?$/m)?.[0];
 if(!old)throw Error('extension_environment_configuration_missing');
 substitute(old,"const environments={hosted:{dashboard:'http://localhost:8080/assistant',api:'http://localhost:8080/api'},local:{dashboard:'http://localhost:8080/assistant',api:'http://localhost:8080/api'}};");
 substitute("async function api(path,method='GET',data){","async function api(path,method='GET',data){\n throw Error('Migration review build is held. No server request was sent.');");
 substitute('async function tick(){','async function tick(){\n return; // Migration review build: no preparation or pending-write replay.');
 substitute('async function initialize(){',"async function initialize(){\n await chrome.storage.local.set({enabled:false,userPaused:true,error:'Migration review build is held. Existing records and device identity are retained.'});return;\n");
 substitute('chrome.runtime.onStartup.addListener(()=>serial(async()=>{await initialize();','chrome.runtime.onStartup.addListener(()=>serial(async()=>{await initialize();return;');
 return source;
}
export function buildHeldExtension(destination){
 const target=resolve(destination);if(existsSync(target))throw Error('destination_already_exists');
 cpSync(new URL('../extension/',import.meta.url),target,{recursive:true,errorOnExist:true,force:false});
 const file=resolve(target,'background.js');writeFileSync(file,heldBackground(readFileSync(file,'utf8')));
 writeFileSync(resolve(target,'MIGRATION-HOLD.json'),JSON.stringify({format:1,target_origin:'http://localhost:8080',held:true,installation_performed:false,requires_reviewed_release:true},null,2)+'\n');
 return {built:true,held:true,installed:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv.length!==3)throw Error('one_new_output_directory_required');
 console.log(JSON.stringify(buildHeldExtension(process.argv[2])));
}
