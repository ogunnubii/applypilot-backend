const DASH='https://applypilot-jobs.netlify.app/';
function canonical(url){const u=new URL(url);return u.hostname.replace('job-boards.greenhouse.io','boards.greenhouse.io')+u.pathname.replace(/\/(apply|thanks|thank-you|confirmation)\/?$/,'').replace(/\/$/,'');}
async function api(path,method='GET',data){
 const tabs=await chrome.tabs.query({url:DASH+'*'});if(!tabs.length)throw Error('Open ApplyPilot and sign in, then try again.');
 for(const tab of tabs){const result=await chrome.scripting.executeScript({target:{tabId:tab.id},func:async(path,method,data)=>{const token=sessionStorage.getItem('applypilot-token');if(!token)return {error:'Sign in to ApplyPilot first.'};try{const r=await fetch('https://marvelous-vitality-production-c2d8.up.railway.app/api'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(data)});const d=await r.json();return r.ok?{data:d}:{error:d.error||'Request failed'};}catch{return {error:'Cannot reach ApplyPilot. Keep the dashboard open and retry.'}}},args:[path,method,data??null]});const r=result[0]?.result;if(r?.data)return r.data;if(r?.error!=='Sign in to ApplyPilot first.')throw Error(r?.error||'Dashboard unavailable');}
 throw Error('Sign in to ApplyPilot first.');
}
// GET requests cannot carry a body; the injected bridge removes it below at build time.
async function bindings(){return (await chrome.storage.session.get('bindings')).bindings||{};}
async function save(value){await chrome.storage.session.set({bindings:value});}
let opening=false;
async function handle(m,sender){
 const popup=!sender.tab&&sender.url===chrome.runtime.getURL('popup.html');
 if(popup&&m.action==='list')return api('/jobs');
 if(popup&&m.action==='open'){
  if(opening)throw Error('Another application is opening. Try again.');opening=true;
  try{let map=await bindings(),existing=Object.entries(map).find(([,v])=>v.id===m.id);
   if(existing){try{const tab=await chrome.tabs.get(Number(existing[0]));if(canonical(tab.url)!==canonical(existing[1].url))throw Error();await chrome.tabs.update(tab.id,{active:true});await chrome.tabs.sendMessage(tab.id,{action:'fill'});return {opened:true};}catch{delete map[existing[0]];await save(map);}}
   await api('/jobs/'+m.id+'/local/claim','POST',{});const packet=await api('/jobs/'+m.id+'/local/packet');const tab=await chrome.tabs.create({url:'about:blank'});map[tab.id]={id:m.id,url:packet.job.url,attempted:false};await save(map);let url=packet.job.url;if(new URL(url).hostname==='jobs.lever.co'&&!url.endsWith('/apply'))url=url.replace(/\/$/,'')+'/apply';await chrome.tabs.update(tab.id,{url});return {opened:true};
  }finally{opening=false}
 }
 const map=await bindings(),b=map[sender.tab?.id];if(!b||sender.frameId!==0||canonical(sender.url)!==canonical(b.url))throw Error('This tab is not linked to an active ApplyPilot application.');
 if(m.action==='packet')return api('/jobs/'+b.id+'/local/packet');
 if(m.action==='attempt'){b.attempted=true;await save(map);return {};}
 if(m.action==='progress')return api('/jobs/'+b.id+'/local/progress','POST',{fields:m.fields,message:m.message});
 if(m.action==='receipt'){if(!b.attempted)throw Error('No submission action observed in this tab.');const r=await api('/jobs/'+b.id+'/local/submitted','POST',{receipt:m.receipt,afterSubmit:true});delete map[sender.tab.id];await save(map);return r;}
 if(m.action==='state')return {attempted:b.attempted};
 throw Error('Unsupported action');
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{handle(m,sender).then(data=>reply({ok:true,data})).catch(e=>reply({ok:false,error:e.message}));return true;});
chrome.tabs.onRemoved.addListener(async id=>{const map=await bindings();delete map[id];await save(map);});