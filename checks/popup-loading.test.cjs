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

test('popup buttons distinguish foreground fill, prevent repeat requests, and show local errors and holds',async()=>{
 const {JSDOM}=require('jsdom');const dom=new JSDOM(fs.readFileSync('extension/popup.html','utf8'),{runScripts:'outside-only'}),w=dom.window;
 let finish;const calls=[];w.ApplyPilotPolicy={attentionOrder:()=>[],supported:()=>true};w.chrome={runtime:{sendMessage:async m=>{calls.push(m);if(m.action==='list')return {ok:true,data:{state:{enabled:true,queue:[]},jobs:[{id:'good',status:'queued',title:'Good',company:'Example'},{id:'hold',status:'queued',title:'Held',employer_hold:{message:'Employer application limit reached'},url:'https://jobs.lever.co/example/held'}]}};return new Promise(resolve=>{finish=resolve;});}}};
 w.eval(fs.readFileSync('extension/popup.js','utf8'));await new Promise(r=>setImmediate(r));
 const row=w.document.querySelector('[data-job-id="good"]'),buttons=row.querySelectorAll('button');buttons[1].click();assert.equal(calls.at(-1).auto,false);assert(buttons[0].disabled&&buttons[1].disabled);assert.match(row.textContent,/Opening this application/);buttons[1].click();assert.equal(calls.filter(c=>c.action==='open').length,1);
 finish({ok:false,error:'This application belongs to another browser'});await new Promise(r=>setImmediate(r));assert.match(row.querySelector('[role=status]').textContent,/another browser/);assert(!buttons[1].disabled);
 buttons[0].click();assert.equal(calls.at(-1).auto,true);finish({ok:true,data:{opened:true}});await new Promise(r=>setImmediate(r));assert.match(row.textContent,/Preparation started/);
 const held=w.document.querySelector('[data-job-id="hold"]');assert([...held.querySelectorAll('button')].every(b=>b.disabled));assert.match(held.textContent,/Employer application limit/);assert(held.querySelector('a'));w.close();
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
