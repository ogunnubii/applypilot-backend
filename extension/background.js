importScripts('policy.js','ready-forms.js');
const P=globalThis.ApplyPilotPolicy;
const environments={hosted:{dashboard:'https://marvelous-vitality-production-c2d8.up.railway.app/',pagesDashboard:'https://applypilot-jobs.pages.dev/',legacyDashboard:'https://applypilot-jobs.netlify.app/',api:'https://marvelous-vitality-production-c2d8.up.railway.app/api'},local:null};
// The local server's port is configurable (default 8080). Only that one
// localhost origin is trusted and used; other local services are ignored.
const DEFAULT_LOCAL_PORT=8080;
const localPortOf=state=>Number.isInteger(state?.localPort)&&state.localPort>=1024&&state.localPort<=65535?state.localPort:DEFAULT_LOCAL_PORT;
function environmentFor(state){
 if(state?.environment!=='local')return environments.hosted;
 const origin='http://localhost:'+localPortOf(state);
 return {dashboard:origin+'/assistant',api:origin+'/api',origin};
}
const HOSTED_DASHBOARDS=['https://marvelous-vitality-production-c2d8.up.railway.app','https://applypilot-jobs.pages.dev','https://applypilot-jobs.netlify.app'];
async function trustedDashboard(sender){
 if(!sender.tab||sender.frameId!==0)return false;
 let origin;try{origin=new URL(sender.url).origin;}catch{return false;}
 return HOSTED_DASHBOARDS.includes(origin)||origin===environmentFor(await read()).origin;
}
const read=async()=>({records:{},queue:[],enabled:false,...await chrome.storage.local.get(['records','queue','enabled','device','environment','localPort','error','automaticDefault','userPaused','listing','listingBackoff','listingOpens','listingCooldown'])});
let responsiveDashboardId;
// LinkedIn/Indeed pacing for automatic openings. Conservative fixed limits;
// a board-reported limit pauses that board far longer (see site-error).
const NATIVE_SPACING_MS=120000,NATIVE_DAILY_CAP=25,NATIVE_LIMIT_COOLDOWN_MS=12*60*60*1000;
const siteKey=url=>{try{return P.nativeBoard?.(url)||new URL(url).hostname;}catch{return '';}};
// The tab currently holding a record's application: the bound job tab, or the
// Indeed Apply tab that continuation from that exact job tab produced.
const recordTabId=r=>Number.isInteger(r?.flowTabId)?r.flowTabId:r?.tabId;
const tabHolds=(tab,r)=>!!tab&&(tab.id===r.flowTabId?P.continuationOf?.(tab.url,r.url):P.sameApplication(tab.url,r.url));
async function api(path,method='GET',data){
 const state=await read(),env=environmentFor(state);
 const origins=[env.dashboard,env.pagesDashboard,env.legacyDashboard].filter(Boolean).map(url=>new URL(url).origin+'/*');
 const tabs=(await chrome.tabs.query({url:origins})).sort((a,b)=>Number(!!b.active)-Number(!!a.active)||Number(b.id===responsiveDashboardId)-Number(a.id===responsiveDashboardId)||(b.lastAccessed||0)-(a.lastAccessed||0));
 let lastError;
 for(const tab of tabs){
  if(method!=='GET'){
   // Probe responsiveness before a write. A frozen tab can be skipped safely here;
   // once a write is dispatched it is never replayed through another dashboard.
   let probeTimer;try{
    const probe=await Promise.race([chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>({ready:!!sessionStorage.getItem('applypilot-token')})}),new Promise((_,reject)=>{probeTimer=setTimeout(()=>reject(Error('Dashboard tab did not respond.')),5000);})]);
    if(!probe[0]?.result?.ready){lastError=Error('Sign in to ApplyPilot first.');continue;}
   }catch(error){lastError=error;continue;}finally{clearTimeout(probeTimer);}
  }
  let timer,result;try{const execution=chrome.scripting.executeScript({target:{tabId:tab.id},func:async(base,path,method,data,device)=>{
   const token=sessionStorage.getItem('applypilot-token');if(!token)return {error:'Sign in to ApplyPilot first.'};
   try{const r=await fetch(base+path,{method,signal:AbortSignal.timeout(/\/local\/(?:answer|research-answer)$/.test(path)?60000:15000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-ApplyPilot-Device':device},body:method==='GET'?undefined:JSON.stringify(data)});const d=await r.json();return r.ok?{data:d}:{error:d.error||'Request failed',status:r.status};}catch{return {error:'Cannot reach ApplyPilot. Keep the dashboard open and retry.'};}
  },args:[env.api,path,method,data??null,state.device]});
  result=await Promise.race([execution,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(method==='GET'?'Dashboard tab did not respond.':'ApplyPilot did not acknowledge this request. Refresh the dashboard and check the application before retrying.')),method==='GET'?5000:/\/local\/(?:answer|research-answer)$/.test(path)?65000:20000);})]);
  }catch(error){if(method!=='GET')throw error;lastError=error;continue;}finally{clearTimeout(timer);}
  const r=result[0]?.result;if(r?.data){responsiveDashboardId=tab.id;return r.data;}if(r?.error!=='Sign in to ApplyPilot first.')throw Object.assign(Error(r?.error||'Dashboard unavailable'),{status:r?.status});
 }
 throw lastError||Error('Open ApplyPilot and sign in to sync this browser.');
}
async function listedJobs(){
 const [data,operations]=await Promise.all([api('/jobs'),api('/operations')]);
 const evidence=new Map((operations.applications||[]).map(j=>[j.id,j]));
 return {...data,totals:operations.totals,jobs:data.jobs.map(j=>({...j,evidence:evidence.get(j.id)}))};
}
async function readyJobs(onlyId){
 const data=await listedJobs();
 const state=await read(),jobs=[];let unavailable=0;
 for(const job of data.jobs){
  if(onlyId&&job.id!==onlyId)continue;
  const record=state.records[job.id],source=ApplyPilotReadyForms.source(job,record);
  if(!source||!job.evidence)continue;
  try{
   let expiresAt;
   if(source==='hosted'){
    // View can observe receipts, but cannot open/restart, fill or submit a form.
    const view=await api('/jobs/'+job.id+'/handoff/view','POST',{});
    if(view.submitted||view.closed||!view.frameId||view.expiresAt<=Date.now())continue;
    expiresAt=view.expiresAt;
   }else{
    const tab=await chrome.tabs.get(recordTabId(record)),tabs=await chrome.tabs.query({});
    if(!tabHolds(tab,record)||!P.sameApplication(record.url,job.url)||!Number.isInteger(record.flowTabId)&&tabs.filter(t=>P.sameApplication(t.url,job.url)).length!==1)continue;
    const live=await probeForm(record);
    if(!live?.readyForSubmit||!live.started||live.busy||live.attempted||live.jobId!==job.id||!P.boundApplication?.(live.url,job.url))continue;
    expiresAt=Date.now()+30000;
   }
   jobs.push({...job,ready_form:{source,checked_at:Date.now(),expires_at:expiresAt}});
  }catch{unavailable++;}
 }
 return {...data,jobs,unavailable};
}
async function reviewPrepared(id){
 if(typeof id!=='string'||!/^[-a-f0-9]{36}$/.test(id))throw Error('Choose a prepared application.');
 // Recheck at click time: never use the popup's potentially stale result.
 const job=(await readyJobs(id)).jobs.find(j=>j.id===id);
 if(!job)throw Error('This filled form is no longer ready or available. Refresh the list. No application was restarted.');
 if(job.ready_form.source==='local'){
  const record=(await read()).records[id],tab=await chrome.tabs.get(recordTabId(record));
  if(!tabHolds(tab,record))throw Error('The prepared employer tab has changed. Refresh the list.');
  await chrome.tabs.update(tab.id,{active:true});await chrome.windows.update(tab.windowId,{focused:true});
  return {opened:true,source:'local'};
 }
 const tab=await chrome.tabs.get(responsiveDashboardId);
 await chrome.tabs.update(tab.id,{active:true});await chrome.windows.update(tab.windowId,{focused:true});
 const show=()=>chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:async job=>{
  if(typeof openHandoff!=='function')return {dashboardRequired:true};
  const existing=document.querySelector('#live-browser');
  if(existing&&existing.dataset.preparedJobId!==job.id)return {error:'Close the other live application view first. Its employer session will stay open.'};
  // Open only the existing viewer. The card's handoff/open action can queue a
  // replacement browser after expiry, so deliberately do not click that card.
  await openHandoff(job);
  const panel=document.querySelector('#live-browser');if(panel)panel.dataset.preparedJobId=job.id;
  return document.querySelector('#live-surface img')?.getAttribute('src')?{opened:true,source:'hosted'}:{error:'The live form could not be displayed. Check the connection in ApplyPilot; no application was restarted.'};
 },args:[{id:job.id,title:job.title,company:job.company,url:job.url,challenge:'Ready to submit'}]});
 let result=(await show())[0]?.result;
 if(result?.dashboardRequired){
  // Keep the authenticated tab and its sessionStorage on the same origin.
  await chrome.tabs.update(tab.id,{url:new URL('/assistant?view=settings#job-'+id,tab.url).href});
  for(let attempt=0;attempt<30;attempt++){
   await new Promise(resolve=>setTimeout(resolve,250));
   try{result=(await show())[0]?.result;if(result&&!result.dashboardRequired)break;}catch{}
  }
 }
 if(!result?.opened)throw Error(result?.error||'Open the Applications page in ApplyPilot, then try again.');
 return result;
}
// The account's persisted Start/Stop switch is the source of truth once it has
// been used. Stopping never closes or submits an open form; it only stops new
// applications from opening.
async function followAutopilot(){
 let remote;try{remote=await api('/autopilot');}catch{return;}
 if(!remote?.configured)return;
 const s=await read();
 if(remote.running===false&&(s.enabled||!s.userPaused)){for(const r of Object.values(s.records)){r.auto=false;r.siteRetryAt=0;}await chrome.storage.local.set({enabled:false,userPaused:true,records:s.records});}
 else if(remote.running===true&&(!s.enabled||s.userPaused))await chrome.storage.local.set({enabled:true,userPaused:false,error:''});
}
// Read-only listing checks for saved LinkedIn/Indeed cards: one at a time, in a
// background tab, bound to that exact job, paced with the board's openings, and
// paused on a board limit or verification page. No claim, fill or click.
const LISTING_TIMEOUT_MS=60000,LISTING_BACKOFF_MS=6*60*60*1000;
async function finishListing(s,{backoff=false}={}){
 const l=s.listing;if(!l)return;
 if(Number.isInteger(l.tabId))await chrome.tabs.remove(l.tabId).catch(()=>{});
 const listingBackoff={...(s.listingBackoff||{})};if(backoff)listingBackoff[l.jobId]=Date.now()+LISTING_BACKOFF_MS;
 await chrome.storage.local.set({listing:null,listingBackoff});
}
async function runListingCheck(jobs,s){
 if(s.listing){
  const tab=await chrome.tabs.get(s.listing.tabId).catch(()=>null);
  if(tab&&Date.now()-s.listing.openedAt<LISTING_TIMEOUT_MS)return true;
  await finishListing(s,{backoff:true});return false;
 }
 const now=Date.now(),job=jobs.find(j=>j.listing_check_due===true&&P.nativeBoard?.(j.url)&&!((s.listingBackoff||{})[j.id]>now)&&!Object.values(s.records).some(r=>r.id===j.id)&&nativePaced(j,s));
 if(!job)return false;
 const tab=await chrome.tabs.create({url:job.url,active:false});
 const opens=[...(s.listingOpens||[]).filter(o=>now-o.openedAt<86400000),{url:job.url,openedAt:now}];
 await chrome.storage.local.set({listing:{jobId:job.id,url:job.url,tabId:tab.id,openedAt:now},listingOpens:opens});
 return true;
}
const listingSender=(s,sender)=>!!s.listing&&sender.tab?.id===s.listing.tabId&&sender.frameId===0&&P.sameApplication(sender.url,s.listing.url);
async function initialize(){const s=await read();if(!s.automaticDefault)await chrome.storage.local.set({automaticDefault:true,enabled:true,userPaused:false});if(!s.device)await chrome.storage.local.set({device:crypto.randomUUID()});await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});if(!await chrome.alarms.get('queue'))await chrome.alarms.create('queue',{periodInMinutes:0.5});}
async function saveRecord(record){const s=await read();s.records[record.id]=record;await chrome.storage.local.set({records:s.records});}
async function probeForm(record){
 let timer;try{return await Promise.race([chrome.tabs.sendMessage(recordTabId(record),{action:'preparation-status'},{frameId:Number.isInteger(record.flowTabId)?0:record.frameId||0}),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),2000);})]);}catch{return null;}finally{clearTimeout(timer);}
}
// Recover only an interrupted, unattempted campaign form in its exact existing
// tab. Never reopen a lost form, reload a page, or replay a submission.
async function recoverPreparation(jobs,preparation,state){
 if(!preparation?.enabled||state.userPaused)return false;
 for(const job of jobs.filter(j=>j.preparation).sort((a,b)=>a.queue_position-b.queue_position)){
  const r=state.records[job.id];
  if(!r||r.attempted||Object.keys(r.pendingClicks||{}).length||r.phase==='submitted'||r.phase==='prepared'||r.recoveryCount>=1||job.status!=='local_browser'||job.local_attempt_at||job.employer_hold||job.metadata?.available===false)continue;
  if(!r.interrupted&&!/^Browser stopped responding\./.test(job.last_message||''))continue;
  const tab=Number.isInteger(r.tabId)?await chrome.tabs.get(r.tabId).catch(()=>null):null;
  if(!tab||!P.sameApplication(tab.url,r.url)||(await chrome.tabs.query({})).filter(t=>P.sameApplication(t.url,r.url)).length!==1)continue;
  r.interrupted=false;r.recoveryCount=(r.recoveryCount||0)+1;await saveRecord(r);
  try{
   const packet=await api('/jobs/'+job.id+'/local/packet');
   if(packet.job.attempted||packet.prepareSteps!==true||packet.autonomousSubmit===true)continue;
   const live=await probeForm(r);
   if(live?.attempted)continue;
   if(live?.stopped){continue;} // A real question/verification/ready state stays parked.
   if(live?.busy){r.auto=true;r.phase='ready';r.touched=Date.now();await saveRecord(r);return true;}
   await openJob(job.id,true);return true;
  }catch(e){await chrome.storage.local.set({error:'Preparation recovery paused: '+e.message});}
 }
 return false;
}
async function openJob(id,auto=true,focus=false){
 const s=await read();let record=s.records[id];
 const claim=await api('/jobs/'+id+'/local/claim','POST',{});
 const packet=await api('/jobs/'+id+'/local/packet');
 if(!P.supported(packet.job.url))throw Error('Unsupported employer host');
 const tabs=await chrome.tabs.query({});
 const matches=tabs.filter(t=>P.sameApplication(t.url,packet.job.url));
 let tab=matches.find(t=>record?.tabId===t.id)||(matches.length===1?matches[0]:null);
 if(matches.length>1&&!tab)throw Error('Several copies of this application are open. Close duplicates first.');
 record={safeInitialLoad:!record&&!tab,...record,id,url:packet.job.url,openedAt:Date.now(),attempted:!!(record?.attempted||claim.attempted||packet.job.attempted),auto,manualOpen:!auto,phase:'ready',touched:Date.now()};
 if(record.attempted){record.phase='verifying';record.auto=false;}
 await saveRecord(record);
 await api('/jobs/'+id+'/local/assistance','POST',{kind:record.safeInitialLoad?'tracking':'partial'});
 if(!tab){tab=await chrome.tabs.create({url:'about:blank',active:focus||!auto});record.tabId=tab.id;await saveRecord(record);let url=packet.job.url;if(/^jobs(\.eu)?\.lever\.co$/.test(new URL(url).hostname)&&!url.endsWith('/apply'))url=url.replace(/\/$/,'')+'/apply';await chrome.tabs.update(tab.id,{url});}
 else{record.tabId=tab.id;await saveRecord(record);if(focus||!auto){await chrome.tabs.update(tab.id,{active:true});if(Number.isInteger(tab.windowId))await chrome.windows.update(tab.windowId,{focused:true});}chrome.tabs.sendMessage(tab.id,{action:'fill'},{frameId:record?.frameId||0}).catch(()=>chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[record?.frameId||0]},files:['policy.js','content.js']})).catch(()=>{});}
 return {opened:true,attempted:record.attempted};
}
function eligible(j,s){
 const r=s.records[j.id];
 const review=j.metadata?.manualReview&&j.status==='needs_review'&&j.challenge==='Manual application';
 return (j.execution_mode==='local'||review)&&P.supported(j.url)&&!j.employer_hold&&j.metadata?.available!==false&&!j.local_attempt_at&&!r?.attempted&&!['Unconfirmed submission','Submission in progress','Sensitive action'].includes(j.challenge)&&
 ((j.status==='queued'||review)&&!r)&&!Object.values(s.records).some(other=>other.siteCooldownUntil>Date.now()&&siteKey(other.url)===siteKey(j.url))&&nativePaced(j,s);
}
function nativePaced(j,s){
 if(!P.nativeBoard?.(j.url))return true;
 const same=[...Object.values(s.records),...(s.listingOpens||[])].filter(o=>o.openedAt&&siteKey(o.url)===siteKey(j.url));
 if((s.listingCooldown||{})[siteKey(j.url)]>Date.now())return false;
 return !same.some(o=>Date.now()-o.openedAt<NATIVE_SPACING_MS)&&same.filter(o=>Date.now()-o.openedAt<86400000).length<NATIVE_DAILY_CAP;
}
async function retrySubmissionRecords(){
 const s=await read();let sent=0;
 for(const b of Object.values(s.records))for(const [id,payload] of Object.entries(b.pendingClicks||{})){
  if(sent++>=3)return;
  try{await api('/jobs/'+b.id+'/local/attempt','POST',payload);delete b.pendingClicks[id];await saveRecord(b);}
  catch(e){if(e.status&&e.status<500&&e.status!==429){delete b.pendingClicks[id];b.recordError=e.message;await saveRecord(b);}return;}
 }
}

// Persist evidence before network I/O. This outbox can only synchronize receipts;
// it never opens a tab, fills a field, uploads a file or requests another Submit.
async function flushReceipt(record){
 const pending=record.pendingReceipt;if(!pending)return {ok:true};
 if(Object.keys(record.pendingClicks||{}).length)return {pending:true};
 if(record.receiptSyncRejected)return {pending:true,needsReview:true};
 if(record.receiptRetryAt>Date.now())return {pending:true};
 try{
  const result=await api('/jobs/'+record.id+'/local/submitted','POST',pending);
  record.receiptEvidence=pending;delete record.pendingReceipt;
  record.receiptRetryAt=0;record.receiptSyncError='';record.phase='submitted';record.auto=false;
  await saveRecord(record);return result;
 }catch(error){
  record.receiptFailures=(record.receiptFailures||0)+1;record.receiptSyncError=error.message;
  // Auth/ownership/identity failures require review; transient failures retain
  // durable evidence with capped backoff, at most three requests per alarm.
  record.receiptSyncRejected=!!error.status&&error.status<500&&![401,408,429].includes(error.status);
  record.receiptRetryAt=Date.now()+Math.min(300000,5000*2**Math.min(record.receiptFailures-1,6));
  record.auto=false;record.phase='receipt_pending';await saveRecord(record);
  return {pending:true,needsReview:record.receiptSyncRejected};
 }
}
async function retryReceipts(){
 let count=0;for(const record of Object.values((await read()).records)){
  if(!record.pendingReceipt||record.receiptSyncRejected||record.receiptRetryAt>Date.now())continue;
  if(count++>=3)break;await flushReceipt(record);
 }
}

async function flushAnswerOutbox(record){
 for(const [question,answer]of Object.entries(record.pendingAnswers||{})){
  try{record.lastSavedAnswers=record.lastSavedAnswers||{};if(JSON.stringify(record.lastSavedAnswers[question])!==JSON.stringify(answer)){await api('/jobs/'+record.id+'/answers','PUT',{question,answer:typeof answer==='string'?answer:answer.answer,remember:true,autosave:true,resume:answer.resume===true});Object.defineProperty(record.lastSavedAnswers,question,{value:answer,enumerable:true,configurable:true,writable:true});}delete record.pendingAnswers[question];await saveRecord(record);}
  catch(e){record.answerSaveError=e.message;await saveRecord(record);return {pending:true};}
 }record.answerSaveError='';await saveRecord(record);return {saved:true};
}

async function tick(){
 for(const r of Object.values((await read()).records))if(Object.keys(r.pendingAnswers||{}).length)await flushAnswerOutbox(r);
 await retrySubmissionRecords();
 await retryReceipts();

 await followAutopilot();
 const s=await read();if(!s.enabled||s.userPaused)return;
 const active=Object.values(s.records).find(r=>r.auto&&['ready','verifying'].includes(r.phase));
 if(active){
  const tab=Number.isInteger(recordTabId(active))?await chrome.tabs.get(recordTabId(active)).catch(()=>null):null;
  if(tabHolds(tab,active)&&Date.now()-active.touched<90000)return;
  if(tabHolds(tab,active)&&!active.attempted){const live=await probeForm(active);if(live?.busy&&!live.attempted){active.touched=Date.now();await saveRecord(active);return;}}
  active.phase='blocked';active.auto=false;active.interrupted=!active.attempted;await saveRecord(active);
  await api('/jobs/'+active.id+'/local/progress','POST',{blocked:true,fields:[],message:active.attempted?'Submission uncertain; check employer receipt.':'Browser stopped responding. Reopen from extension.'}).catch(()=>{});
 }
 const waiting=Object.values(s.records).find(r=>r.siteRetryAt&&r.siteRetryAt<=Date.now());
 if(waiting){
  // The one allowed retry is a fresh GET of a new, empty landing page. Never replay form navigation.
  const tab=Number.isInteger(waiting.tabId)?await chrome.tabs.get(waiting.tabId).catch(()=>null):null;
  waiting.siteRetryAt=0;await saveRecord(waiting);
  if(!waiting.attempted&&waiting.safeInitialLoad&&!waiting.formTouched&&!waiting.steps&&tab&&P.sameApplication(tab.url,waiting.url)){
   try{
    const packet=await api('/jobs/'+waiting.id+'/local/packet');
    if(!packet.job.attempted){
     waiting.phase='ready';waiting.auto=true;waiting.touched=Date.now();await saveRecord(waiting);
     await api('/jobs/'+waiting.id+'/local/progress','POST',{blocked:false,fields:[],message:'Checking the employer page once after its temporary outage.'});
     await chrome.tabs.update(tab.id,{url:waiting.url});return;
    }
    waiting.attempted=true;
   }catch(e){await chrome.storage.local.set({error:'Employer page retry paused: '+e.message});}
  }
  waiting.auto=false;waiting.phase='blocked';await saveRecord(waiting);
 }
 const fresh=await read();let jobs,preparation,listingChecks;try{({jobs,preparation,listing_checks:listingChecks}=await api('/jobs'));}catch(e){await chrome.storage.local.set({error:e.message});return;}
 if(await recoverPreparation(jobs,preparation,fresh))return;
 if(await runListingCheck(Array.isArray(listingChecks)?listingChecks.map(j=>({...j,listing_check_due:true})):jobs,fresh))return;
 const candidates=jobs.filter(j=>(!preparation?.enabled||j.preparation)&&eligible(j,fresh));const queue=[...new Set([...fresh.queue,...candidates.map(j=>j.id)])].filter(id=>candidates.some(j=>j.id===id)).sort((a,b)=>(Number(candidates.find(j=>j.id===a)?.queue_position)||Infinity)-(Number(candidates.find(j=>j.id===b)?.queue_position)||Infinity)||Number(candidates.find(j=>j.id===b)?.match_score||0)-Number(candidates.find(j=>j.id===a)?.match_score||0));await chrome.storage.local.set({queue,error:''});const id=queue[0];if(!id)return;
 try{await openJob(id,true);await chrome.storage.local.set({queue:queue.slice(1),error:''});}
 catch(e){if([400,409].includes(e.status)){await saveRecord({id,url:candidates.find(j=>j.id===id).url,auto:false,phase:'blocked',touched:Date.now()});await chrome.storage.local.set({queue:queue.slice(1),error:'Skipped blocked application: '+e.message});}else await chrome.storage.local.set({error:e.message});}
}
async function handle(m,sender){
 await initialize();
 if(m.action==='listing-role'){const s=await read();return {inspect:listingSender(s,sender)};}
 if(m.action==='listing-check'||m.action==='listing-limit'){
  const s=await read();if(!listingSender(s,sender))throw Error('This tab is not a listing check.');
  if(m.action==='listing-limit'){
   // A board limit pauses checks on that board for 12 hours; a verification page for 1 hour (the applicant must complete it).
   const board=siteKey(s.listing.url),listingCooldown={...(s.listingCooldown||{}),[board]:Date.now()+(m.kind==='rate-limit'?NATIVE_LIMIT_COOLDOWN_MS:3600000)};
   await chrome.storage.local.set({listingCooldown,error:m.kind==='rate-limit'?'The job board reported a limit; listing checks on it are paused for 12 hours.':'The job board asked for a security verification; complete it in your browser. Listing checks on it are paused for 1 hour.'});
   await finishListing(await read(),{backoff:true});return {};
  }
  const {action,...snapshot}=m;void action;
  let result;try{result=await api('/jobs/'+s.listing.jobId+'/listing-check','POST',{...snapshot,url:sender.url});}catch(e){await finishListing(await read(),{backoff:true});throw e;}
  await finishListing(await read(),{backoff:result.eligible!==true});return result;
 }
 if(m.action==='board-import'){
  // Only from a top-level LinkedIn/Indeed search page the applicant is viewing.
  let from;try{from=new URL(sender.url);}catch{throw Error('Untrusted page.');}
  const board=from.protocol==='https:'&&(from.hostname==='www.linkedin.com'&&/^\/jobs\/(?:search|collections)\b/.test(from.pathname)?'linkedin':/^(?:www|[a-z]{2})\.indeed\.com$/.test(from.hostname)&&/^\/(?:jobs|q-|m\/jobs)/.test(from.pathname)?'indeed':null);
  if(!sender.tab||sender.frameId!==0||!board||m.board!==board)throw Error('Import jobs from a LinkedIn or Indeed search results page.');
  const jobs=(Array.isArray(m.jobs)?m.jobs:[]).slice(0,50).filter(j=>P.nativeBoard?.(j?.url)===board).map(j=>({url:j.url,title:String(j.title||'').slice(0,200),company:String(j.company||'').slice(0,200),location:String(j.location||'').slice(0,200)}));
  if(!jobs.length)throw Error('No supported jobs were found on this page.');
  return api('/jobs/board-import','POST',{board,jobs});
 }
 if(m.action==='dashboard-status'){
  if(!await trustedDashboard(sender))throw Error('Untrusted dashboard.');
  const s=await read();return {version:chrome.runtime.getManifest().version,enabled:!!s.enabled,queued:s.queue.length,error:s.error||''};
 }
 if(m.action==='open-from-dashboard'){
  if(!await trustedDashboard(sender))throw Error('Untrusted dashboard.');
  return openJob(m.id,false,true);
 }
 if(m.action==='resume-existing'){
  if(!await trustedDashboard(sender))throw Error('Untrusted dashboard.');
  const s=await read(),record=s.records[m.id];
  if(!record||record.attempted||record.phase==='submitted')throw Error('This application cannot automatically restart. Check its employer receipt.');
  if(Object.values(s.records).some(r=>r.id!==m.id&&r.auto&&['ready','verifying'].includes(r.phase)))throw Error('Another application is running. Your answers are saved; resume this one after it finishes.');
  const {jobs}=await api('/jobs'),job=jobs.find(j=>j.id===m.id);
  if(!job||job.status!=='local_browser'||job.local_attempt_at||['Unconfirmed submission','Submission in progress'].includes(job.challenge))throw Error('A submission may already have occurred. Check the employer receipt.');
  return openJob(m.id,true);
 }
 if(m.action==='focus-existing'){
  if(!await trustedDashboard(sender))throw Error('Untrusted dashboard.');
  const s=await read(),record=s.records[m.id];
  if(!Number.isInteger(recordTabId(record)))throw Error('The original employer tab is no longer open. Open ApplyPilot Local to review this application before restarting it.');
  const tab=await chrome.tabs.get(recordTabId(record)).catch(()=>null);
  if(!tabHolds(tab,record))throw Error('The original employer form is no longer available. Open ApplyPilot Local to review it; no application was restarted.');
  await chrome.tabs.update(tab.id,{active:true});await chrome.windows.update(tab.windowId,{focused:true});
  // Filling requests its packet through this same serialized message queue.
  // Release the queue before waiting on content-script work to avoid deadlock.
  chrome.tabs.sendMessage(tab.id,{action:'fill'},{frameId:tab.id===record.flowTabId?0:record.frameId||0}).catch(()=>chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[tab.id===record.flowTabId?0:record.frameId||0]},files:['policy.js','content.js']})).catch(e=>chrome.storage.local.set({error:'Could not refill the employer form: '+e.message}));return {focused:true};
 }
 const popup=!sender.tab&&sender.url===chrome.runtime.getURL('popup.html');
 if(popup){
  if(m.action==='list')return {...await readyJobs(),state:await read()};
  if(m.action==='review-prepared')return reviewPrepared(m.id);
  if(m.action==='open')return openJob(m.id,m.auto!==false,m.auto===false);
  if(m.action==='mark-completed'){
   if(typeof m.id!=='string'||!/^[-a-f0-9]{36}$/.test(m.id))throw Error('Choose a tracked application.');
   const result=await api('/jobs/'+m.id+'/report-submitted','POST',{reported:true});
   const state=await read(),record=state.records[m.id];if(record){record.attempted=true;record.phase='submitted';record.auto=false;record.siteRetryAt=0;record.pendingClicks={};}
   await chrome.storage.local.set({records:state.records,queue:state.queue.filter(id=>id!==m.id)});return result;
  }
  if(m.action==='funnel'){const s=await read();return chrome.tabs.create({url:environmentFor(s).dashboard+'?view=funnel'});}
  if(m.action==='dashboard'){const s=await read();return chrome.tabs.create({url:environmentFor(s).dashboard});}
  if(m.action==='environment'){
   if(!['hosted','local'].includes(m.value))throw Error('Unknown environment');
   const port=m.port===undefined?undefined:Number(m.port);
   if(port!==undefined&&!(Number.isInteger(port)&&port>=1024&&port<=65535))throw Error('Use a local port between 1024 and 65535.');
   const s=await read(),next={environment:m.value,localPort:port??localPortOf(s)};
   if(next.environment===s.environment&&(next.environment!=='local'||next.localPort===localPortOf(s)))return {};
   if(Object.keys(s.records).length)throw Error('Use a separate browser profile for another server while applications are tracked');
   await chrome.storage.local.set({...next,enabled:false,queue:[]});return {};
  }
  if(m.action==='stop'){const s=await read();for(const r of Object.values(s.records)){r.auto=false;r.siteRetryAt=0;}await chrome.storage.local.set({enabled:false,userPaused:true,records:s.records});await api('/autopilot','PUT',{running:false,source:'extension'}).catch(()=>{});return {};}
  if(m.action==='start'){
   await api('/autopilot','PUT',{running:true,source:'extension'}).catch(()=>{});
   const {jobs}=await api('/jobs'),s=await read();const ids=jobs.filter(j=>eligible(j,s)).map(j=>j.id);
   await chrome.storage.local.set({queue:[...new Set([...s.queue,...ids])],enabled:true,userPaused:false,error:''});await tick();return {count:ids.length};
  }
 }
 const s=await read();
 let b=Object.values(s.records).find(r=>r.tabId===sender.tab?.id&&P.sameApplication(sender.url,r.url)||Number.isInteger(r.flowTabId)&&r.flowTabId===sender.tab?.id&&P.continuationOf?.(sender.url,r.url));
 if(!b&&m.action==='packet'&&sender.frameId===0&&P.nativeContinuation?.(sender.url)){
  // Adopt Indeed Apply only right after this extension opened it from the
  // exact bound job tab (same tab or a tab that tab opened). Single use.
  const pending=Object.values(s.records).filter(r=>!r.attempted&&!Number.isInteger(r.flowTabId)&&r.flowPendingAt>Date.now()-60000&&(sender.tab?.id===r.tabId||sender.tab?.openerTabId===r.tabId)&&P.continuationOf?.(sender.url,r.url));
  if(pending.length===1){b=pending[0];b.flowTabId=sender.tab.id;b.flowPendingAt=0;await saveRecord(b);}
 }
 if(!b&&m.action==='packet'&&(sender.frameId===0||P.trustedFrame?.(sender,sender.url)===true)){
  const matches=Object.values(s.records).filter(r=>P.sameApplication(sender.url,r.url));
  if(matches.length===1){const tabs=await chrome.tabs.query({});if(tabs.filter(t=>P.sameApplication(t.url,matches[0].url)).length===1){b=matches[0];b.tabId=sender.tab.id;b.auto=false;await saveRecord(b);}}
 }
 if(!b||!(sender.frameId===0||sender.tab?.id!==b.flowTabId&&P.trustedFrame?.(sender,b.url)===true))throw Error('This tab is not linked to an active ApplyPilot application.');
 if(m.action==='packet'){b.frameId=sender.frameId;const packet=await api('/jobs/'+b.id+'/local/packet');b.attempted=!!(b.attempted||packet.job.attempted);await saveRecord(b);b.autonomousSubmit=packet.autonomousSubmit===true;b.prepareSteps=packet.prepareSteps===true;await saveRecord(b);return {...packet,automatic:!b.attempted&&s.enabled&&!s.userPaused&&(b.auto||b.autonomousSubmit||b.prepareSteps),autofillOnly:!b.autonomousSubmit};}
 if(m.action==='attention-position'){const {jobs,preparation}=await listedJobs(),member=jobs.find(j=>j.id===b.id)?.preparation;if(preparation?.enabled&&member)return {position:member.position,total:preparation.target};const waiting=P.attentionOrder(jobs),index=waiting.findIndex(j=>j.id===b.id);return {position:index<0?0:index+1,total:waiting.length};}
 if(m.action==='state')return {flowElsewhere:Number.isInteger(b.flowTabId)&&b.flowTabId!==sender.tab?.id,attempted:b.attempted,automatic:!b.attempted&&s.enabled&&!s.userPaused&&(b.auto||b.autonomousSubmit||b.prepareSteps),autofillOnly:!b.autonomousSubmit,prepareSteps:!!b.prepareSteps,autonomousSubmit:!!b.autonomousSubmit,refreshEnabled:!!s.enabled&&!s.userPaused,phase:b.phase};
 if(m.action==='preparation-heartbeat'){
  if(!s.enabled||s.userPaused||b.attempted||b.phase==='submitted')return {continue:false};
  b.touched=Date.now();await saveRecord(b);return {continue:true};
 }
 if(m.action==='posting'){
  if(b.attempted)throw Error('Submission already started.');
  const result=await api('/jobs/'+b.id+'/local/posting','POST',{...m,action:undefined,url:sender.url});
  b.postingEligible=result.eligible===true;b.postingCheckedAt=Date.now();await saveRecord(b);return result;
 }
 if(m.action==='assistance'){b.assisted=true;await saveRecord(b);return api('/jobs/'+b.id+'/local/assistance','POST',{kind:'human'});}
 if(m.action==='cover-letter'){
  if(b.attempted)throw Error('Submission already started.');
  const result=await api('/jobs/'+b.id+'/local/cover-letter','POST',{question:m.question,required:m.required,format:m.format,accept:m.accept,maxLength:m.maxLength,fieldHelp:m.fieldHelp});
  if(result.manualSubmit){b.autonomousSubmit=false;await saveRecord(b);}return result;
 }
 if(m.action==='answer'){if(b.attempted)throw Error('Submission already started.');return api('/jobs/'+b.id+'/local/answer','POST',{question:m.question,choices:m.choices,answerFormat:m.answerFormat,maxLength:m.maxLength,fieldHelp:m.fieldHelp});}
 if(m.action==='research-answer')return api('/jobs/'+b.id+'/local/research-answer','POST',{question:m.question});
 if(m.action==='research-used')return api('/jobs/'+b.id+'/local/research-used','POST',{questions:m.questions});
 if(m.action==='attempt'){
  const automatic=m.automatic===true&&b.autonomousSubmit===true&&s.enabled&&!s.userPaused;
  if(m.human!==true&&!automatic)throw Error('Automation was stopped. Review the employer form manually.');
  b.attempted=true;b.phase='verifying';b.touched=Date.now();await saveRecord(b);
  const clickId=m.clickId||'legacy',payload={url:sender.url,before:String(m.before||'').slice(0,20000),human:m.human===true,clickId,humanAssisted:!!b.assisted,automatic};b.pendingClicks=b.pendingClicks||{};if(!automatic)b.pendingClicks[clickId]=payload;await saveRecord(b);
  try{const result=await api('/jobs/'+b.id+'/local/attempt','POST',payload);delete b.pendingClicks[clickId];await saveRecord(b);return result;}catch(e){b.auto=false;b.phase='blocked';if(e.status&&e.status<500&&e.status!==429)delete b.pendingClicks[clickId];await saveRecord(b);throw e;}
 }
 if(m.action==='step'){if(P.nativeBoard?.(b.url)&&!Number.isInteger(b.flowTabId)&&(!b.postingEligible||Date.now()-(b.postingCheckedAt||0)>3600000))throw Error('Check this job-board posting before opening its application.');if(m.entry===true&&P.nativeBoard?.(b.url)==='indeed'){b.flowPendingAt=Date.now();await saveRecord(b);}const manualEntry=m.entry===true&&b.manualOpen&&!b.entryOpened&&!b.attempted;if(!manualEntry&&(!s.enabled||s.userPaused||!(b.auto||b.autonomousSubmit||b.prepareSteps)))throw Error('Automation was stopped');if((b.steps||0)>=15)throw Error('Step limit reached. Continue manually.');await api('/jobs/'+b.id+'/local/step','POST',{});if(m.entry===true)b.entryOpened=true;b.steps=(b.steps||0)+1;await saveRecord(b);return {};}
 if(m.action==='form-opened'){b.formTouched=true;b.safeInitialLoad=false;b.siteRetryAt=0;await saveRecord(b);return {};}
 if(m.action==='site-error'){
  const issue=P.employerPageIssue({status:m.code});if(!issue)throw Error('Unrecognized employer page error.');
  const canRetry=issue.retryable&&s.enabled&&b.auto&&!b.attempted&&b.safeInitialLoad&&!b.formTouched&&!b.steps&&m.empty===true&&m.initial===true&&!(b.siteRetries>0);
  let message=issue.message;
  b.siteCooldownUntil=issue.retryable||issue.code===429?Date.now()+(m.native===true&&issue.code===429&&P.nativeBoard?.(b.url)?NATIVE_LIMIT_COOLDOWN_MS:issue.code===429?300000:60000):0;
  if(m.native===true&&issue.code===429&&P.nativeBoard?.(b.url))message='The job board reported an application limit. This board is paused for 12 hours; other boards continue.';
  b.siteRetryAt=canRetry?Date.now()+60000:0;
  if(canRetry){b.siteRetries=(b.siteRetries||0)+1;message+=' Will check this empty page once in about a minute; other employer sites can continue.';}
  else if(b.attempted)message+=' A submission may already have occurred. Check for an employer receipt; automatic retry is disabled.';
  else message+=' Automatic retry is paused. Refresh the employer page later when it is available.';
  b.phase='blocked';b.auto=false;b.touched=Date.now();await saveRecord(b);
  await api('/jobs/'+b.id+'/local/progress','POST',{blocked:true,fields:[],message});
  await tick();return {message};
 }
 if(m.action==='progress'){
  if(Number(m.filled)>0){b.formTouched=true;b.safeInitialLoad=false;b.siteRetryAt=0;}
  b.touched=Date.now();b.interrupted=false;if(m.blocked){b.phase=m.readyForSubmit===true?'prepared':'blocked';b.auto=false;}await saveRecord(b);
  const result=await api('/jobs/'+b.id+'/local/progress','POST',{fields:m.fields,message:m.message,blocked:m.blocked,step:Number.isInteger(m.step)?m.step:undefined,filled:m.filled,progress:m.progress,formLanguage:m.formLanguage,readyForSubmit:m.readyForSubmit===true,url:sender.url});if(m.blocked)await tick();return result;
 }
 if(m.action==='capture')return api('/jobs/'+b.id+'/local/capture','POST',{fields:m.fields});
 if(m.action==='autosave'){if(typeof m.question!=='string'||typeof m.answer!=='string'||!m.answer.trim()||m.answer.length>4000||P.sensitive(m.question)||/password|one.?time|verification code|captcha|API key|access token/i.test(m.question))throw Error('This answer cannot be saved automatically.');b.pendingAnswers=b.pendingAnswers||{};Object.defineProperty(b.pendingAnswers,m.question,{value:{answer:m.answer.trim(),resume:m.resume===true},enumerable:true,configurable:true,writable:true});await saveRecord(b);return flushAnswerOutbox(b);}
 if(m.action==='remember')return api('/jobs/'+b.id+'/answers','PUT',{question:m.question,answer:m.answer,remember:true});
 if(m.action==='receipt'){
  if(!b.attempted)throw Error('No submission action observed in this tab.');
  if(!P.receipt(m.receipt)||!(P.sameApplication(sender.url,b.url)||sender.tab?.id===b.flowTabId&&P.continuationOf?.(sender.url,b.url)))throw Error('A matching employer receipt is required.');
  if(b.receiptEvidence)return {ok:true};
  b.pendingReceipt||={receipt:String(m.receipt).slice(0,300),url:sender.url,afterSubmit:true,observedAt:new Date().toISOString(),receiptId:crypto.randomUUID()};
  b.auto=false;b.phase='receipt_pending';await saveRecord(b);
  const result=await flushReceipt(b);await tick();return result;
 }
 throw Error('Unsupported action');
}
// Serialize storage mutations across messages, alarms and tab events.
let chain=Promise.resolve();
function serial(fn){const result=chain.then(fn);chain=result.catch(()=>{});return result;}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{(['list','dashboard-status','state','attention-position','answer','research-answer'].includes(m.action)?handle(m,sender):serial(()=>handle(m,sender))).then(data=>reply({ok:true,data})).catch(e=>reply({ok:false,error:e.message,status:e.status}));return true;});
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='queue')return serial(tick).catch(()=>{});});
chrome.runtime.onStartup.addListener(()=>serial(async()=>{await initialize();const s=await read();for(const r of Object.values(s.records)){r.interrupted=!r.attempted&&r.auto&&r.phase==='ready';r.auto=false;r.siteRetryAt=0;if(r.phase!=='submitted'&&r.phase!=='prepared')r.phase='blocked';}await chrome.storage.local.set({records:s.records,enabled:!s.userPaused,error:'Browser restarted. Eligible preparation resumes in its existing tab after sign-in; previous submission attempts remain protected.'});}));
chrome.runtime.onInstalled.addListener(()=>serial(initialize));
chrome.tabs.onRemoved.addListener(id=>serial(async()=>{const s=await read();for(const r of Object.values(s.records))if(r.flowTabId===id){r.flowTabId=null;r.auto=false;if(r.phase!=='submitted')r.phase='blocked';}else if(r.tabId===id){r.tabId=null;r.auto=false;r.siteRetryAt=0;if(r.phase!=='submitted')r.phase='blocked';}await chrome.storage.local.set({records:s.records});await tick();}).catch(()=>{}));

