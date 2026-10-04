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
 w.chrome={runtime:{sendMessage:()=>new Promise(resolve=>responses.push(resolve))}};w.ApplyPilotPolicy={attentionOrder:()=>[]};
 w.eval(fs.readFileSync('extension/popup.js','utf8'));timeout();await new Promise(r=>setImmediate(r));
 assert.match(w.document.querySelector('#message').textContent,/too long/);
 w.document.querySelector('#refresh').click();responses[1]({ok:true,data:{state:{enabled:true,queue:[]},jobs:[{id:'new',title:'New job',company:'Employer',status:'queued'}]}});await new Promise(r=>setImmediate(r));
 assert.match(w.document.querySelector('#jobs').textContent,/New job/);
 responses[0]({ok:true,data:{state:{queue:[]},jobs:[]}});await new Promise(r=>setImmediate(r));assert.match(w.document.querySelector('#jobs').textContent,/New job/);w.close();
});

test('read requests prefer active dashboards and skip a frozen tab without retrying writes',async()=>{
 const noop={addListener(){}};let calls=[];const chrome={storage:{local:{get:async()=>({device:'fixture'})}},tabs:{query:async()=>[{id:1,active:false},{id:2,active:true}],onRemoved:noop},runtime:{onMessage:noop,onStartup:noop,onInstalled:noop},alarms:{onAlarm:noop},scripting:{executeScript:async({target})=>{calls.push(target.tabId);if(target.tabId===2)return new Promise(()=>{});return [{result:{data:{jobs:[]}}}];}}};
 const ctx=vm.createContext({chrome,URL,importScripts(){},ApplyPilotPolicy:{},setTimeout:fn=>setTimeout(fn,1),clearTimeout});vm.runInContext(fs.readFileSync('extension/background.js','utf8')+';globalThis.fetchJobs=()=>api("/jobs");',ctx);
 assert.deepEqual(Array.from((await ctx.fetchJobs()).jobs),[]);assert.deepEqual(calls,[2,1]);
});
