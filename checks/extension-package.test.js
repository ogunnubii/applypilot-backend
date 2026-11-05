import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inflateRawSync} from 'node:zlib';
import {extensionArchive,EXTENSION_FILES} from '../extension-package.js';
// The packaged helper contains every file the manifest loads, byte for byte.
test('extension package includes every manifest-referenced file and the current version',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url),'utf8'));
 const referenced=new Set([manifest.background.service_worker,manifest.action.default_popup,'policy.js','ready-forms.js',...manifest.content_scripts.flatMap(c=>c.js)]);
 for(const f of referenced)assert(EXTENSION_FILES.includes(f),f);
 const zip=await extensionArchive(),names=[];let at=0;
 while(zip.readUInt32LE(at)===0x04034b50){const size=zip.readUInt32LE(at+18),len=zip.readUInt16LE(at+26),name=zip.subarray(at+30,at+30+len).toString();names.push(name);
  const data=zip.subarray(at+30+len,at+30+len+size);assert.deepEqual(data,await readFile(new URL('../extension/'+name,import.meta.url)),name);at+=30+len+size;}
 assert.deepEqual(names,[...EXTENSION_FILES]);
 assert.equal(manifest.version,'0.7.2');void inflateRawSync;
});

test('manifest grants localhost on any port but injects the dashboard bridge only on ApplyPilot pages',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url),'utf8'));
 assert(manifest.host_permissions.includes('http://localhost/*'));
 assert(!JSON.stringify(manifest).includes('localhost:8080'));
 const bridge=manifest.content_scripts.find(c=>c.js.includes('dashboard-bridge.js'));
 assert.deepEqual(bridge.matches.filter(m=>m.includes('localhost')),['http://localhost/assistant*']);
 for(const c of manifest.content_scripts.filter(c=>!c.js.includes('dashboard-bridge.js')))assert(!c.matches.some(m=>m.includes('localhost')),'no apply scripts on local services');
});
