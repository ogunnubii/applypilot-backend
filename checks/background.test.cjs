const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'../extension');
function harness(shared={}){
 shared.store||={};shared.tabs||=[{id:1,url:'https://applypilot-jobs.netlify.app/automate.html'}];shared.claims||={};shared.calls||=[];
 const events={},jobs=[{id:'a',status:'saved',url:'https://jobs.lever.co/org/a',title:'Fixture A'},{id:'b',status:'saved',url:'https://jobs.ashbyhq.com/org/b',title:'Fixture B'}];
 const listener=name=>({addListener(fn){events[name]=fn;}});
 const chrome={storage:{local:{get:async()=>structuredClone(shared.store),set:async value=>Object.assign(shared.store,structuredClone(value)),setAccessLevel:async()=>{}}},alarms:{get:async()=>({name:'queue'}),create:async()=>{},onAlarm:listener('alarm')},runtime:{getURL:p=>'chrome-extension://fixture/'+p,onMessage:listener('message'),onStartup:listener('startup'),onInstalled:listener('installed')},tabs:{query:async ({url}={})=>shared.tabs.filter(t=>!url||t.url.startsWith('https://applypilot-jobs.netlify.app/')),get:async id=>{const t=shared.tabs.find(t=>t.id===id);if(!t)throw Error('No tab');return t;},create:async props=>{const t={id:shared.tabs.length+1,...props};shared.tabs.push(t);return t;},update:async(id,props)=>Object.assign(shared.tabs.find(t=>t.id===id),props),sendMessage:async()=>({ok:true}),onRemoved:listener('removed')},scripting:{executeScript:async({args})=>{
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
 return {shared,events,send,sender:id=>({tab:{id:shared.store.records[id].tabId},url:shared.tabs.find(t=>t.id===shared.store.records[id].tabId).url,frameId:0})};
}
test('Blocked application retains its tab and queue automatically advances to the next job',async()=>{
 const h=harness();assert((await h.send('start')).ok);assert(h.shared.store.records.a.auto);const firstTab=h.shared.store.records.a.tabId;
 assert((await h.send('progress',{fields:['Degree'],message:'Missing Degree',blocked:true},h.sender('a'))).ok);
 assert.equal(h.shared.store.records.a.phase,'blocked');assert(h.shared.store.records.b.auto);assert(h.shared.tabs.some(t=>t.id===firstTab));
 await h.send('stop');assert(!h.shared.store.enabled);assert(Object.values(h.shared.store.records).every(r=>!r.auto));
});
test('Intent survives service-worker recreation and browser restart; stale tab IDs never authorize another job',async()=>{
 const h=harness();await h.send('open',{id:'a',auto:true});await h.send('attempt',{before:'Application form'},h.sender('a'));
 assert(h.shared.store.records.a.attempted);assert(h.shared.claims.a.attempted);
 const next=harness(h.shared);assert.equal((await next.send('state',{},next.sender('a'))).data.attempted,true);
 await next.events.startup();assert(!h.shared.store.records.a.auto);assert(!h.shared.store.enabled);
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
