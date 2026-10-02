import {canResearchQuestion,researchForJob,markResearchDraftUsed} from './google-research.js';
import {canDraftProfessional,draftForJob} from './answer-drafts.js';
import {researchConsentWithdrawn} from './research-consent.js';
const parse=s=>{try{return JSON.parse(s||'{}')}catch{return {}}};
export async function prepareFormAnswer(db,uid,id,question,{research=researchForJob,draft=draftForJob,check=()=>'',expectedOwner=null,choices=[],answerFormat='text'}={}){
 if(typeof question!=='string'||question.length<3||question.length>240)throw Error('A complete employer question is required.');
 const read=()=>db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(id,uid);
 const profile=j=>j&&db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,uid);
 const eligible=(j,p)=>j&&p?.consent&&j.status==='local_browser'&&!j.local_attempt_at&&!j.handoff_available&&(!expectedOwner||j.local_owner===expectedOwner)&&!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submission_started','manual_submission','submitted')").get(id);
 let job=read(),p=profile(job);
 if(!eligible(job,p))throw Error('This form cannot be prepared now. Check its current application status.');
 const problem=check(job);if(problem)throw Error(problem);
 if(researchConsentWithdrawn(db,id,p.id))throw Error('AI answer consent changed. Review this application.');
 const publicQuestion=canResearchQuestion(question),personal=!publicQuestion&&canDraftProfessional(question);
 if(publicQuestion?!p.google_research_consent:!personal||!p.gemini_facts_consent&&!p.ai_consent)return {answer:'',reason:'This question needs your saved answer or review.'};
 const existing=parse(job.answers_json)[question];
 if(typeof existing==='string'&&existing.trim())return {answer:existing,source:'saved',requiresReview:true};
 const owner=job.local_owner,applicant=job.applicant_id,url=job.url;
 const result=publicQuestion?await research(db,uid,id,question):await draft(db,uid,id,question,{choices,answerFormat});
 job=read();p=profile(job);
 if(!eligible(job,p)||job.local_owner!==owner||job.applicant_id!==applicant||job.url!==url||check(job)||researchConsentWithdrawn(db,id,p.id)||(publicQuestion?!p.google_research_consent:result.provider==='gemini'?!p.gemini_facts_consent:!p.ai_consent))throw Error('The form or your consent changed while drafting. Your answers were preserved.');
 const answers=parse(job.answers_json);
 if(typeof answers[question]==='string'&&answers[question].trim())return {answer:answers[question],source:'saved',requiresReview:true};
 if(!result.answer?.trim())return result;
 Object.defineProperty(answers,question,{value:result.answer.trim(),enumerable:true,configurable:true,writable:true});
 db.prepare('UPDATE jobs SET answers_json=?,updated_at=? WHERE id=?').run(JSON.stringify(answers),new Date().toISOString(),id);
 if(publicQuestion)markResearchDraftUsed(db,id,question);
 return {...result,source:publicQuestion?'public_page':'approved_facts',requiresReview:true};
}
