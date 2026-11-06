// Read-only listing check for LinkedIn/Indeed jobs added from a results page.
// The saved-search queue only selects jobs whose posting was verified against
// the current scope, but those boards are never crawled and the full posting
// check used to run only after a claim, so a fresh card could never qualify.
// Here the applicant's browser reads the exact saved job page (no claim,
// resume, fill or click) and the server assesses it with the same eligibility,
// history, hold and duplicate rules. Only an eligible posting is stamped
// fresh for the current scope; anything else is held with its reason.
import './local-policy.js';
import {assessNativePosting} from './native-posting.js';
import {currentSearchScope,searchScopeSignature} from './search-scope.js';
import {metadataFor} from './job-intelligence.js';
import {priorApplication} from './application-dedup.js';
import {employerHold} from './employer-limits.js';
import {hasSubmissionEvidence} from './single-application.js';

const P=globalThis.ApplyPilotPolicy;
export const LISTING_CHECK_MAX_AGE=24*60*60*1000;
export const LISTING_RECHECK_AFTER_HOLD=6*60*60*1000;
const untouched=job=>['saved','queued'].includes(job.status)&&!job.local_attempt_at&&!Number(job.attempts)&&!job.local_owner&&!job.handoff_available;

// Due when the job is an untouched native-board job whose saved check is
// missing, stale, or made for a different scope. A held result is not
// re-checked for LISTING_RECHECK_AFTER_HOLD (no loops on the board).
export function listingCheckDue(db,job,now=Date.now()){
 if(!P.nativeBoard(job?.url||'')||!untouched(job)||job.challenge)return false;
 const scope=currentSearchScope(db,job);if(!scope)return false;
 const m=metadataFor(job),checked=Date.parse(m.listingCheck?.at||'');
 if(Number.isFinite(checked)&&now-checked<(m.listingCheck.eligible?LISTING_CHECK_MAX_AGE:LISTING_RECHECK_AFTER_HOLD)&&m.listingCheck.signature===searchScopeSignature(scope))return false;
 return true;
}

export function recordListingCheck(db,userId,jobId,snapshot,{now=new Date()}={}){
 const job=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(jobId,userId);
 if(!job)return {status:404,error:'Job not found'};
 if(!P.nativeBoard(job.url))return {status:400,error:'Listing checks apply to LinkedIn and Indeed jobs.'};
 if(!untouched(job)||hasSubmissionEvidence(db,job))return {status:409,error:'Only untouched saved jobs are checked. A previous attempt or submission may exist.'};
 if(!P.sameApplication(String(snapshot?.url||''),job.url))return {status:409,error:'The open page is not this saved job.'};
 const scope=currentSearchScope(db,job);
 if(!scope)return {status:409,error:'Save and enable a structured search first.'};
 const meta=metadataFor(job),signature=searchScopeSignature(scope),at=now.toISOString();
 const last=Date.parse(meta.listingCheck?.at||'');
 if(Number.isFinite(last)&&now.getTime()-last<10*60*1000)return {status:429,error:'This listing was checked moments ago.'};
 let result=assessNativePosting(job,snapshot,scope,{date:now.getTime()});
 if(snapshot?.alreadyApplied===true)result={...result,eligible:false,blocker:'The board shows an existing application for this job. It will not be applied to again.'};
 // Fill identity from the page only where the saved card had none, then run the
 // history, duplicate and employer-hold checks against the completed identity.
 if(result.title&&!job.title)db.prepare('UPDATE jobs SET title=? WHERE id=?').run(String(result.title).slice(0,200),job.id);
 if(result.company&&!job.company)db.prepare('UPDATE jobs SET company=? WHERE id=?').run(String(result.company).slice(0,200),job.id);
 const fresh=db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
 if(result.eligible){
  const hold=employerHold(db,fresh);
  if(hold)result={...result,eligible:false,blocker:hold.message||'This employer is held.'};
  else if(priorApplication(db,userId,fresh))result={...result,eligible:false,blocker:'Already applied or in progress for this employer role through another source. Repeat application blocked.'};
 }
 const listingCheck={at,signature,eligible:result.eligible===true,blocker:result.blocker||null,reasons:result.reasons||[]};
 const merged={...meta,native:result,listingCheck,foundVia:meta.foundVia||P.nativeBoard(job.url),
  ...(result.eligible?{description:String(snapshot.description||'').slice(0,24000),location:result.location,remote:result.workplace==='remote',pay:result.pay,eligibility:result.eligibility,available:true,checkedAt:at,searchScopeSignature:signature}
   :{eligibility:{eligible:false,reason:result.blocker},searchScopeSignature:undefined})};
 db.prepare('UPDATE jobs SET job_metadata_json=?,updated_at=? WHERE id=?').run(JSON.stringify(merged),at,job.id);
 db.prepare('INSERT INTO events(job_id,at,type,message) VALUES(?,?,?,?)').run(job.id,at,'listing_checked',result.eligible?'Listing checked (read-only): '+(result.reasons||[]).join('; '):'Listing held (read-only check): '+result.blocker);
 return {status:200,eligible:listingCheck.eligible,blocker:listingCheck.blocker,reasons:listingCheck.reasons};
}
