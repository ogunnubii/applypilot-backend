window.addEventListener('message',async event=>{
 if(event.source!==window||event.origin!==location.origin||!['applypilot-focus-application','applypilot-browser-status','applypilot-resume-application','applypilot-open-application'].includes(event.data?.type))return;
 const {requestId,jobId,type}=event.data;if(typeof requestId!=='string'||requestId.length>100)return;
 if(type!=='applypilot-browser-status'&&(typeof jobId!=='string'||jobId.length>200))return;
 let error,data;try{const result=await chrome.runtime.sendMessage({action:type==='applypilot-open-application'?'open-from-dashboard':type==='applypilot-browser-status'?'dashboard-status':type==='applypilot-resume-application'?'resume-existing':'focus-existing',id:jobId});if(!result?.ok)error=result?.error||'Unable to reach the browser helper.';else data=result.data;}catch{error='Reload this dashboard after updating ApplyPilot Local.';}
 window.postMessage({type:type==='applypilot-open-application'?'applypilot-open-result':type==='applypilot-browser-status'?'applypilot-browser-status-result':type==='applypilot-resume-application'?'applypilot-resume-result':'applypilot-focus-result',requestId,error,data},location.origin);
});
