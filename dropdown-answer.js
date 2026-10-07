import {canDraftProfessional,draftForJob} from './answer-drafts.js';
import {hostedOptionChoice,protectedHostedQuestion} from './hosted-form.js';
import {researchConsentWithdrawn} from './research-consent.js';

// Reads current records before and after inference. Choosing a menu item is
// preparation only; this module cannot click controls or submit applications.
export async function prepareHostedDropdown(db,job,profile,descriptor,options,answers,{draft=draftForJob}={}){
 const question=descriptor.label||descriptor.ariaLabel||descriptor.name||descriptor.id;
 if(!question||protectedHostedQuestion(question+' '+(descriptor.description||'')))return null;
 const exact=hostedOptionChoice(descriptor,options,profile,answers);if(exact)return exact;
 const choices=options.filter(o=>!o.disabled&&o.value!==''&&!/^(?:select|choose)\b/i.test(o.label||'')).map(o=>String(o.label||'').trim());
 if(!canDraftProfessional(question)||!choices.length||choices.length>80||choices.some(c=>!c||c.length>200)||new Set(choices.map(c=>c.toLowerCase())).size!==choices.length)return null;
 const read=()=>({job:db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(job.id,job.user_id),profile:db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(profile.id,job.user_id)});
 const allowed=s=>s.job?.status==='running'&&!s.job.local_attempt_at&&!s.job.handoff_available&&s.job.applicant_id===profile.id&&s.job.url===job.url&&s.profile?.consent&&(s.profile.gemini_facts_consent||s.profile.ai_consent)&&!researchConsentWithdrawn(db,job.id,profile.id)&&!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submission_started','manual_submission','submitted')").get(job.id);
 const before=read();if(!allowed(before))return null;
 let result;try{result=await draft(db,job.user_id,job.id,question,{choices,fieldHelp:descriptor.description||'',maxLength:200});}catch{return null;}
 const after=read();if(!allowed(after)||after.job.answers_json!==before.job.answers_json||(result.provider==='gemini'?!after.profile.gemini_facts_consent:!after.profile.ai_consent))return null;
 const matches=options.filter(o=>!o.disabled&&o.label?.trim()===result.answer?.trim());
 return choices.includes(result.answer?.trim())&&matches.length===1?{...matches[0],aiPrepared:true}:null;
}
