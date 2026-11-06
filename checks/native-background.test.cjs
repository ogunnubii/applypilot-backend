// Extension background checks for LinkedIn/Indeed binding, Indeed Apply
// continuation, posting gate and board pacing. Fixture chrome APIs only.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'../extension');
const IN='https://ca.indeed.com/viewjob?jk=0123456789abcdef',LI='https://www.linkedin.com/jobs/view/4012345678';
function harness(jobs,shared={}){
 shared.store||={};shared.tabs||=[{id:1,url:'https://applypilot-jobs.netlify.app/automate.html'}];shared.calls||=[];shared.posting||={eligible:true};
 const events={},listener=name=>({addListener(fn){events[name]=fn;}});
 const chrome={windows:{update:async()=>{}},storage:{local:{get:async()=>structuredClone(shared.store),set:async v=>Object.assign(shared.store,structuredClone(v)),setAccessLevel:async()=>{}}},alarms:{get:async()=>({name:'queue'}),create:async()=>{},onAlarm:listener('alarm')},runtime:{getManifest:()=>({version:'0.7.0'}),getURL:p=>'chrome-extension://fixture/'+p,onMessage:listener('message'),onStartup:listener('startup'),onInstalled:listener('installed')},
  tabs:{query:async({url}={})=>shared.tabs.filter(t=>!url||t.url.startsWith('https://applypilot-jobs.netlify.app/')),get:async id=>{const t=shared.tabs.find(t=>t.id===id);if(!t)throw Error('No tab');return t;},create:async props=>{const t={id:shared.tabs.length+1,...props};shared.tabs.push(t);return t;},update:async(id,props)=>Object.assign(shared.tabs.find(t=>t.id===id),props),remove:async id=>{shared.removed=[...(shared.removed||[]),id];shared.tabs=shared.tabs.filter(t=>t.id!==id);},sendMessage:async()=>({ok:true}),onRemoved:listener('removed')},
  scripting:{executeScript:async({args})=>{
   if(!args)return [{result:{ready:true}}];
   const [,route,method,data]=args;shared.calls.push({route,method,data});
   if(shared.routes?.[route])return [{result:{data:shared.routes[route](data,method)}}];
   if(route==='/jobs')return [{result:{data:{jobs}}}];
   const [,id,action]=route.match(/\/jobs\/([^/]+)\/local\/(.*)/)||[];
   if(action==='claim')return [{result:{data:{attempted:false}}}];
   if(action==='packet')return [{result:{data:{job:{...jobs.find(j=>j.id===id),attempted:false},profile:{},answers:{},prepareSteps:false,autonomousSubmit:false}}}];
   if(action==='posting')return [{result:{data:shared.posting}}];
   return [{result:{data:{ok:true}}}];
  }}};
 const context=vm.createContext({chrome,URL,crypto:require('node:crypto').webcrypto,AbortSignal,console,setTimeout,clearTimeout});
 context.importScripts=file=>vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context);
 vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),context);
 const popup={url:'chrome-extension://fixture/popup.html'};
 const send=(action,data={},sender=popup)=>new Promise(resolve=>events.message({action,...data},sender,resolve));
 const tab=id=>shared.tabs.find(t=>t.id===shared.store.records[id].tabId);
 return {shared,events,send,tab,from:(t,url=t.url)=>({tab:{id:t.id,openerTabId:t.openerTabId},url,frameId:0})};
}
const job=(id,url,extra={})=>({id,status:'queued',execution_mode:'local',url,title:'Senior SRE',company:'Acme Cloud',...extra});

test('Indeed Apply is adopted only from the bound job tab after an eligible posting check and entry step',async()=>{
 const h=harness([job('a',IN)]);await h.send('open',{id:'a'});const jobTab=h.tab('a');jobTab.url=IN;
 // Opening the application before the posting check is refused.
 const early=await h.send('step',{entry:true},h.from(jobTab));assert.equal(early.ok,false);assert.match(early.error,/Check this job-board posting/);
 assert.equal((await h.send('posting',{title:'Senior SRE'},h.from(jobTab))).data.eligible,true);
 assert(h.shared.calls.some(c=>c.route.endsWith('/local/posting')&&c.data.url===IN));
 assert.equal((await h.send('step',{entry:true},h.from(jobTab))).ok,true);
 // An unrelated tab on Indeed Apply cannot claim the application.
 h.shared.tabs.push({id:50,url:'https://smartapply.indeed.com/beta/indeedapply/form/contact-info'});
 assert.equal((await h.send('packet',{},h.from(h.shared.tabs.at(-1)))).ok,false);
 // The tab opened by the bound job tab is adopted once.
 h.shared.tabs.push({id:51,openerTabId:jobTab.id,url:'https://smartapply.indeed.com/beta/indeedapply/form/contact-info'});
 const flow=h.shared.tabs.at(-1);
 assert.equal((await h.send('packet',{},h.from(flow))).ok,true);assert.equal(h.shared.store.records.a.flowTabId,51);
 assert.equal((await h.send('state',{},h.from(jobTab))).data.flowElsewhere,true,'original job tab stands down');
 assert.equal((await h.send('state',{},h.from(flow))).data.flowElsewhere,false);
 // Indeed Apply for a different job key never matches.
 assert.equal((await h.send('state',{},h.from(flow,'https://smartapply.indeed.com/beta/indeedapply/form/review?jk=ffffffffffffffff'))).ok,false);
 // A receipt in the continuation tab is accepted only after a recorded attempt; one attempt only.
 assert.equal((await h.send('receipt',{receipt:'Your application has been submitted!'},h.from(flow))).ok,false);
 await h.send('attempt',{before:'Review your application',human:true,clickId:'c1'},h.from(flow));
 const attempt=h.shared.calls.filter(c=>c.route.endsWith('/local/attempt'));assert.equal(attempt.length,1);assert.equal(attempt[0].data.url,flow.url);
 assert.equal((await h.send('receipt',{receipt:'Your application has been submitted!'},h.from(flow))).ok,true);
 assert(h.shared.calls.some(c=>c.route.endsWith('/local/submitted')));
});

test('an ineligible posting keeps the Easy Apply entry closed',async()=>{
 const h=harness([job('l',LI)],{posting:{eligible:false,blocker:'Not listed as a remote position.'}});await h.send('open',{id:'l'});const t=h.tab('l');t.url=LI+'/';
 assert.equal((await h.send('posting',{},h.from(t))).data.eligible,false);
 assert.equal((await h.send('step',{entry:true},h.from(t))).ok,false);
 assert(!h.shared.calls.some(c=>c.route.endsWith('/local/step')));
});

test('job-board pacing: spacing between automatic openings, and a reported limit pauses only that board',async()=>{
 const jobs=[job('l1',LI),job('l2','https://www.linkedin.com/jobs/view/4012345679'),job('g','https://boards.greenhouse.io/acme/jobs/1')];
 const h=harness(jobs);await h.send('start');
 const opened=()=>Object.keys(h.shared.store.records);
 assert.deepEqual(opened(),['l1']);
 // Settle the first job; the second LinkedIn job waits for spacing while Greenhouse proceeds.
 Object.assign(h.shared.store.records.l1,{auto:false,phase:'blocked'});await h.events.alarm({name:'queue'});
 assert(opened().includes('g'));assert(!opened().includes('l2'));
 Object.assign(h.shared.store.records.g,{auto:false,phase:'blocked'});
 h.shared.store.records.l1.openedAt=Date.now()-200000;
 // A board-reported limit pauses LinkedIn for hours.
 const t=h.tab('l1');t.url=LI+'/';
 const limit=await h.send('site-error',{code:429,native:true,empty:false,initial:false},h.from(t));
 assert.match(limit.data.message,/paused for 12 hours/);assert(h.shared.store.records.l1.siteCooldownUntil-Date.now()>11*3600000);
 await h.events.alarm({name:'queue'});assert(!opened().includes('l2'));
});

test('the extension follows the persisted Start/Stop switch and its buttons write to it',async()=>{
 let running=false;const h=harness([job('l',LI)],{routes:{'/autopilot':(data,method)=>{if(method==='PUT')running=data.running;return {configured:true,running};}}});
 await h.send('start');assert.equal(running,true,'Start writes running');assert.equal(h.shared.store.enabled,true);
 await h.send('stop');assert.equal(running,false);assert.equal(h.shared.store.enabled,false);
 // The dashboard starts it: the next tick resumes; the dashboard stops it: the next tick pauses.
 running=true;await h.events.alarm({name:'queue'});assert.equal(h.shared.store.enabled,true);assert.equal(h.shared.store.userPaused,false);
 running=false;await h.events.alarm({name:'queue'});assert.equal(h.shared.store.enabled,false);
 assert(Object.values(h.shared.store.records).every(r=>!r.auto),'no record keeps running automatically');
});

test('board import is accepted only from a top-level LinkedIn/Indeed results page and only for that board',async()=>{
 const h=harness([],{routes:{'/jobs/board-import':data=>({added:data.jobs.length,existing:0,duplicates:0,rejected:0})}});
 const page={tab:{id:9},frameId:0,url:'https://www.linkedin.com/jobs/search/?keywords=sre'};
 const ok=await h.send('board-import',{board:'linkedin',jobs:[{url:LI,title:'SRE'},{url:IN},{url:'https://evil.example/jobs/view/1'}]},page);
 assert.equal(ok.ok,true);assert.equal(h.shared.calls.at(-1).data.jobs.length,1,'other boards and lookalikes dropped');
 for(const [sender,board] of [[{...page,frameId:3},'linkedin'],[{...page,url:'https://www.linkedin.com/feed/'},'linkedin'],[{...page,url:'https://ca.indeed.com/jobs?q=sre'},'linkedin'],[{tab:{id:9},frameId:0,url:'https://linkedin.com.evil.example/jobs/search/'},'linkedin']])
  assert.equal((await h.send('board-import',{board,jobs:[{url:LI}]},sender)).ok,false,sender.url);
 assert.equal((await h.send('board-import',{board:'indeed',jobs:[{url:IN}]},{tab:{id:9},frameId:0,url:'https://ca.indeed.com/jobs?q=sre'})).ok,true);
});

test('local port is configurable; only that localhost origin is trusted and used',async()=>{
 const h=harness([]);
 h.shared.tabs.push({id:30,url:'http://localhost:8088/assistant'});
 const popup={url:'chrome-extension://fixture/popup.html'};
 assert.equal((await h.send('environment',{value:'local',port:80},popup)).ok,false,'privileged ports rejected');
 assert.equal((await h.send('environment',{value:'local',port:70000},popup)).ok,false);
 assert.equal((await h.send('environment',{value:'local',port:8088},popup)).ok,true);
 assert.equal(h.shared.store.environment,'local');assert.equal(h.shared.store.localPort,8088);
 const dash=url=>({tab:{id:30},frameId:0,url});
 assert.equal((await h.send('dashboard-status',{},dash('http://localhost:8088/assistant'))).ok,true);
 // Another local service (for example jjworks on 8080) is not trusted.
 assert.equal((await h.send('dashboard-status',{},dash('http://localhost:8080/'))).ok,false);
 assert.equal((await h.send('dashboard-status',{},dash('http://localhost:8088/assistant'.replace('8088','9999')))).ok,false);
 // The dashboard link and API calls use the configured port.
 await h.send('dashboard',{},popup);
 assert.equal(h.shared.tabs.at(-1).url,'http://localhost:8088/assistant');
 // Hosted dashboards stay trusted.
 assert.equal((await h.send('dashboard-status',{},dash('https://applypilot-jobs.netlify.app/automate.html'))).ok,true);
});

test('read-only listing checks: inactive tab bound to the exact job, then closed; timeouts back off; limits pause the board',async()=>{
 const due=[{id:'c1',url:'https://www.linkedin.com/jobs/view/4012345601'},{id:'c2',url:'https://www.linkedin.com/jobs/view/4012345602'}];
 const posted=[];
 const h=harness([],{routes:{'/jobs':()=>({jobs:[],listing_checks:due.filter(j=>!posted.some(p=>p.url===j.url))}),'/jobs/c1/listing-check':data=>{posted.push(data);return {eligible:true};},'/jobs/c2/listing-check':data=>{posted.push(data);return {eligible:false,blocker:'held'};}}});
 await h.send('start');await h.events.alarm({name:'queue'});
 const l=h.shared.store.listing;assert.equal(l.jobId,'c1');const tab=h.shared.tabs.find(t=>t.id===l.tabId);assert.equal(tab.active,false,'background tab');assert.equal(tab.url,due[0].url);
 assert.equal(Object.keys(h.shared.store.records||{}).length,0,'no application record, no claim');
 assert(!h.shared.calls.some(c=>/\/local\//.test(c.route)),'no claim, packet or fill');
 const from=(t,url=t.url,frameId=0)=>({tab:{id:t.id},url,frameId});
 assert.equal((await h.send('listing-role',{},from(tab))).data.inspect,true);
 assert.equal((await h.send('listing-role',{},from(tab,tab.url,2))).data.inspect,false,'not a sub-frame');
 assert.equal((await h.send('listing-role',{},from(tab,due[1].url))).data.inspect,false,'not another job');
 h.shared.tabs.push({id:77,url:due[0].url});assert.equal((await h.send('listing-check',{title:'x'},from(h.shared.tabs.at(-1)))).ok,false,'not another tab');
 const r=await h.send('listing-check',{title:'Site Reliability Engineer',company:'Acme'},from(tab));assert.equal(r.ok,true);
 assert.equal(posted.length,1);assert.equal(posted[0].url,due[0].url);assert(h.shared.removed.includes(tab.id),'tab closed');assert.equal(h.shared.store.listing,null);
 // Board pacing: the second LinkedIn check waits for spacing.
 await h.events.alarm({name:'queue'});assert.equal(h.shared.store.listing,null,'paced');
 h.shared.store.listingOpens=h.shared.store.listingOpens.map(o=>({...o,openedAt:Date.now()-200000}));
 await h.events.alarm({name:'queue'});const l2=h.shared.store.listing;assert.equal(l2.jobId,'c2');
 // Timeout: the tab is closed and the job backs off instead of looping.
 h.shared.store.listing={...l2,openedAt:Date.now()-120000};await h.events.alarm({name:'queue'});
 assert(h.shared.removed.includes(l2.tabId));assert(h.shared.store.listingBackoff.c2>Date.now()+5*3600000);
 // A board limit pauses that board's checks; nothing is bypassed.
 h.shared.store.listingOpens=[];h.shared.store.listingBackoff={};const three={id:'c3',url:'https://www.linkedin.com/jobs/view/4012345603'};due.splice(0,2,three);
 h.shared.routes['/jobs/c3/listing-check']=()=>({eligible:true});
 await h.events.alarm({name:'queue'});const l3=h.shared.store.listing;assert.equal(l3.jobId,'c3');
 await h.send('listing-limit',{kind:'rate-limit'},from(h.shared.tabs.find(t=>t.id===l3.tabId)));
 assert(h.shared.store.listingCooldown['linkedin']>Date.now()+11*3600000);assert.match(h.shared.store.error,/paused for 12 hours/);
 h.shared.store.listingBackoff={};await h.events.alarm({name:'queue'});assert.equal(h.shared.store.listing,null,'board paused');
});
