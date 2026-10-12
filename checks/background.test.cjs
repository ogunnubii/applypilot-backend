const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'../extension');
function harness(shared={}){
 shared.store||={};shared.tabs||=[{id:1,url:'https://applypilot-jobs.netlify.app/automate.html'}];shared.claims||={};shared.calls||=[];
 const events={},jobs=[{id:'a',status:'queued',execution_mode:'local',url:'https://jobs.lever.co/org/a',title:'Fixture A'},{id:'b',status:'queued',execution_mode:'local',url:'https://jobs.ashbyhq.com/org/b',title:'Fixture B'}];
 const listener=name=>({addListener(fn){events[name]=fn;}});
 const chrome={windows:{update:async()=>{}},storage:{local:{get:async()=>structuredClone(shared.store),set:async value=>Object.assign(shared.store,structuredClone(value)),setAccessLevel:async()=>{}}},alarms:{get:async()=>({name:'queue'}),create:async()=>{},onAlarm:listener('alarm')},runtime:{getURL:p=>'chrome-extension://fixture/'+p,onMessage:listener('message'),onStartup:listener('startup'),onInstalled:listener('installed')},tabs:{query:async ({url}={})=>shared.tabs.filter(t=>!url||t.url.startsWith('https://applypilot-jobs.netlify.app/')),get:async id=>{const t=shared.tabs.find(t=>t.id===id);if(!t)throw Error('No tab');return t;},create:async props=>{const t={id:shared.tabs.length+1,...props};shared.tabs.push(t);return t;},update:async(id,props)=>Object.assign(shared.tabs.find(t=>t.id===id),props),sendMessage:async()=>({ok:true}),onRemoved:listener('removed')},scripting:{executeScript:async({args})=>{
  if(!args)return [{result:{ready:true}}];
  const [,route,method,data,device]=args;shared.calls.push({route,method,data,device});
  if(shared.offlineAnswers&&route.endsWith('/answers'))throw Error('Fixture connection unavailable');
  if(shared.receiptFailure&&route.endsWith('/submitted'))return [{result:{error:'Receipt sync unavailable',status:shared.receiptFailure}}];
  if(route==='/jobs')return [{result:{data:{jobs,preparation:shared.preparation}}}];
  const [,id,action]=route.match(/\/jobs\/([^/]+)\/local\/(.*)/)||[];
  if(action==='claim'){shared.claims[id]||={attempted:false};return [{result:{data:shared.claims[id]}}];}
  if(action==='packet')return [{result:{data:{job:{...jobs.find(j=>j.id===id),attempted:shared.claims[id]?.attempted},profile:{},answers:{},prepareSteps:shared.preparation?.enabled===true,autonomousSubmit:false}}}];
  if(action==='attempt'){shared.claims[id].attempted=true;return [{result:{data:{ok:true}}}];}
  return [{result:{data:{ok:true}}}];
 }}};
 const context=vm.createContext({chrome,URL,crypto:require('node:crypto').webcrypto,AbortSignal,console,setTimeout,clearTimeout});
 context.importScripts=file=>vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context);
 vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),context);
 const popup={url:'chrome-extension://fixture/popup.html'};
 const send=(action,data={},sender=popup)=>new Promise(resolve=>events.message({action,...data},sender,resolve));
 return {shared,events,send,jobs,chrome,sender:id=>({tab:{id:shared.store.records[id].tabId},url:shared.tabs.find(t=>t.id===shared.store.records[id].tabId).url,frameId:0})};
}

test('interrupted campaign resumes once in its exact existing form, without navigating or submitting',async()=>{
 const h=harness({preparation:{enabled:true}});h.jobs.forEach((j,i)=>{j.preparation={position:i+1};j.queue_position=i+1;});
 await h.send('start');const r=h.shared.store.records.a,tabId=r.tabId;h.jobs[0].status='local_browser';
 r.touched=Date.now()-100000;let fills=0;h.chrome.tabs.sendMessage=async(id,m)=>{if(m.action==='fill')fills++;return null;};
 await h.events.alarm({name:'queue'});assert.equal(h.shared.store.records.a.tabId,tabId);assert.equal(h.shared.store.records.a.recoveryCount,1);assert.equal(fills,1);assert(h.shared.store.records.a.auto);
 h.shared.store.records.a.touched=Date.now()-100000;await h.events.alarm({name:'queue'});assert.equal(fills,1,'no endless recovery loop');assert(h.shared.store.records.b.auto);assert(!h.shared.calls.some(c=>c.route.endsWith('/attempt')));
});

test('receipt outbox survives 502, closed tab, Stop and service worker restart without another employer action',async()=>{
 const h=harness();await h.send('open',{id:'a'});await h.send('attempt',{before:'Application form',human:true,clickId:'original'},h.sender('a'));
 h.shared.receiptFailure=502;
 const result=await h.send('receipt',{receipt:'Thank you for applying. Your application has been received.'},h.sender('a'));
 assert(result.ok);assert(result.data.pending);const evidence=structuredClone(h.shared.store.records.a.pendingReceipt);
 assert(evidence.receiptId);assert(evidence.observedAt);await h.send('stop');
 const attempts=h.shared.calls.filter(c=>c.route.endsWith('/attempt')).length,tabs=h.shared.tabs.length;
 h.shared.tabs=h.shared.tabs.filter(t=>t.id!==h.shared.store.records.a.tabId);
 const next=harness(h.shared);await next.events.startup();h.shared.receiptFailure=0;h.shared.store.records.a.receiptRetryAt=0;
 await next.events.alarm({name:'queue'});
 assert.equal(h.shared.store.records.a.pendingReceipt,undefined);assert.deepEqual(h.shared.store.records.a.receiptEvidence,evidence);
 assert.equal(h.shared.store.records.a.phase,'submitted');assert.equal(h.shared.store.enabled,false);
 assert.equal(h.shared.calls.filter(c=>c.route.endsWith('/attempt')).length,attempts);assert.equal(h.shared.tabs.length,tabs-1);
 const receipts=h.shared.calls.filter(c=>c.route.endsWith('/submitted'));assert.equal(receipts.length,2);assert.equal(JSON.stringify(receipts[0].data),JSON.stringify(receipts[1].data));
});

test('receipt sync identity rejection keeps evidence for review without hammering the server',async()=>{
 const h=harness();await h.send('open',{id:'a'});await h.send('attempt',{before:'Application form',human:true},h.sender('a'));await h.send('stop');
 h.shared.receiptFailure=409;const r=await h.send('receipt',{receipt:'Thank you for applying'},h.sender('a'));assert(r.data.needsReview);
 await h.events.alarm({name:'queue'});await h.events.alarm({name:'queue'});
 assert(h.shared.store.records.a.pendingReceipt);assert.equal(h.shared.calls.filter(c=>c.route.endsWith('/submitted')).length,1);
});

test('preparation heartbeat retains activity without clearing blockers or manufacturing ready evidence',async()=>{
 const h=harness();await h.send('open',{id:'a'});h.shared.store.records.a.touched=0;
 const before=h.shared.calls.length;assert.equal((await h.send('preparation-heartbeat',{},h.sender('a'))).data.continue,true);
 assert(h.shared.store.records.a.touched>0);assert.equal(h.shared.calls.length,before);
 await h.send('stop');assert.equal((await h.send('preparation-heartbeat',{},h.sender('a'))).data.continue,false);
});

test('a busy responsive form is not timed out while Gemini prepares its answers',async()=>{
 const h=harness();await h.send('start');h.shared.store.records.a.touched=Date.now()-100000;
 h.chrome.tabs.sendMessage=async()=>({busy:true,attempted:false});await h.events.alarm({name:'queue'});
 assert(h.shared.store.records.a.auto);assert(!h.shared.store.records.b);assert(!h.shared.calls.some(c=>/Browser stopped/.test(c.data?.message||'')));
});

test('recovery never reopens missing tabs, resumes attempts, overrides Stop, or restarts a real form blocker',async()=>{
 for(const kind of ['lost','attempt','server-attempt','duplicate','stop','captcha','ready','outside']){
  const h=harness({preparation:{enabled:true}});h.jobs[0].preparation={position:1};h.jobs[0].queue_position=1;
  await h.send('start');const r=h.shared.store.records.a;r.auto=false;r.phase='blocked';r.interrupted=true;h.jobs[0].status='local_browser';
  let fills=0;h.chrome.tabs.sendMessage=async(id,m)=>{if(m.action==='fill')fills++;return kind==='captcha'?{stopped:true,attempted:false}:null;};
  if(kind==='lost')h.shared.tabs=h.shared.tabs.filter(t=>t.id!==r.tabId);
  if(kind==='attempt')r.attempted=true;
  if(kind==='server-attempt')h.shared.claims.a.attempted=true;
  if(kind==='duplicate')h.shared.tabs.push({...h.shared.tabs.find(t=>t.id===r.tabId),id:99});
  if(kind==='stop')await h.send('stop');
  if(kind==='ready')r.phase='prepared';
  if(kind==='outside')h.jobs[0].preparation=null;
  const tabs=h.shared.tabs.length,claims=h.shared.calls.filter(c=>c.route.endsWith('/claim')).length;
  await h.events.alarm({name:'queue'});assert.equal(fills,0,kind);assert.equal(h.shared.tabs.length,tabs,kind);assert.equal(h.shared.calls.filter(c=>c.route.endsWith('/claim')).length,claims,kind);
 }
});
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

test('autosaved answers survive a disconnected server and extension restart without repeated writes',async()=>{
 const h=harness();await h.send('open',{id:'a'});await h.send('stop');h.shared.offlineAnswers=true;
 const result=await h.send('autosave',{question:'Preferred technology',answer:'Linux',resume:true},h.sender('a'));
 assert(result.ok);assert(result.data.pending);assert.equal(h.shared.store.records.a.pendingAnswers['Preferred technology'].answer,'Linux');
 h.shared.offlineAnswers=false;const resumed=harness(h.shared);await resumed.events.alarm({name:'queue'});await resumed.send('list');
 assert.equal(Object.keys(h.shared.store.records.a.pendingAnswers).length,0);const saved=h.shared.calls.filter(x=>x.route.endsWith('/answers')).at(-1);assert.equal(saved.data.resume,true);assert.equal(saved.data.answer,'Linux');
 const count=h.shared.calls.length;await resumed.send('autosave',{question:'Preferred technology',answer:'Linux',resume:true},resumed.sender('a'));assert.equal(h.shared.calls.length,count);
 assert(!(await resumed.send('autosave',{question:'Password',answer:'fixture'},resumed.sender('a'))).ok);
});

test('supported manual-review leads enter preparation, while email-only leads and prior attempts stay out',async()=>{
 const h=harness();h.jobs.splice(0,2,
  {id:'manual',status:'needs_review',challenge:'Manual application',metadata:{manualReview:true},url:'https://www.iitjobs.com/job/cloud-engineer-123'},
  {id:'email',status:'needs_review',challenge:'Manual application',metadata:{manualReview:true},url:'https://apply.tri-global.com/job/example'},
  {id:'attempted',status:'needs_review',challenge:'Manual application',metadata:{manualReview:true},local_attempt_at:'2026',url:'https://www.iitjobs.com/job/cloud-engineer-124'});
 await h.send('start');assert(h.shared.store.records.manual);assert(!h.shared.store.records.email);assert(!h.shared.store.records.attempted);
 assert(!h.shared.calls.some(c=>c.route.endsWith('/attempt')));
});

test('manual Open and autofill can open one entry screen without allowing automatic Next or Submit',async()=>{
 const h=harness();await h.send('stop');await h.send('open',{id:'a',auto:false});
 assert((await h.send('step',{entry:true},h.sender('a'))).ok);
 assert(!(await h.send('step',{entry:true},h.sender('a'))).ok);
 assert(!(await h.send('step',{},h.sender('a'))).ok);
 assert(!(await h.send('attempt',{automatic:true},h.sender('a'))).ok);
});

test('only a trusted dashboard can request opening a tracked application',async()=>{
 const h=harness(),sender={tab:{id:1},url:'https://applypilot-jobs.pages.dev/automate',frameId:0};
 assert(!(await h.send('open-from-dashboard',{id:'a'},{...sender,url:'https://evil.example/'})).ok);
 assert(!(await h.send('open-from-dashboard',{id:'a'},{...sender,frameId:1})).ok);
 assert((await h.send('open-from-dashboard',{id:'a'},sender)).ok);assert(h.shared.store.records.a.manualOpen);
});

test('manual open reuses the exact employer tab and brings its window forward',async()=>{
 const h=harness();await h.send('open',{id:'a',auto:true});const tab=h.shared.tabs.find(t=>t.id===h.shared.store.records.a.tabId);tab.windowId=7;tab.active=false;
 const before=h.shared.tabs.length;await h.send('open',{id:'a',auto:false});assert.equal(h.shared.tabs.length,before);assert.equal(tab.active,true);assert.equal(h.shared.store.records.a.auto,false);
});

test('matching embedded Greenhouse frame gets its packet and unrelated frames remain rejected',async()=>{
 const h=harness();h.jobs[0].url='https://job-boards.greenhouse.io/trivago/jobs/8794953002';await h.send('open',{id:'a',auto:false});
 const tab=h.shared.tabs.find(t=>t.id===h.shared.store.records.a.tabId);tab.url='https://careers.trivago.com/apply/?gh_jid=8794953002';
 const sender={tab:{id:tab.id,url:tab.url},frameId:4,url:'https://job-boards.greenhouse.io/embed/job_app?for=trivago&token=8794953002'};
 assert((await h.send('packet',{},sender)).ok);assert.equal(h.shared.store.records.a.frameId,4);
 assert(!(await h.send('packet',{}, {...sender,tab:{...sender.tab,url:'https://evil.example/'}})).ok);
 assert(!(await h.send('packet',{}, {...sender,url:sender.url.replace('trivago','other')})).ok);
 await h.send('open',{id:'a',auto:false});assert.equal(h.shared.tabs.filter(t=>t.url.includes('8794953002')).length,1,'reuse parent without duplicating application');
});

