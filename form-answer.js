import {canResearchQuestion,researchForJob,markResearchDraftUsed,researchDraftProvenance,hasResearchDraftForQuestion} from './google-research.js';
import {canDraft,canDraftProfessional,draftForJob,answerLimit} from './answer-drafts.js';
import {researchConsentWithdrawn} from './research-consent.js';
import {reusableAnswers} from './answer-library.js';
import {hostedFieldAnswer,hostedFieldKind,hostedOptionChoice,protectedHostedQuestion} from './hosted-form.js';
import {normalize,savedAnswer} from './local-policy.js';
import {factDraftProvider} from './draft-provenance.js';
import {employmentContext} from './employment-answers.js';
import {currentSearchScope} from './search-scope.js';
const parse=s=>{try{return JSON.parse(s||'{}')}catch{return {}}};
export async function prepareFormAnswer(db,uid,id,question,{research=researchForJob,draft=draftForJob,check=()=>'',expectedOwner=null,choices=[],answerFormat='text',maxLength=4000,fieldHelp=''}={}){
 if(/\bcover[\s_-]*letter\b/i.test(String(question)))return {answer:'',reason:'Cover letters use the dedicated required-field preparation path.'};
 if(typeof question!=='string'||question.length<3||question.length>4000)throw Error('A complete employer question is required.');
 if(!Array.isArray(choices)||choices.length>80||choices.some(v=>typeof v!=='string'||!v.trim()||v.length>200)||new Set(choices.map(v=>v.trim().toLowerCase())).size!==choices.length)throw Error('This dropdown needs review because its options are ambiguous or unsupported.');
 const choiceAnswer=value=>{if(typeof value!=='string'||!value.trim())return '';if(!choices.length)return value;const found=choices.filter(c=>c.trim().toLowerCase()===value.trim().toLowerCase());return found.length===1?found[0]:'';};
 const limits=answerLimit(question,maxLength,fieldHelp);
 const validAnswer=value=>typeof value==='string'&&!!value.trim()&&value.length<=limits.characters&&value.trim().split(/\s+/).length<=limits.words&&(answerFormat!=='number'||/^-?\d+(?:\.\d+)?$/.test(value.trim()));
 const invalidSaved=()=>({answer:'',reason:'Your saved answer needs the format or length required by this employer.'});
 const read=()=>db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(id,uid);
 const profile=j=>j&&db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,uid);
 const eligible=(j,p)=>j&&p?.consent&&j.status==='local_browser'&&!j.local_attempt_at&&!j.handoff_available&&(!expectedOwner||j.local_owner===expectedOwner)&&!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submission_started','manual_submission','submitted')").get(id);
 let job=read(),p=profile(job);
 if(!eligible(job,p))throw Error('This form cannot be prepared now. Check its current application status.');
 const problem=check(job);if(problem)throw Error(problem);
 if(researchConsentWithdrawn(db,id,p.id))throw Error('AI answer consent changed. Review this application.');
 // Chrome uses the same approved facts as the hosted worker before asking AI.
 // Eligibility remains scoped to this posting and explicit applicant answers.
 const field={label:question,description:fieldHelp},trustedProfile={...p,employment_context:employmentContext(p,job,currentSearchScope(db,job))},savedFacts={...reusableAnswers(db,p),...parse(job.answers_json)};
 const approved=hostedFieldAnswer(field,trustedProfile,savedFacts);
 if(approved){
  // Reuse the same deterministic display-label mapping as hosted and Chrome
  // dropdowns (for example America/Toronto -> Eastern Time (ET)).
  const answer=choices.length?hostedOptionChoice(field,choices.map(label=>({label})),trustedProfile,savedFacts)?.label||'':choiceAnswer(approved.answer);
  if(!answer)return {answer:'',reason:'Your saved answer does not match one of the current choices.'};
  if(!validAnswer(answer))return invalidSaved();
  const answers=parse(job.answers_json);Object.defineProperty(answers,question,{value:answer,enumerable:true,configurable:true,writable:true});
  db.prepare('UPDATE jobs SET answers_json=?,updated_at=? WHERE id=?').run(JSON.stringify(answers),new Date().toISOString(),id);
  return {answer,source:'saved_profile',requiresReview:false};
 }
 // A saved routine answer does not require AI consent. Keep the same exact
 // question matching as browser/hosted filling, and retain generated provenance.
 // Failed profile mapping (including conflicts) must never fall through here.
 // A generic label is not a durable identity for a question whose meaning
 // lives in help text; do not borrow its old answer from another context.
 if(fieldHelp.trim()&&/^(?:(?:please )?(?:explain|describe|specify|elaborate)(?: (?:below|here|your answer))?|(?:additional|more|further) (?:details|information|comments?)|details|comments?|answer|response|other(?: \(please specify\))?)$/i.test(normalize(question).replace(/[:.]+$/,'')))return {answer:'',reason:'This short label needs the complete employer question before a saved answer can be reused.'};
 if(protectedHostedQuestion(question+' '+fieldHelp)||fieldHelp&&!canDraft(fieldHelp))return {answer:'',reason:'This question needs your own answer or employer verification.'};
 if(hostedFieldKind(field)||hostedFieldKind({label:question}))return {answer:'',reason:'Your saved profile facts need review before this field can be filled.'};
 const applicationAnswers=parse(job.answers_json),existing=savedAnswer(question,applicationAnswers);
 const saved=existing??savedAnswer(question,savedFacts),chosen=choiceAnswer(saved);
 if(chosen){
  if(!validAnswer(chosen))return invalidSaved();
  let source='saved',citations;
  if(existing!==null){
   const storedQuestion=Object.keys(applicationAnswers).find(key=>normalize(key)===normalize(question))||question;
   const provider=factDraftProvider(db,id,storedQuestion,String(existing));
   const researchProvenance=researchDraftProvenance(db,id,storedQuestion,String(existing));
   if(provider){if(provider==='gemini'?!p.gemini_facts_consent:!p.ai_consent)return {answer:'',reason:'AI answer consent changed. Review this application.'};source='approved_facts';}
   else if(researchProvenance||hasResearchDraftForQuestion(db,id,storedQuestion)){
    if(!p.google_research_consent)return {answer:'',reason:'Google public-page drafting consent changed. Review this application.'};
    source=researchProvenance?'public_page':'application_only';citations=researchProvenance?.citations;
    markResearchDraftUsed(db,id,storedQuestion);
   }
  }
  return {answer:chosen,source,requiresReview:true,...(citations?{citations}:{})};
 }
 const publicQuestion=canResearchQuestion(question)&&(!fieldHelp||canResearchQuestion(question+' '+fieldHelp)),personal=!publicQuestion&&canDraftProfessional(question,fieldHelp);
 if(choices.length&&(publicQuestion||!canDraftProfessional(question,fieldHelp)))return {answer:'',reason:'This dropdown needs your saved answer or review.'};
 if(publicQuestion?!p.google_research_consent:!personal||!p.gemini_facts_consent&&!p.ai_consent)return {answer:'',reason:'This question needs your saved answer or review.'};
 const owner=job.local_owner,applicant=job.applicant_id,url=job.url;
 const result=publicQuestion?await research(db,uid,id,question):await draft(db,uid,id,question,{choices,answerFormat,maxLength,fieldHelp});
 job=read();p=profile(job);
 if(!eligible(job,p)||job.local_owner!==owner||job.applicant_id!==applicant||job.url!==url||check(job)||researchConsentWithdrawn(db,id,p.id)||(publicQuestion?!p.google_research_consent:result.provider==='gemini'?!p.gemini_facts_consent:!p.ai_consent))throw Error('The form or your consent changed while drafting. Your answers were preserved.');
 const answers=parse(job.answers_json);
 const current=savedAnswer(question,answers);
 if(current!==null&&current.trim()&&(!choices.length||current!==existing)){const answer=choiceAnswer(current);return answer&&!validAnswer(answer)?invalidSaved():{answer,source:'saved',requiresReview:true,reason:'Your saved answer was preserved. Review it if it does not match these options.'};}
 if(!result.answer?.trim())return result;
 if(choices.length&&!choiceAnswer(result.answer))return {answer:'',reason:'Gemini did not return one of the current dropdown options.'};
 if(!validAnswer(result.answer.trim()))return {answer:'',reason:'The prepared answer does not match this employer’s required format or length.'};
 if(choices.length&&existing?.trim())return {...result,answer:choiceAnswer(result.answer),source:'approved_facts',requiresReview:true};
 Object.defineProperty(answers,question,{value:result.answer.trim(),enumerable:true,configurable:true,writable:true});
 db.prepare('UPDATE jobs SET answers_json=?,updated_at=? WHERE id=?').run(JSON.stringify(answers),new Date().toISOString(),id);
 if(publicQuestion)markResearchDraftUsed(db,id,question);
 return {...result,source:publicQuestion?'public_page':'approved_facts',requiresReview:true};
}
