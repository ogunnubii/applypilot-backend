import {receipt} from './local-policy.js';
export function applicationEvidence(job,now=Date.now()){
 const text=String(job.confirmation||'');
 const placeholder=/reached your application limit|application limit (?:has been )?reached|could(?:n['’]t| not) submit your application|placeholder|example\.com|github\.com|not (?:yet )?(?:submitted|confirmed)|unconfirmed|simulat|test receipt/i.test(text);
 const confirmed=!!job.receipt_event&&!placeholder&&!!receipt(text);
 const completed=confirmed||!!job.reported_event;
 const completion=confirmed?(job.help_event?'assisted':job.tracking_event&&job.automatic_event&&!job.review_event?'automatic':'unknown'):null;
 const attempted=!!job.local_attempt_at||!!job.attempt_event;
 const filled=!!job.captured_fields||!!job.filled_event;
 const fresh=Number.isFinite(Date.parse(job.updated_at))&&now-Date.parse(job.updated_at)<120000;
 const stalled=!attempted&&job.status==='local_browser'&&job.local_phase==='ready'&&!fresh;
 return {completed,confirmed,completion,automatic:completion==='automatic',assisted:completion==='assisted',unknown:completion==='unknown',attempted,filled,worked:filled||attempted||confirmed,
  awaiting:attempted&&!confirmed,
  active:!attempted&&(['queued','running'].includes(job.status)||job.status==='local_browser'&&job.local_phase==='ready'&&!stalled),
  stalled,
  blocked:!attempted&&(['paused','needs_review'].includes(job.status)||job.status==='local_browser'&&job.local_phase==='blocked'),
  unverifiedOutcome:!confirmed&&['submitted','interview','rejected','offer'].includes(job.status)};
}
export function operationSnapshot(db,userId){
 const jobs=db.prepare(`SELECT j.id,j.company,j.title,j.url,j.status,j.confirmation,j.local_phase,j.local_attempt_at,j.updated_at,
 EXISTS(SELECT 1 FROM answer_history h WHERE h.job_id=j.id) AS captured_fields,
 EXISTS(SELECT 1 FROM events e WHERE e.job_id=j.id AND e.type IN ('submitted','manual_confirmation')) AS receipt_event,
 EXISTS(SELECT 1 FROM events e WHERE e.job_id=j.id AND e.type='applicant_reported_submission') AS reported_event,
 EXISTS(SELECT 1 FROM events e WHERE e.job_id=j.id AND e.type='submission_started') AS attempt_event,
 EXISTS(SELECT 1 FROM events e WHERE e.job_id=j.id AND e.type='filled' AND CAST(substr(e.message,8) AS INTEGER)>0) AS filled_event,
 EXISTS(SELECT 1 FROM events e WHERE e.job_id=j.id AND e.rowid<=(SELECT MIN(r.rowid) FROM events r WHERE r.job_id=j.id AND r.type IN ('submitted','manual_confirmation')) AND (e.type IN ('human_assistance','answer_saved','resumed','manual_submission','manual_confirmation') OR e.type='queued' AND e.message LIKE 'Missing answers saved%' OR e.type='submitted' AND e.message LIKE '%human handoff%')) AS help_event,
 EXISTS(SELECT 1 FROM events e WHERE e.job_id=j.id AND e.rowid<=(SELECT MIN(r.rowid) FROM events r WHERE r.job_id=j.id AND r.type IN ('submitted','manual_confirmation')) AND e.type='completion_tracking') AS tracking_event,
 EXISTS(SELECT 1 FROM events e WHERE e.job_id=j.id AND e.rowid<=(SELECT MIN(r.rowid) FROM events r WHERE r.job_id=j.id AND r.type IN ('submitted','manual_confirmation')) AND e.type='automatic_submission') AS automatic_event,
 EXISTS(SELECT 1 FROM events e WHERE e.job_id=j.id AND e.rowid<=(SELECT MIN(r.rowid) FROM events r WHERE r.job_id=j.id AND r.type IN ('submitted','manual_confirmation')) AND e.type IN ('assistance_boundary','paused','needs_review')) AS review_event
 FROM jobs j WHERE j.user_id=? AND j.status NOT IN ('archived','duplicate')`).all(userId);
 const totals={completed:0,confirmed:0,worked:0,awaiting:0,active:0,stalled:0,blocked:0,unverifiedOutcome:0,automatic:0,assisted:0,unknown:0};
 for(const job of jobs){const evidence=applicationEvidence(job);for(const key of Object.keys(totals))if(evidence[key])totals[key]++;}
 return {totals,applications:jobs.map(job=>({id:job.id,...applicationEvidence(job)})),checkedAt:new Date().toISOString()};
}
