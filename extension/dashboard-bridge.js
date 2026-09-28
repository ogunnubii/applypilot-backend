window.addEventListener('message',async event=>{
 if(event.source!==window||event.origin!==location.origin||event.data?.type!=='applypilot-focus-application')return;
 const {requestId,jobId}=event.data;if(typeof requestId!=='string'||typeof jobId!=='string'||jobId.length>200)return;
 let error;try{const result=await chrome.runtime.sendMessage({action:'focus-existing',id:jobId});if(!result?.ok)error=result?.error||'Unable to open employer tab.';}catch{error='Reload this dashboard after updating ApplyPilot Local.';}
 window.postMessage({type:'applypilot-focus-result',requestId,error},location.origin);
});
