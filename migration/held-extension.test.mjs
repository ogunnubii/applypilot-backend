import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {heldBackground} from './build-held-extension.mjs';

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
