'use strict';
(()=>{
 const destination='http://127.0.0.1:17780',sourceProject='ogunnubii/applypilot-backend';
 const $=id=>document.getElementById(id),peer=window.opener;
 let enabledUntil=0,busy=false,snapshot=null,signedIn=false;
 const remembered=localStorage.getItem('applypilot-remembered-token');
 if(remembered)sessionStorage.setItem('applypilot-token',remembered);
 const token=remembered||sessionStorage.getItem('applypilot-token')||'';
 const status=message=>{$('status').textContent=message;};
 async function api(path,body){
  const response=await fetch(path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error||'Request failed'),{code:value.code||(response.status===401?'sign_in_required':'request_failed')});return value;
 }
 function summarize(value){snapshot=value;$('download').disabled=false;$('summary').hidden=false;const counts={};for(const row of value.records)counts[row.status]=(counts[row.status]||0)+1;$('summary').textContent=`Protected jobs: ${value.records.length}\nEmployer holds: ${value.employer_holds.length}\nRevision: ${value.revision}\nChecked: ${value.generated_at}\n`+Object.entries(counts).map(([key,n])=>`${key}: ${n}`).join('\n');}
 function send(message){if(peer&&!peer.closed)peer.postMessage(message,destination);}
 function stop(){enabledUntil=0;$('connect').disabled=!signedIn||!peer||peer.closed;$('stop').disabled=true;status('Sharing stopped. Existing reservations remain protected.');}
 $('stop').onclick=stop;
 $('connect').onclick=()=>{if(!signedIn||!peer||peer.closed)return;enabledUntil=Date.now()+600000;$('connect').disabled=true;$('stop').disabled=false;status('Connected for 10 minutes. ApplyPilot 2 can check protected jobs and reserve preparation.');send({type:'applypilot.handoff.ready',schema_version:2,source_project:sourceProject});};
 setInterval(()=>{if(enabledUntil&&(Date.now()>=enabledUntil||!peer||peer.closed))stop();},1000);
 $('preview').onclick=async()=>{try{summarize(await api('/api/preparation-handoff/ledger'));status('Protected history checked. No preparation or submission was started.');}catch(error){status(error.message);}};
 $('download').onclick=()=>{if(!snapshot)return;const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='applypilot-protected-history.json';a.click();URL.revokeObjectURL(url);};
 window.addEventListener('message',async event=>{
  if(!peer||event.source!==peer||event.origin!==destination||!enabledUntil||Date.now()>=enabledUntil)return;
  const m=event.data;
  if(!m||typeof m!=='object'||m.type!=='applypilot.handoff.request'||m.schema_version!==2||typeof m.request_id!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(m.request_id)||!['ledger','reserve'].includes(m.action))return;
  const envelope={type:'applypilot.handoff.response',schema_version:2,source_project:sourceProject,request_id:m.request_id,action:m.action};
  if(busy){send({...envelope,ok:false,error:'busy'});return;}busy=true;const grant=enabledUntil;
  try{
   const result=m.action==='ledger'?await api('/api/preparation-handoff/ledger'):await api('/api/preparation-handoff/reserve',{schema_version:2,request_id:m.request_id,expected_revision:m.expected_revision,identity:m.identity});
   // A Stop click during a request suppresses its response. An already committed
   // reservation stays protected; AP2 can reconcile it using the same request ID.
   if(enabledUntil!==grant||Date.now()>=enabledUntil)return;
   if(m.action==='ledger')summarize(result);status(m.action==='ledger'?'Protected history shared with ApplyPilot 2.':result.decision==='blocked'?'Preparation blocked by protected history.':'Preparation reservation checked. Submit remains yours.');
   send({...envelope,ok:true,result});
  }catch(error){if(enabledUntil===grant&&Date.now()<enabledUntil)send({...envelope,ok:false,error:error.code||'request_failed'});status('Preparation remains blocked until a successful fresh check.');}finally{busy=false;}
 });
 api('/api/me').then(()=>{signedIn=true;$('connect').disabled=!peer||peer.closed;status(peer&&!peer.closed?'Open the connection when you are ready to share with ApplyPilot 2.':'Open this page from ApplyPilot 2 to connect, or preview protected history here.');}).catch(()=>{status('Sign in through ApplyPilot, then reopen this page.');$('preview').disabled=true;});
})();
