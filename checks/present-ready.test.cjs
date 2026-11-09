const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'../extension');
// Synthetic jobs, tabs and server replies only. The harness mirrors checks/background.test.cjs,
// with a live preparation-status probe and a record of every focus and content message.
function harness(shared={}){
 shared.store||={};shared.tabs||=[{id:1,url:'https://applypilot-jobs.netlify.app/automate.html'}];shared.claims||={};shared.calls||=[];shared.focus=[];shared.messages=[];
 shared.probe||=(tabId)=>{const record=Object.values(shared.store.records||{}).find(r=>r.tabId===tabId);const tab=shared.tabs.find(t=>t.id===tabId);return record&&tab?{started:true,busy:false,attempted:false,readyForSubmit:true,jobId:record.id,url:tab.url}:null;};
 const events={},jobs=[{id:'a',status:'queued',execution_mode:'local',url:'https://jobs.lever.co/org/a',title:'Fixture A'},{id:'b',status:'queued',execution_mode:'local',url:'https://jobs.ashbyhq.com/org/b',title:'Fixture B'},{id:'c',status:'queued',execution_mode:'local',url:'https://jobs.ashbyhq.com/org/c',title:'Fixture C'}];
 const listener=name=>({addListener(fn){events[name]=fn;}});
 const chrome={windows:{update:async(id,props)=>{shared.focus.push(['window',id,props]);}},storage:{local:{get:async()=>structuredClone(shared.store),set:async value=>Object.assign(shared.store,structuredClone(value)),setAccessLevel:async()=>{}}},alarms:{get:async()=>({name:'queue'}),create:async()=>{},onAlarm:listener('alarm')},runtime:{getURL:p=>'chrome-extension://fixture/'+p,onMessage:listener('message'),onStartup:listener('startup'),onInstalled:listener('installed')},
  tabs:{query:async ({url}={})=>shared.tabs.filter(t=>!url||t.url.startsWith('https://applypilot-jobs.netlify.app/')),get:async id=>{const t=shared.tabs.find(t=>t.id===id);if(!t)throw Error('No tab');return t;},create:async props=>{const t={id:shared.tabs.length+1,windowId:7,...props};shared.tabs.push(t);if(props.active)shared.focus.push(['create-active',t.id]);return t;},
   update:async(id,props)=>{if(props.active)shared.focus.push(['tab',id]);return Object.assign(shared.tabs.find(t=>t.id===id),props);},
   sendMessage:async(id,message)=>{shared.messages.push(message.action);return message.action==='preparation-status'?shared.probe(id):{ok:true};},onRemoved:listener('removed')},
  scripting:{executeScript:async({args})=>{
   if(!args)return [{result:{ready:true}}];
   const [,route,method,data,device]=args;shared.calls.push({route,method,data,device});
   if(route==='/jobs')return [{result:{data:{jobs,preparation:shared.preparation}}}];
   const [,id,action]=route.match(/\/jobs\/([^/]+)\/local\/(.*)/)||[];
   if(action==='claim'){shared.claims[id]||={attempted:false};return [{result:{data:shared.claims[id]}}];}
   if(action==='packet')return [{result:{data:{job:{...jobs.find(j=>j.id===id),attempted:shared.claims[id]?.attempted},profile:{},answers:{},prepareSteps:true,autonomousSubmit:false}}}];
   if(action==='attempt'){shared.claims[id].attempted=true;return [{result:{data:{ok:true}}}];}
   return [{result:{data:{ok:true}}}];
  }}};
 const context=vm.createContext({chrome,URL,crypto:require('node:crypto').webcrypto,AbortSignal,console,setTimeout,clearTimeout});
 context.importScripts=file=>vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context);
 vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),context);
 const popup={url:'chrome-extension://fixture/popup.html'};
 const send=(action,data={},sender=popup)=>new Promise(resolve=>events.message({action,...data},sender,resolve));
 const sender=id=>({tab:{id:shared.store.records[id].tabId},url:shared.tabs.find(t=>t.id===shared.store.records[id].tabId).url,frameId:0});
 const ready=id=>send('progress',{fields:[],message:'Ready to submit',blocked:true,readyForSubmit:true},sender(id));
 const tabOf=id=>shared.store.records[id].tabId;
 const focusedTabs=()=>shared.focus.filter(f=>f[0]==='tab').map(f=>f[1]);
 return {shared,events,send,sender,ready,tabOf,focusedTabs};
}
const noSubmit=h=>{assert(!h.shared.calls.some(c=>/\/(attempt|submitted|report-submitted)$/.test(c.route)),'no submission route');assert(!h.shared.messages.some(m=>/submit|click/i.test(m||'')),'no submit or click message');};

test('a filled form is brought to the front once, after the queue moves on, and nothing is submitted',async()=>{
 const h=harness();assert((await h.send('start')).ok);
 assert.deepEqual(h.focusedTabs(),[],'automatic preparation opens tabs in the background');
 const before=h.shared.messages.length;
 assert((await h.ready('a')).ok);
 assert(h.shared.store.records.b?.auto,'the queue moved on to the next job');
 assert.deepEqual(h.focusedTabs(),[h.tabOf('a')],'only the filled form is brought forward');
 assert.deepEqual(JSON.parse(JSON.stringify(h.shared.focus.find(f=>f[0]==='window').slice(1))),[7,{focused:true,drawAttention:true}]);
 assert(h.shared.messages.slice(before).includes('preparation-status'),'the live form is re-probed before focusing');
 assert(h.shared.store.records.a.presentedAt>0);
 await h.ready('a');h.events.alarm({name:'queue'});await new Promise(r=>setTimeout(r,20));
 assert.deepEqual(h.focusedTabs(),[h.tabOf('a')],'the same form is never pulled forward again');
 noSubmit(h);
});

test('a probe that disagrees, an attempt, a duplicate tab or a pause keeps the tab where it is',async()=>{
 for(const change of [{readyForSubmit:false},{busy:true},{attempted:true},{started:false},{jobId:'b'},{url:'https://jobs.lever.co/other/x'},null]){
  const h=harness();await h.send('start');
  h.shared.probe=id=>change===null?null:{started:true,busy:false,attempted:false,readyForSubmit:true,jobId:'a',url:h.shared.tabs.find(t=>t.id===id).url,...change};
  await h.ready('a');
  assert.deepEqual(h.focusedTabs(),[],'not focused for '+JSON.stringify(change));assert(!h.shared.store.records.a.presentedAt);noSubmit(h);
 }
 const duplicate=harness();await duplicate.send('start');
 duplicate.shared.tabs.push({id:99,windowId:7,url:duplicate.shared.tabs.find(t=>t.id===duplicate.tabOf('a')).url});
 await duplicate.ready('a');assert.deepEqual(duplicate.focusedTabs(),[],'two copies of one application are never guessed between');
 const attempted=harness();await attempted.send('start');attempted.shared.store.records.a.attempted=true;
 await attempted.ready('a');assert.deepEqual(attempted.focusedTabs(),[],'a possible submission is never presented');
 const racing=harness();await racing.send('start');
 racing.shared.probe=id=>{racing.shared.store.records.a.attempted=true;return {started:true,busy:false,attempted:false,readyForSubmit:true,jobId:'a',url:racing.shared.tabs.find(t=>t.id===id).url};};
 await racing.ready('a');assert.deepEqual(racing.focusedTabs(),[],'an attempt recorded while the probe was running wins');
 const paused=harness();await paused.send('start');paused.shared.store.userPaused=true;
 await paused.ready('a');assert.deepEqual(paused.focusedTabs(),[],'Pause autofill also pauses bringing forms forward');
});

test('one form at a time: the next filled form comes forward only after the first is closed',async()=>{
 const h=harness();await h.send('start');
 await h.ready('a');assert.deepEqual(h.focusedTabs(),[h.tabOf('a')]);
 await h.ready('b');
 assert.deepEqual(h.focusedTabs(),[h.tabOf('a')],'the first form keeps the front while it waits for Submit');
 assert(!h.shared.store.records.b.presentedAt);
 h.shared.tabs=h.shared.tabs.filter(t=>t.id!==h.tabOf('a'));
 h.events.alarm({name:'queue'});await new Promise(r=>setTimeout(r,20));
 assert.deepEqual(h.focusedTabs(),[h.tabOf('a'),h.tabOf('b')],'the waiting form takes its turn');
 noSubmit(h);
});

test('a form that needed answers again comes forward again when it is next filled',async()=>{
 const h=harness();await h.send('start');
 await h.ready('a');
 await h.send('progress',{fields:['Degree'],message:'Missing Degree',blocked:true},h.sender('a'));
 assert.equal(h.shared.store.records.a.presentedAt,0);
 await h.ready('a');
 assert.deepEqual(h.focusedTabs(),[h.tabOf('a'),h.tabOf('a')]);
});

test('the setting is popup-only, off stops focusing, and is on by default',async()=>{
 const h=harness();await h.send('start');
 assert.equal(h.shared.store.presentReady,undefined);
 assert.equal((await h.send('present-ready',{value:'yes'})).error,'Choose on or off.');
 const foreign=await h.send('present-ready',{value:false},{tab:{id:1},url:'https://evil.example/'});
 assert.notEqual(h.shared.store.presentReady,false,'a web page cannot change it: '+JSON.stringify(foreign));
 assert.equal((await h.send('present-ready',{value:false})).data.presentReady,false);
 await h.ready('a');assert.deepEqual(h.focusedTabs(),[]);
 assert.equal(h.shared.store.records.a.phase,'prepared','the form is still listed under Ready for my Submit');
});

test('popup shows the bring-forward switch and sends only a boolean',()=>{
 const html=fs.readFileSync(path.join(root,'popup.html'),'utf8'),js=fs.readFileSync(path.join(root,'popup.js'),'utf8');
 assert.match(html,/<input id="present-ready" type="checkbox" checked> Bring each filled form to the front for my Submit/);
 assert.match(js,/request\('present-ready',\{value:e\.target\.checked\}\)/);
 assert.match(js,/#present-ready'\)\.checked=data\.state\.presentReady!==false/);
});
