const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('list and connection checks bypass a stuck mutation while mutations remain serialized',async()=>{
 let listener;const noop={addListener(){}};
 const chrome={runtime:{onMessage:{addListener(fn){listener=fn}},onStartup:noop,onInstalled:noop},alarms:{onAlarm:noop},tabs:{onRemoved:noop}};
 const ctx=vm.createContext({chrome,importScripts(){},ApplyPilotPolicy:{}});
 vm.runInContext(fs.readFileSync('extension/background.js','utf8')+';chain=new Promise(()=>{});handle=async m=>m.action;',ctx);
 const read=action=>new Promise(resolve=>listener({action},{},resolve));
 assert.equal((await read('list')).data,'list');assert.equal((await read('dashboard-status')).data,'dashboard-status');
 let mutated=false;listener({action:'open'},{},()=>{mutated=true});await Promise.resolve();assert.equal(mutated,false);
});
test('popup timeout exits Loading, allows retry, and ignores a stale response',async()=>{
 const {JSDOM}=require('jsdom');const dom=new JSDOM(fs.readFileSync('extension/popup.html','utf8'),{runScripts:'outside-only'}),w=dom.window;
 let timeout;const responses=[];w.setTimeout=fn=>{timeout=fn;return 1};w.clearTimeout=()=>{};
 w.chrome={runtime:{sendMessage:()=>new Promise(resolve=>responses.push(resolve))}};w.ApplyPilotPolicy={attentionOrder:()=>[],supported:()=>true};
 w.eval(fs.readFileSync('extension/ready-forms.js','utf8'));w.eval(fs.readFileSync('extension/popup.js','utf8'));timeout();await new Promise(r=>setImmediate(r));
 assert.match(w.document.querySelector('#message').textContent,/too long/);
 w.document.querySelector('#refresh').click();responses[1]({ok:true,data:{state:{enabled:true,queue:[]},jobs:[{id:'new',title:'New job',company:'Employer',ready_form:{source:'hosted',checked_at:Date.now(),expires_at:Date.now()+60000}}]}});await new Promise(r=>setImmediate(r));
 assert.match(w.document.querySelector('#jobs').textContent,/New job/);
 responses[0]({ok:true,data:{state:{queue:[]},jobs:[]}});await new Promise(r=>setImmediate(r));assert.match(w.document.querySelector('#jobs').textContent,/New job/);w.close();
});

test('read requests prefer active dashboards and skip a frozen tab without retrying writes',async()=>{
 const noop={addListener(){}};let calls=[];const chrome={storage:{local:{get:async()=>({device:'fixture'})}},tabs:{query:async()=>[{id:1,active:false},{id:2,active:true}],onRemoved:noop},runtime:{onMessage:noop,onStartup:noop,onInstalled:noop},alarms:{onAlarm:noop},scripting:{executeScript:async({target})=>{calls.push(target.tabId);if(target.tabId===2)return new Promise(()=>{});return [{result:{data:{jobs:[]}}}];}}};
 const ctx=vm.createContext({chrome,URL,importScripts(){},ApplyPilotPolicy:{},setTimeout:fn=>setTimeout(fn,1),clearTimeout});vm.runInContext(fs.readFileSync('extension/background.js','utf8')+';globalThis.fetchJobs=()=>api("/jobs");',ctx);
 assert.deepEqual(Array.from((await ctx.fetchJobs()).jobs),[]);assert.deepEqual(calls,[2,1]);
});


test('writes skip a frozen dashboard before dispatch and never replay an uncertain write',async()=>{
 const noop={addListener(){}};const calls=[];let failWrite=false;
 const chrome={storage:{local:{get:async()=>({device:'fixture'})}},tabs:{query:async()=>[{id:1,active:true},{id:2}],onRemoved:noop},runtime:{onMessage:noop,onStartup:noop,onInstalled:noop},alarms:{onAlarm:noop},scripting:{executeScript:async({target,args})=>{calls.push({id:target.tabId,write:!!args});if(!args)return target.tabId===1?new Promise(()=>{}):[{result:{ready:true}}];return failWrite?new Promise(()=>{}):[{result:{data:{saved:true}}}];}}};
 const ctx=vm.createContext({chrome,URL,importScripts(){},ApplyPilotPolicy:{},setTimeout:fn=>setTimeout(fn,1),clearTimeout});vm.runInContext(fs.readFileSync('extension/background.js','utf8')+';globalThis.save=()=>api("/jobs/a/local/progress","POST",{});',ctx);
 assert.equal((await ctx.save()).saved,true);assert.deepEqual(calls,[{id:1,write:false},{id:2,write:false},{id:2,write:true}]);
 calls.length=0;failWrite=true;await assert.rejects(ctx.save(),/did not acknowledge/);assert.equal(calls.filter(c=>c.write).length,1,'a dispatched write must never be replayed');
});

test('the responsive dashboard remains preferred when employer tab becomes active',async()=>{
 const noop={addListener(){}};const calls=[];const chrome={storage:{local:{get:async()=>({device:'fixture'})}},tabs:{query:async()=>[{id:1},{id:2}],onRemoved:noop},runtime:{onMessage:noop,onStartup:noop,onInstalled:noop},alarms:{onAlarm:noop},scripting:{executeScript:async({target})=>{calls.push(target.tabId);if(target.tabId===1)return new Promise(()=>{});return [{result:{data:{jobs:[]}}}];}}};
 const ctx=vm.createContext({chrome,URL,importScripts(){},ApplyPilotPolicy:{},setTimeout:fn=>setTimeout(fn,1),clearTimeout});vm.runInContext(fs.readFileSync('extension/background.js','utf8')+';globalThis.fetchJobs=()=>api("/jobs");',ctx);
 await ctx.fetchJobs();await ctx.fetchJobs();assert.deepEqual(calls,[1,2,2]);
});


test('completion is popup-only and removes local retries only after the server records it',async()=>{
 const noop={addListener(){}},id='11111111-1111-1111-1111-111111111111',calls=[];
 const state={device:'fixture',automaticDefault:true,records:{[id]:{id,tabId:1,auto:true,phase:'blocked',siteRetryAt:55,pendingClicks:{one:true}}},queue:[id,'another']};
 let fail=true;const chrome={runtime:{getURL:p=>'chrome-extension://fixture/'+p,onMessage:noop,onStartup:noop,onInstalled:noop},alarms:{onAlarm:noop,get:async()=>({})},tabs:{onRemoved:noop},storage:{local:{setAccessLevel:async()=>{},get:async()=>structuredClone(state),set:async s=>Object.assign(state,structuredClone(s))}}};
 const ctx=vm.createContext({chrome,URL,importScripts(){},ApplyPilotPolicy:{sameApplication:()=>false}});
 vm.runInContext(fs.readFileSync('extension/background.js','utf8')+';globalThis.run=handle;api=(...args)=>globalThis.testApi(...args);',ctx);
 ctx.testApi=async(...args)=>{calls.push(args);if(fail)throw Error('Server unavailable');return {ok:true,reported:true}};
 const popup={url:chrome.runtime.getURL('popup.html')};
 await assert.rejects(ctx.run({action:'mark-completed',id},{url:'https://employer.test',tab:{id:1},frameId:0}),/not linked/);assert.equal(calls.length,0);
 await assert.rejects(ctx.run({action:'mark-completed',id},popup),/Server unavailable/);assert.equal(state.records[id].auto,true);assert.equal(state.queue.length,2);
 fail=false;await ctx.run({action:'mark-completed',id},popup);assert.equal(calls.at(-1)[0],'/jobs/'+id+'/report-submitted');assert.equal(calls.at(-1)[1],'POST');assert.equal(calls.at(-1)[2].reported,true);
 assert.deepEqual(state.queue,['another']);assert.equal(state.records[id].attempted,true);assert.equal(state.records[id].phase,'submitted');assert.equal(state.records[id].auto,false);assert.equal(state.records[id].siteRetryAt,0);
});

test('the extension funnel action opens the authenticated website funnel without starting an application',async()=>{
 const noop={addListener(){}},opened=[];
 const chrome={runtime:{getURL:p=>'chrome-extension://fixture/'+p,onMessage:noop,onStartup:noop,onInstalled:noop},alarms:{onAlarm:noop,get:async()=>({})},tabs:{onRemoved:noop,create:async x=>{opened.push(x);return x;}},storage:{local:{get:async()=>({device:'fixture',automaticDefault:true,environment:'hosted'}),setAccessLevel:async()=>{}}}};
 const ctx=vm.createContext({chrome,URL,importScripts(){},ApplyPilotPolicy:{}});vm.runInContext(fs.readFileSync('extension/background.js','utf8')+';globalThis.run=handle;',ctx);
 await ctx.run({action:'funnel'},{url:chrome.runtime.getURL('popup.html')});assert.equal(opened.length,1);assert.equal(opened[0].url,'https://marvelous-vitality-production-c2d8.up.railway.app/?view=funnel');
});
