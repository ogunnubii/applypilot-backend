import {sameApplication,receipt,submissionDeclaration} from './local-policy.js';
import {applicationLimit} from './employer-limits.js';
import {watchSubmission} from './submission-diagnostics.js';

// Reservation is durable before the only possible click. Errors after reservation
// must remain uncertain; neither timeouts nor an unrelated receipt allow a replay.
export async function submitHostedApplication({page,job,submit,review,reserve,wait,recordLimit,recordDiagnostic=()=>{}}){
 const blocked=(message,challenge)=>({status:'needs_review',message,challenge});
 if(!sameApplication(page.url(),job.url))return blocked('The final form no longer matches this application.','Application identity changed');
 const before=await page.locator('body').innerText();
 if(submissionDeclaration(before))return blocked('The final Submit action includes an employer declaration. Review and submit this form yourself.','Employer declaration');
 if(receipt(before))return blocked('An existing employer receipt is visible. Verify it before any new attempt.','Existing receipt');
 // A rendered value/file is not proof that the employer's asynchronous upload
 // and validation have settled. Require two seconds of consecutive readiness
 // before reserving the one permitted click; never repair or retry a submission.
 let stable=0;
 for(let i=0;i<=16;i++){
  if(!sameApplication(page.url(),job.url))return blocked('The final form no longer matches this application.','Application identity changed');
  const check=await review(page);
  if(check.captcha||check.signIn||check.missing.length)return blocked('The final form needs review before submission.','Final form review');
  stable=!check.pending&&await submit.isEnabled()?stable+1:0;
  if(stable>=5)break;
  if(i<16)await wait(500);
 }
 if(stable<5)return blocked('The employer form did not finish validating or enable Submit. No submission was attempted.','Final form review');
 // Trial checks visibility, overlays and a stable click target without sending
 // a click. Scrolling the button into view can itself trigger lazy validation.
 try{await submit.click({trial:true,timeout:5000});}catch{return blocked('The employer Submit button is not currently actionable. No submission was attempted.','Final form review');}
 const final=await review(page),finalText=await page.locator('body').innerText();
 if(final.captcha||final.signIn||final.pending||final.missing.length||!await submit.isEnabled())return blocked('The final form changed during readiness checks. No submission was attempted.','Final form review');
 if(submissionDeclaration(finalText))return blocked('The final Submit action includes an employer declaration. Review and submit this form yourself.','Employer declaration');
 if(receipt(finalText))return blocked('An existing employer receipt is visible. Verify it before any new attempt.','Existing receipt');
 // The final review is asynchronous. Recheck the destination immediately before
 // reservation; reserve rechecks current authorization and applicant consent.
 if(!sameApplication(page.url(),job.url))return blocked('The final form no longer matches this application.','Application identity changed');
 reserve();
 const diagnostic=watchSubmission(page);diagnostic.start();
 try{
  await submit.click({timeout:10000});
  diagnostic.clicked();
  for(let i=0;i<90;i++){
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
 }finally{
  try{recordDiagnostic(await diagnostic.describe());}catch{}finally{diagnostic.stop();}
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
