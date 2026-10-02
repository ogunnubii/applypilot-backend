const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'../extension');
function harness(shared={}){
 shared.store||={};shared.tabs||=[{id:1,url:'https://applypilot-jobs.netlify.app/automate.html'}];shared.claims||={};shared.calls||=[];
 const events={},jobs=[{id:'a',status:'queued',execution_mode:'local',url:'https://jobs.lever.co/org/a',title:'Fixture A'},{id:'b',status:'queued',execution_mode:'local',url:'https://jobs.ashbyhq.com/org/b',title:'Fixture B'}];
 const listener=name=>({addListener(fn){events[name]=fn;}});
 const chrome={windows:{update:async()=>{}},storage:{local:{get:async()=>structuredClone(shared.store),set:async value=>Object.assign(shared.store,structuredClone(value)),setAccessLevel:async()=>{}}},alarms:{get:async()=>({name:'queue'}),create:async()=>{},onAlarm:listener('alarm')},runtime:{getURL:p=>'chrome-extension://fixture/'+p,onMessage:listener('message'),onStartup:listener('startup'),onInstalled:listener('installed')},tabs:{query:async ({url}={})=>shared.tabs.filter(t=>!url||t.url.startsWith('https://applypilot-jobs.netlify.app/')),get:async id=>{const t=shared.tabs.find(t=>t.id===id);if(!t)throw Error('No tab');return t;},create:async props=>{const t={id:shared.tabs.length+1,...props};shared.tabs.push(t);return t;},update:async(id,props)=>Object.assign(shared.tabs.find(t=>t.id===id),props),sendMessage:async()=>({ok:true}),onRemoved:listener('removed')},scripting:{executeScript:async({args})=>{
  const [,route,method,data,device]=args;shared.calls.push({route,method,data,device});
  if(route==='/jobs')return [{result:{data:{jobs}}}];
  const [,id,action]=route.match(/\/jobs\/([^/]+)\/local\/(.*)/)||[];
  if(action==='claim'){shared.claims[id]||={attempted:false};return [{result:{data:shared.claims[id]}}];}
  if(action==='packet')return [{result:{data:{job:{...jobs.find(j=>j.id===id),attempted:shared.claims[id]?.attempted},profile:{},answers:{}}}}];
  if(action==='attempt'){shared.claims[id].attempted=true;return [{result:{data:{ok:true}}}];}
  return [{result:{data:{ok:true}}}];
 }}};
 const context=vm.createContext({chrome,URL,crypto:require('node:crypto').webcrypto,AbortSignal,console,setTimeout,clearTimeout});
 context.importScripts=file=>vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context);
 vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),context);
 const popup={url:'chrome-extension://fixture/popup.html'};
 const send=(action,data={},sender=popup)=>new Promise(resolve=>events.message({action,...data},sender,resolve));
 return {shared,events,send,jobs,sender:id=>({tab:{id:shared.store.records[id].tabId},url:shared.tabs.find(t=>t.id===shared.store.records[id].tabId).url,frameId:0})};
}
test('Blocked application retains its tab and queue automatically advances to the next job',async()=>{
 const h=harness();assert((await h.send('start')).ok);assert(h.shared.store.records.a.auto);const firstTab=h.shared.store.records.a.tabId;
 assert((await h.send('progress',{fields:['Degree'],message:'Missing Degree',blocked:true},h.sender('a'))).ok);
 assert.equal(h.shared.store.records.a.phase,'blocked');assert(h.shared.store.records.b.auto);assert(h.shared.tabs.some(t=>t.id===firstTab));
 await h.send('stop');assert(!h.shared.store.enabled);assert(Object.values(h.shared.store.records).every(r=>!r.auto));
});
test('Intent survives service-worker recreation and browser restart; stale tab IDs never authorize another job',async()=>{
 const h=harness();await h.send('open',{id:'a',auto:true});await h.send('attempt',{before:'Application form',human:true},h.sender('a'));
 assert(h.shared.store.records.a.attempted);assert(h.shared.claims.a.attempted);
 const next=harness(h.shared);assert.equal((await next.send('state',{},next.sender('a'))).data.attempted,true);
 await next.events.startup();assert(!h.shared.store.records.a.auto);assert(h.shared.store.enabled);
 const wrong={...next.sender('a'),url:'https://jobs.lever.co/org/another'};assert(!(await next.send('packet',{},wrong)).ok);
 const tab=h.shared.tabs.find(t=>t.id===h.shared.store.records.a.tabId);tab.id=99;
 assert((await next.send('packet',{}, {tab:{id:99},url:tab.url,frameId:0})).ok);assert.equal(h.shared.store.records.a.tabId,99);assert(!h.shared.store.records.a.auto);
});
test('Receipt requires observed intent and unlinked frames cannot read applicant packets',async()=>{
 const h=harness();await h.send('open',{id:'a'});
 assert(!(await h.send('receipt',{receipt:'Thank you for applying'},h.sender('a'))).ok);
 assert(!(await h.send('packet',{}, {...h.sender('a'),frameId:1})).ok);
 await h.send('attempt',{before:'Application form',human:true},h.sender('a'));
 assert((await h.send('receipt',{receipt:'Thank you for applying'},h.sender('a'))).ok);assert.equal(h.shared.store.records.a.phase,'submitted');
});

test('Automatic mode starts by default, discovers later jobs, and respects Stop across restart',async()=>{
 const h=harness();await h.send('list');assert(h.shared.store.enabled);await h.events.alarm({name:'queue'});await h.send('list');assert(h.shared.store.records.a.auto);
 await h.send('progress',{blocked:true,message:'CAPTCHA',fields:[]},h.sender('a'));
 await h.send('progress',{blocked:true,message:'CAPTCHA',fields:[]},h.sender('b'));assert(h.shared.store.enabled);
 const calls=h.shared.calls.filter(c=>c.route.endsWith('/claim')).length;await h.events.alarm({name:'queue'});await h.send('list');assert.equal(h.shared.calls.filter(c=>c.route.endsWith('/claim')).length,calls,'blocked jobs are not retried in a loop');
 h.jobs.push({id:'c',status:'queued',execution_mode:'local',url:'https://jobs.lever.co/org/c'});await h.events.alarm({name:'queue'});await h.send('list');assert(h.shared.store.records.c.auto,'later discovery is picked up');
 await h.send('stop');await h.events.startup();assert(!h.shared.store.enabled);await h.send('list');assert(!h.shared.store.enabled,'opening popup cannot undo Stop');
});
test('Automatic selection excludes cloud profiles and uncertain submissions',async()=>{
 const h=harness();h.jobs[0].execution_mode='cloud';h.jobs[1].local_attempt_at='recorded';await h.send('start');assert.equal(Object.keys(h.shared.store.records||{}).length,0);
});

test('Dashboard can focus an existing application without restarting it; foreign origins cannot',async()=>{
 const h=harness();await h.send('open',{id:'a'});const before=h.shared.calls.length;
 const sender={tab:{id:1},url:'https://applypilot-jobs.pages.dev/automate',frameId:0};
 assert((await h.send('focus-existing',{id:'a'},sender)).ok);assert.equal(h.shared.calls.length,before);
 assert(!(await h.send('focus-existing',{id:'a'},{...sender,url:'https://evil.example'})).ok);
 const record=h.shared.store.records.a;h.shared.tabs.find(t=>t.id===record.tabId).url='https://jobs.lever.co/org/other';
 assert(!(await h.send('focus-existing',{id:'a'},sender)).ok);assert.equal(h.shared.calls.length,before);
});

test('Automatic submission intent is rejected before any server or record mutation',async()=>{const h=harness();await h.send('open',{id:'a',auto:true});const result=await h.send('attempt',{before:'Application form'},h.sender('a'));assert(!result.ok);assert(!h.shared.store.records.a.attempted);assert(!h.shared.calls.some(c=>c.route.endsWith('/attempt')));});
