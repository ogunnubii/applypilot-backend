// A filled percentage, captured answers, or an old prepared event is not a
// usable form. The background must also verify the retained browser/tab.
(()=>{
 function source(job,record){
  if(!job||job.employer_hold||job.metadata?.available===false||job.local_attempt_at||job.confirmation||job.manual_submit_clicks||job.evidence?.attempted||job.evidence?.awaiting||job.evidence?.completed||job.evidence?.confirmed||record?.attempted||Object.keys(record?.pendingClicks||{}).length)return null;
  if(job.editing_questions?.length)return null;
  let missing;try{missing=JSON.parse(job.required_fields_json||'[]');}catch{return null;}
  if(!Array.isArray(missing)||missing.length)return null;
  if(job.status==='needs_review'&&job.challenge==='Ready to submit'&&job.handoff_available)return 'hosted';
  if(job.status==='local_browser'&&job.local_phase==='blocked'&&record?.phase==='prepared'&&Number.isInteger(record.tabId)&&!['Unconfirmed submission','Submission in progress','Sensitive action'].includes(job.challenge))return 'local';
  return null;
 }
 function listed(job){return !!job&&['hosted','local'].includes(job.ready_form?.source)&&Number.isFinite(job.ready_form.checked_at)&&Date.now()-job.ready_form.checked_at<30000&&job.ready_form.checked_at<=Date.now()&&job.ready_form.expires_at>Date.now();}
 globalThis.ApplyPilotReadyForms=Object.freeze({source,listed});
})();
