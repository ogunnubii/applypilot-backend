importScripts('policy.js');
const P=globalThis.ApplyPilotPolicy;
const environments={hosted:{dashboard:'https://applypilot-jobs.pages.dev/',legacyDashboard:'https://applypilot-jobs.netlify.app/',api:'https://marvelous-vitality-production-c2d8.up.railway.app/api'},local:{dashboard:'http://localhost:8080/assistant',api:'http://localhost:8080/api'}};
const read=async()=>({records:{},queue:[],enabled:false,...await chrome.storage.local.get(['records','queue','enabled','device','environment','error','automaticDefault','userPaused'])});
async function api(path,method='GET',data){
 const state=await read(),env=environments[state.environment]||environments.hosted;
 const origins=[env.dashboard,env.legacyDashboard].filter(Boolean).map(url=>new URL(url).origin+'/*');
 const tabs=await chrome.tabs.query({url:origins});
 for(const tab of tabs){
  const result=await chrome.scripting.executeScript({target:{tabId:tab.id},func:async(base,path,method,data,device)=>{
   const token=sessionStorage.getItem('applypilot-token');if(!token)return {error:'Sign in to ApplyPilot first.'};
   try{const r=await fetch(base+path,{method,signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-ApplyPilot-Device':device},body:method==='GET'?undefined:JSON.stringify(data)});const d=await r.json();return r.ok?{data:d}:{error:d.error||'Request failed',status:r.status};}catch{return {error:'Cannot reach ApplyPilot. Keep the dashboard open and retry.'};}
  },args:[env.api,path,method,data??null,state.device]});
  const r=result[0]?.result;if(r?.data)return r.data;if(r?.error!=='Sign in to ApplyPilot first.')throw Object.assign(Error(r?.error||'Dashboard unavailable'),{status:r?.status});
 }
 throw Error('Open ApplyPilot and sign in to sync this browser.');
}
async function initialize(){const s=await read();if(!s.automaticDefault)await chrome.storage.local.set({automaticDefault:true,enabled:true,userPaused:false});if(!s.device)await chrome.storage.local.set({device:crypto.randomUUID()});await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});if(!await chrome.alarms.get('queue'))await chrome.alarms.create('queue',{periodInMinutes:0.5});}
async function saveRecord(record){const s=await read();s.records[record.id]=record;await chrome.storage.local.set({records:s.records});}
async function openJob(id,auto=true){
 const s=await read();let record=s.records[id];
 const claim=await api('/jobs/'+id+'/local/claim','POST',{});
 const packet=await api('/jobs/'+id+'/local/packet');
 if(!P.supported(packet.job.url))throw Error('Unsupported employer host');
 const tabs=await chrome.tabs.query({});
 const matches=tabs.filter(t=>P.sameApplication(t.url,packet.job.url));
 let tab=matches.find(t=>record?.tabId===t.id)||(matches.length===1?matches[0]:null);
 if(matches.length>1&&!tab)throw Error('Several copies of this application are open. Close duplicates first.');
 record={...record,id,url:packet.job.url,attempted:!!(record?.attempted||claim.attempted||packet.job.attempted),auto,phase:'ready',touched:Date.now()};
 if(record.attempted){record.phase='verifying';record.auto=false;}
 await saveRecord(record);
 if(!tab){tab=await chrome.tabs.create({url:'about:blank',active:!auto});record.tabId=tab.id;await saveRecord(record);let url=packet.job.url;if(/^jobs(\.eu)?\.lever\.co$/.test(new URL(url).hostname)&&!url.endsWith('/apply'))url=url.replace(/\/$/,'')+'/apply';await chrome.tabs.update(tab.id,{url});}
 else{record.tabId=tab.id;await saveRecord(record);if(!auto)await chrome.tabs.update(tab.id,{active:true});chrome.tabs.sendMessage(tab.id,{action:'fill'}).catch(()=>chrome.scripting.executeScript({target:{tabId:tab.id},files:['policy.js','content.js']})).catch(()=>{});}
 return {opened:true,attempted:record.attempted};
}
function eligible(j,s){
 const r=s.records[j.id];
 return j.execution_mode==='local'&&P.supported(j.url)&&!j.local_attempt_at&&!r?.attempted&&!['Unconfirmed submission','Submission in progress','Sensitive action'].includes(j.challenge)&&
 (['saved','queued','paused','needs_review'].includes(j.status)&&!r);
}
async function tick(){
 const s=await read();if(!s.enabled)return;
 const active=Object.values(s.records).find(r=>r.auto&&['ready','verifying'].includes(r.phase));
 if(active){
  const tab=await chrome.tabs.get(active.tabId).catch(()=>null);
  if(tab&&P.sameApplication(tab.url,active.url)&&Date.now()-active.touched<90000)return;
  active.phase='blocked';active.auto=false;await saveRecord(active);
  await api('/jobs/'+active.id+'/local/progress','POST',{blocked:true,fields:[],message:active.attempted?'Submission uncertain; check employer receipt.':'Browser stopped responding. Reopen from extension.'}).catch(()=>{});
 }
 const fresh=await read();let jobs;try{({jobs}=await api('/jobs'));}catch(e){await chrome.storage.local.set({error:e.message});return;}const candidates=jobs.filter(j=>eligible(j,fresh));const queue=[...new Set([...fresh.queue,...candidates.map(j=>j.id)])].filter(id=>candidates.some(j=>j.id===id));await chrome.storage.local.set({queue,error:''});const id=queue[0];if(!id)return;
 try{await openJob(id,true);await chrome.storage.local.set({queue:queue.slice(1),error:''});}
 catch(e){if([400,409].includes(e.status)){await saveRecord({id,url:candidates.find(j=>j.id===id).url,auto:false,phase:'blocked',touched:Date.now()});await chrome.storage.local.set({queue:queue.slice(1),error:'Skipped blocked application: '+e.message});}else await chrome.storage.local.set({error:e.message});}
}
async function handle(m,sender){
 await initialize();
 if(m.action==='focus-existing'){
  const allowed=['https://applypilot-jobs.pages.dev','https://applypilot-jobs.netlify.app','http://localhost:8080'];
  if(!sender.tab||sender.frameId!==0||!allowed.includes(new URL(sender.url).origin))throw Error('Untrusted dashboard.');
  const s=await read(),record=s.records[m.id];
  if(!record?.tabId)throw Error('The original employer tab is no longer open. Open ApplyPilot Local to review this application before restarting it.');
  const tab=await chrome.tabs.get(record.tabId).catch(()=>null);
  if(!tab||!P.sameApplication(tab.url,record.url))throw Error('The original employer form is no longer available. Open ApplyPilot Local to review it; no application was restarted.');
  await chrome.tabs.update(tab.id,{active:true});await chrome.windows.update(tab.windowId,{focused:true});await chrome.tabs.sendMessage(tab.id,{action:'fill'}).catch(()=>chrome.scripting.executeScript({target:{tabId:tab.id},files:['policy.js','content.js']}));return {focused:true};
 }
 const popup=!sender.tab&&sender.url===chrome.runtime.getURL('popup.html');
 if(popup){
  if(m.action==='list')return {...await api('/jobs'),state:await read()};
  if(m.action==='open')return openJob(m.id,m.auto!==false);
  if(m.action==='dashboard'){const s=await read();return chrome.tabs.create({url:(environments[s.environment]||environments.hosted).dashboard});}
  if(m.action==='environment'){if(!environments[m.value])throw Error('Unknown environment');const s=await read();if(Object.keys(s.records).length)throw Error('Use a separate browser profile for another server while applications are tracked');await chrome.storage.local.set({environment:m.value,enabled:false,queue:[]});return {};}
  if(m.action==='stop'){const s=await read();for(const r of Object.values(s.records))r.auto=false;await chrome.storage.local.set({enabled:false,userPaused:true,records:s.records});return {};}
  if(m.action==='start'){
   const {jobs}=await api('/jobs'),s=await read();const ids=jobs.filter(j=>eligible(j,s)).map(j=>j.id);
   await chrome.storage.local.set({queue:[...new Set([...s.queue,...ids])],enabled:true,userPaused:false,error:''});await tick();return {count:ids.length};
  }
 }
 const s=await read();
 let b=Object.values(s.records).find(r=>r.tabId===sender.tab?.id&&P.sameApplication(sender.url,r.url));
 if(!b&&m.action==='packet'){
  const matches=Object.values(s.records).filter(r=>P.sameApplication(sender.url,r.url));
  if(matches.length===1){const tabs=await chrome.tabs.query({});if(tabs.filter(t=>P.sameApplication(t.url,matches[0].url)).length===1){b=matches[0];b.tabId=sender.tab.id;b.auto=false;await saveRecord(b);}}
 }
 if(!b||sender.frameId!==0)throw Error('This tab is not linked to an active ApplyPilot application.');
 if(m.action==='packet'){const packet=await api('/jobs/'+b.id+'/local/packet');b.attempted=!!(b.attempted||packet.job.attempted);await saveRecord(b);return {...packet,automatic:b.auto&&!b.attempted};}
 if(m.action==='state')return {attempted:b.attempted,automatic:b.auto&&!b.attempted,phase:b.phase};
 if(m.action==='attempt'){
  if(m.human!==true)throw Error('Review the employer form and click Submit yourself.');
  if(m.human!==true&&!b.auto)throw Error('Automation was stopped. Review the employer form manually.');
  b.attempted=true;b.phase='verifying';b.touched=Date.now();await saveRecord(b);
  await api('/jobs/'+b.id+'/local/attempt','POST',{url:sender.url,before:m.before,human:m.human===true});return {};
 }
 if(m.action==='step'){if(!b.auto)throw Error('Automation was stopped');b.steps=(b.steps||0)+1;if(b.steps>15)throw Error('Step limit reached. Continue manually.');await saveRecord(b);return {};}
 if(m.action==='progress'){
  b.touched=Date.now();if(m.blocked){b.phase='blocked';b.auto=false;}await saveRecord(b);
  const result=await api('/jobs/'+b.id+'/local/progress','POST',{fields:m.fields,message:m.message,blocked:m.blocked});if(m.blocked)await tick();return result;
 }
 if(m.action==='capture')return api('/jobs/'+b.id+'/local/capture','POST',{fields:m.fields});
 if(m.action==='remember')return api('/jobs/'+b.id+'/answers','PUT',{question:m.question,answer:m.answer,remember:true});
 if(m.action==='receipt'){
  if(!b.attempted)throw Error('No submission action observed in this tab.');
  const r=await api('/jobs/'+b.id+'/local/submitted','POST',{receipt:m.receipt,url:sender.url,afterSubmit:true});
  b.phase='submitted';b.auto=false;await saveRecord(b);await tick();return r;
 }
 throw Error('Unsupported action');
}
// Serialize storage mutations across messages, alarms and tab events.
let chain=Promise.resolve();
function serial(fn){const result=chain.then(fn);chain=result.catch(()=>{});return result;}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{serial(()=>handle(m,sender)).then(data=>reply({ok:true,data})).catch(e=>reply({ok:false,error:e.message}));return true;});
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='queue')serial(tick).catch(()=>{});});
chrome.runtime.onStartup.addListener(()=>serial(async()=>{await initialize();const s=await read();for(const r of Object.values(s.records)){r.auto=false;if(r.phase!=='submitted')r.phase='blocked';}await chrome.storage.local.set({records:s.records,enabled:!s.userPaused,error:'Browser restarted. Existing unfinished applications remain paused; new eligible jobs continue automatically.'});}));
chrome.runtime.onInstalled.addListener(()=>serial(initialize));
chrome.tabs.onRemoved.addListener(id=>serial(async()=>{const s=await read();for(const r of Object.values(s.records))if(r.tabId===id){r.tabId=null;r.auto=false;if(r.phase!=='submitted')r.phase='blocked';}await chrome.storage.local.set({records:s.records});await tick();}).catch(()=>{}));
