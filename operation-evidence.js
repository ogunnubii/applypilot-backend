import {receipt} from './local-policy.js';
export function applicationEvidence(job){
 const text=String(job.confirmation||'');
 const placeholder=/placeholder|example\.com|github\.com|not (?:yet )?(?:submitted|confirmed)|unconfirmed|simulat|test receipt/i.test(text);
 const confirmed=!!job.receipt_event&&!placeholder&&!!receipt(text);
 const attempted=!!job.local_attempt_at||!!job.attempt_event;
 const filled=!!job.captured_fields||!!job.filled_event;
 return {confirmed,attempted,filled,worked:filled||attempted||confirmed,
  awaiting:attempted&&!confirmed,
  active:!attempted&&(['queued','running'].includes(job.status)||job.status==='local_browser'&&job.local_phase==='ready'),
  blocked:!attempted&&(['paused','needs_review'].includes(job.status)||job.status==='local_browser'&&job.local_phase==='blocked'),
  unverifiedOutcome:!confirmed&&['submitted','interview','rejected','offer'].includes(job.status)};
}
export function operationSnapshot(db,userId){
 const jobs=db.prepare(`SELECT j.id,j.company,j.title,j.url,j.status,j.confirmation,j.local_phase,j.local_attempt_at,j.updated_at,
 EXISTS(SELECT 1 FROM answer_history h WHERE h.job_id=j.id) AS captured_fields,
 EXISTS(SELECT 1 FROM events e WHERE e.job_id=j.id AND e.type IN ('submitted','manual_confirmation')) AS receipt_event,
 EXISTS(SELECT 1 FROM events e WHERE e.job_id=j.id AND e.type='submission_started') AS attempt_event,
 EXISTS(SELECT 1 FROM events e WHERE e.job_id=j.id AND e.type='filled' AND CAST(substr(e.message,8) AS INTEGER)>0) AS filled_event
 FROM jobs j WHERE j.user_id=? AND j.status NOT IN ('archived','duplicate')`).all(userId);
 const totals={confirmed:0,worked:0,awaiting:0,active:0,blocked:0,unverifiedOutcome:0};
 for(const job of jobs){const evidence=applicationEvidence(job);for(const key of Object.keys(totals))if(evidence[key])totals[key]++;}
 return {totals,applications:jobs.map(job=>({id:job.id,...applicationEvidence(job)})),checkedAt:new Date().toISOString()};
}
