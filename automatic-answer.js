import {factDraftProvider} from './draft-provenance.js';
import {draftForJob} from './answer-drafts.js';
import {canResearchQuestion,hasResearchDraftForQuestion,researchDraftProvenance,researchForJob} from './google-research.js';
import {normalize,savedAnswer} from './local-policy.js';

export async function automaticTextAnswer({db,profile,job,question,answers,applicationAnswers={},research=researchForJob,draft=draftForJob}){
 const applicationAnswer=savedAnswer(question,applicationAnswers);
 if(applicationAnswer!==null&&applicationAnswer!==undefined&&applicationAnswer!==''){
  const keys=Object.keys(applicationAnswers).filter(key=>normalize(key)===normalize(question)),storedQuestion=keys.length===1?keys[0]:question,value=String(applicationAnswer);
  const provider=factDraftProvider(db,job.id,storedQuestion,value);if(provider){if(provider==='gemini'?!profile.gemini_facts_consent:!profile.ai_consent)return {answer:null,source:'unresolved'};return {answer:value,source:'approved_facts'};}
  const provenance=researchDraftProvenance(db,job.id,storedQuestion,value);
  if(provenance){if(!profile.google_research_consent)return {answer:null,source:'unresolved'};return {answer:value,source:'public_page',citations:provenance.citations};}
  if(hasResearchDraftForQuestion(db,job.id,storedQuestion)){if(!profile.google_research_consent)return {answer:null,source:'unresolved'};return {answer:value,source:'application_only'};}
  return {answer:value,source:'saved'};
 }
 const publicQuestion=canResearchQuestion(question);
 if(!publicQuestion){
  const answer=savedAnswer(question,answers||{});
  if(answer!==null&&answer!==undefined&&answer!=='')return {answer:String(answer),source:'saved'};
 }
 if(profile.google_research_consent&&publicQuestion){
  try{const result=await research(db,job.user_id,job.id,question);if(result.answer?.trim()){const answer=result.answer.trim();if(typeof db?.prepare==='function'){const row=db.prepare('SELECT answers_json FROM jobs WHERE id=?').get(job.id);if(row){let saved;try{saved=JSON.parse(row.answers_json||'{}')}catch{saved={}}Object.defineProperty(saved,question,{value:answer,enumerable:true,configurable:true,writable:true});const encoded=JSON.stringify(saved);db.prepare('UPDATE jobs SET answers_json=? WHERE id=?').run(encoded,job.id);job.answers_json=encoded;applicationAnswers[question]=answer;}}return {answer,source:'public_page',citations:result.citations||[]};}}catch{}
 }
 if(publicQuestion)return {answer:null,source:'unresolved'};
 if(profile.ai_consent||profile.gemini_facts_consent){
  try{const result=await draft(db,job.user_id,job.id,question);if(result.answer?.trim())return {answer:result.answer.trim(),source:'approved_facts',sources:result.sources||[]};}catch{}
 }
 return {answer:null,source:'unresolved'};
}
