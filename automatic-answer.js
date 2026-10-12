import {factDraftProvider} from './draft-provenance.js';
import {canDraft,draftForJob,answerLimit} from './answer-drafts.js';
import {protectedHostedQuestion} from './hosted-form.js';
import {canResearchQuestion,hasResearchDraftForQuestion,researchDraftProvenance,researchForJob} from './google-research.js';
import {normalize,savedAnswer} from './local-policy.js';

export async function automaticTextAnswer({db,profile,job,question,answers,applicationAnswers={},fieldHelp='',maxLength=4000,answerFormat='text',research=researchForJob,draft=draftForJob}){
 if(/\bcover[\s_-]*letter\b/i.test(String(question)))return {answer:null,source:'unresolved',reason:'Cover letters are prepared only for an active required field.'};
 let reason='';
 // A generic label is not a durable identity for a question whose meaning
 // lives in help text; do not borrow its old answer from another context.
 if(fieldHelp.trim()&&/^(?:(?:please )?(?:explain|describe|specify|elaborate)(?: (?:below|here|your answer))?|(?:additional|more|further) (?:details|information|comments?)|details|comments?|answer|response|other(?: \(please specify\))?)$/i.test(normalize(question).replace(/[:.]+$/,'')))return {answer:null,source:'unresolved',reason:'This short label needs the complete employer question before a saved answer can be reused.'};
 if(protectedHostedQuestion(question+' '+fieldHelp)||fieldHelp&&!canDraft(fieldHelp))return {answer:null,source:'unresolved',reason:'This question needs your own answer or employer verification.'};
 const limits=answerLimit(question,maxLength,fieldHelp);
 const validAnswer=value=>typeof value==='string'&&!!value.trim()&&value.length<=limits.characters&&value.trim().split(/\s+/).length<=limits.words&&(answerFormat!=='number'||/^-?\d+(?:\.\d+)?$/.test(value.trim()));
 const invalidAnswer=()=>({answer:null,source:'unresolved',reason:'The answer needs the format or length required by this employer.'});
 const applicationAnswer=savedAnswer(question,applicationAnswers);
 if(applicationAnswer!==null&&applicationAnswer!==undefined&&applicationAnswer!==''){
  const keys=Object.keys(applicationAnswers).filter(key=>normalize(key)===normalize(question)),storedQuestion=keys.length===1?keys[0]:question,value=String(applicationAnswer);
  if(!validAnswer(value))return invalidAnswer();
  const provider=factDraftProvider(db,job.id,storedQuestion,value);if(provider){if(provider==='gemini'?!profile.gemini_facts_consent:!profile.ai_consent)return {answer:null,source:'unresolved'};return {answer:value,source:'approved_facts'};}
  const provenance=researchDraftProvenance(db,job.id,storedQuestion,value);
  if(provenance){if(!profile.google_research_consent)return {answer:null,source:'unresolved'};return {answer:value,source:'public_page',citations:provenance.citations};}
  if(hasResearchDraftForQuestion(db,job.id,storedQuestion)){if(!profile.google_research_consent)return {answer:null,source:'unresolved'};return {answer:value,source:'application_only'};}
  return {answer:value,source:'saved'};
 }
 const publicQuestion=canResearchQuestion(question)&&(!fieldHelp||canResearchQuestion(question+' '+fieldHelp));
 if(!publicQuestion){
  const answer=savedAnswer(question,answers||{});
  if(answer!==null&&answer!==undefined&&answer!=='')return validAnswer(String(answer))?{answer:String(answer),source:'saved'}:invalidAnswer();
 }
 if(profile.google_research_consent&&publicQuestion){
  try{const result=await research(db,job.user_id,job.id,question);if(result.answer?.trim()){const answer=result.answer.trim();if(!validAnswer(answer))return invalidAnswer();if(typeof db?.prepare==='function'){const row=db.prepare('SELECT answers_json FROM jobs WHERE id=?').get(job.id);if(row){let saved;try{saved=JSON.parse(row.answers_json||'{}')}catch{saved={}}Object.defineProperty(saved,question,{value:answer,enumerable:true,configurable:true,writable:true});const encoded=JSON.stringify(saved);db.prepare('UPDATE jobs SET answers_json=? WHERE id=?').run(encoded,job.id);job.answers_json=encoded;applicationAnswers[question]=answer;}}return {answer,source:'public_page',citations:result.citations||[]};}}catch{}
 }
 if(publicQuestion)return {answer:null,source:'unresolved'};
 if(profile.ai_consent||profile.gemini_facts_consent){
  try{const result=await draft(db,job.user_id,job.id,question,{fieldHelp,maxLength,answerFormat});if(result.answer?.trim())return validAnswer(result.answer.trim())?{answer:result.answer.trim(),source:'approved_facts',sources:result.sources||[]}:invalidAnswer();reason=String(result.reason||'Your saved professional facts do not support a complete answer.').slice(0,500);}catch(error){reason=String(error.message||'Professional answer drafting is unavailable.').slice(0,500);}
 }
 return {answer:null,source:'unresolved',...(reason?{reason}:{})};
}
