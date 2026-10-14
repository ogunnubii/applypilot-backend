import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,sep} from 'node:path';
import {heldBackground,buildHeldExtension} from './build-held-extension.mjs';

test('held extension preserves records, pending receipts, environment and device identity while stopping work',async()=>{
 const source=heldBackground(readFileSync(new URL('../extension/background.js',import.meta.url),'utf8'));
 const state={records:{uncertain:{attempted:true,pendingClicks:{one:{phase:'intent'}},phase:'verifying'}},queue:['uncertain'],device:'fictional-device',environment:'hosted',enabled:true,userPaused:false};
 const before=structuredClone(state);const chrome={storage:{local:{set:async values=>Object.assign(state,values)}}};
 const initialize=source.slice(source.indexOf('async function initialize(){'),source.indexOf('async function saveRecord('));
 await new Function('chrome',initialize+';return initialize();')(chrome);
 for(const key of ['records','queue','device','environment'])assert.deepEqual(state[key],before[key]);
 assert.equal(state.enabled,false);assert.equal(state.userPaused,true);
 const api=source.slice(source.indexOf("async function api(path,method='GET',data){"),source.indexOf('async function listedJobs('));
 const call=new Function(api+';return api;')();
 await assert.rejects(call('/jobs'),/No server request was sent/);await assert.rejects(call('/claim','POST',{}),/No server request was sent/);
 assert.match(source,/async function tick\(\)\{\s+return;/);
 assert.match(source,/onStartup.addListener\(\(\)=>serial\(async\(\)=>\{await initialize\(\);return;/);
 assert.doesNotMatch(source.slice(0,source.indexOf('const read=')),/railway\.app/);
});

test('public-host review copy changes exact origin permissions and remains held',()=>{
 const root=mkdtempSync(join(tmpdir(),'applypilot-public-extension-')),target=join(root,'review'),origin='https://fictional.alwaysdata.net';
 try{
  assert.deepEqual(buildHeldExtension(target,origin),{built:true,held:true,installed:false});
  const manifest=JSON.parse(readFileSync(join(target,'manifest.json'),'utf8')),background=readFileSync(join(target,'background.js'),'utf8');
  assert(manifest.host_permissions.includes(origin+'/*'));
  assert(!manifest.host_permissions.some(x=>/railway\.app|pages\.dev|netlify\.app/.test(x)));
  assert.deepEqual(manifest.content_scripts.find(x=>x.js.includes('dashboard-bridge.js')).matches,[origin+'/*','http://localhost:8080/*']);
  assert.equal((background.match(/const allowed=/g)||[]).length,4);
  assert(!background.includes('marvelous-vitality-production-c2d8.up.railway.app'));
  assert.match(background,/Migration review build is held/);assert.match(background,/async function tick\(\)\{\s+return;/);
  assert.equal(JSON.parse(readFileSync(join(target,'MIGRATION-HOLD.json'),'utf8')).target_origin,origin);
 }finally{const r=relative(resolve(tmpdir()),resolve(root));assert(r&&!r.startsWith('..'+sep)&&r!=='..');rmSync(root,{recursive:true,force:true})}
});
