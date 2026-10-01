window.addEventListener('message',async event=>{
 if(event.source!==window||event.origin!==location.origin||!['applypilot-focus-application','applypilot-browser-status'].includes(event.data?.type))return;
 const {requestId,jobId,type}=event.data;if(typeof requestId!=='string'||requestId.length>100)return;
 if(type==='applypilot-focus-application'&&(typeof jobId!=='string'||jobId.length>200))return;
 let error,data;try{const result=await chrome.runtime.sendMessage({action:type==='applypilot-browser-status'?'dashboard-status':'focus-existing',id:jobId});if(!result?.ok)error=result?.error||'Unable to reach the browser helper.';else data=result.data;}catch{error='Reload this dashboard after updating ApplyPilot Local.';}
 window.postMessage({type:type==='applypilot-browser-status'?'applypilot-browser-status-result':'applypilot-focus-result',requestId,error,data},location.origin);
});
