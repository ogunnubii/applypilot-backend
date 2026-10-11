import {sameApplication,receipt,submissionDeclaration} from './local-policy.js';
import {applicationLimit} from './employer-limits.js';

// Reservation is durable before the only possible click. Errors after reservation
// must remain uncertain; neither timeouts nor an unrelated receipt allow a replay.
export async function submitHostedApplication({page,job,submit,review,reserve,wait,recordLimit}){
 const blocked=(message,challenge)=>({status:'needs_review',message,challenge});
 if(!sameApplication(page.url(),job.url))return blocked('The final form no longer matches this application.','Application identity changed');
 const before=await page.locator('body').innerText();
 if(submissionDeclaration(before))return blocked('The final Submit action includes an employer declaration. Review and submit this form yourself.','Employer declaration');
 if(receipt(before))return blocked('An existing employer receipt is visible. Verify it before any new attempt.','Existing receipt');
 const check=await review(page);
 if(check.captcha||check.signIn||check.missing.length)return blocked('The final form needs review before submission.','Final form review');
 // The final review is asynchronous. Recheck the destination immediately before
 // reservation; reserve rechecks current authorization and applicant consent.
 if(!sameApplication(page.url(),job.url))return blocked('The final form no longer matches this application.','Application identity changed');
 reserve();
 try{
  await submit.click();
  for(let i=0;i<30;i++){
   await wait(1000);
   if(!sameApplication(page.url(),job.url))return blocked('Submit was clicked once, but the resulting page cannot be matched to this job. Verify the employer receipt.','Unconfirmed submission');
   const after=await page.locator('body').innerText();
   if(applicationLimit(after)){
    recordLimit(after);
    return blocked('Employer application limit reached; no receipt recorded.','Employer application limit');
   }
   const confirmation=receipt(after);
   if(confirmation)return {status:'submitted',message:'Employer confirmed the autonomous application',confirmation};
  }
 }catch{
  return blocked('Submission was started, but its result could not be verified. Check the employer receipt before retrying.','Unconfirmed submission');
 }
 return blocked('Submit was clicked once. Waiting for a verifiable employer receipt; automatic retry is disabled.','Unconfirmed submission');
}

export function retainBlockedSession({status,challenge,attempted,skipBlocked}){
 if(!['paused','needs_review'].includes(status))return false;
 if(['Employer site unavailable','Employer application limit'].includes(challenge))return false;
 // Releasing an explicitly skipped pre-submit browser frees capacity for the
 // next job. An uncertain attempt stays available for receipt review.
 return !skipBlocked||attempted||['Submission in progress','Unconfirmed submission'].includes(challenge);
}

export async function releaseSkippedHandoffs(handoffs,shouldRelease){
 for(const [id,session] of handoffs.sessions){
  if(session.busy||session.attempted||!shouldRelease(session.job))continue;
  handoffs.sessions.delete(id);
  await session.context.close().catch(()=>{});
  handoffs.onClose(session.job,'Blocked before submission. Browser closed so other jobs can continue; resolve saved blockers before preparing again.');
 }
}
