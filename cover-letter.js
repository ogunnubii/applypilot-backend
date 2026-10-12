import {createHash} from 'node:crypto';
import {experienceFor} from './experience-library.js';
import {reusableAnswers} from './answer-library.js';
import {answerLimit} from './answer-drafts.js';
import {factDraftProvider} from './draft-provenance.js';
import {protectedHostedQuestion} from './hosted-form.js';
import {coverLetterFormat,documentTypes,renderCoverLetter} from './cover-letter-document.js';

const parse=value=>{try{return JSON.parse(value||'{}');}catch{return {};}};
const compact=value=>String(value||'').replace(/\s+/g,' ').trim();
export const isCoverLetter=value=>/\bcover[\s_-]*letter\b/i.test(String(value||'').replace(/([a-z])([A-Z])/g,'$1 $2'));
export function installCoverLetters(db){db.exec(`CREATE TABLE IF NOT EXISTS cover_letters(
 job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,user_id TEXT NOT NULL,applicant_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,letter TEXT NOT NULL,source TEXT NOT NULL,created_at TEXT NOT NULL);`);}
export function hasCoverLetter(db,id){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cover_letters'").get())return false;
 return !!db.prepare('SELECT 1 FROM cover_letters WHERE job_id=?').get(id);
}
function context(db,uid,id){
 const job=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(id,uid);
 const profile=job&&db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(job.applicant_id,uid);
 if(!job||!profile)throw Error('Application not found.');
 const facts=reusableAnswers(db,profile),experience=experienceFor(db,uid,profile.id);
 const fingerprint=createHash('sha256').update(JSON.stringify({policy:1,uid,job:{id:job.id,applicant:job.applicant_id,title:job.title,company:job.company,url:job.url,metadata:job.job_metadata_json,answers:job.answers_json},profile:{id:profile.id,name:profile.name,answers:profile.answers_json,resume:profile.resume_path,consent:profile.consent},facts,experience})).digest('hex');
 return {job,profile,facts,experience,fingerprint};
}
function eligible(db,c,{expectedOwner,check=()=>''}={}){
 const {job:j,profile:p}=c;
 if(!p.consent||!['running','local_browser'].includes(j.status)||j.local_attempt_at||j.handoff_available||['uncertain','verifying'].includes(j.local_phase)||['Submission in progress','Unconfirmed submission'].includes(j.challenge)||expectedOwner&&j.local_owner!==expectedOwner||db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submission_started','manual_submission','submitted')").get(j.id))throw Error('This application is paused or cannot be prepared now.');
 const problem=check(j);if(problem)throw Error(problem);
}
// Verbatim professional sentences only: no model, inferred experience, product
// enthusiasm, credentials, citizenship or invented metrics. Labels and source
// annotations never become employer-facing prose.
const excluded=/https?:|\[[^\]]*\]|\b(?:tailored to|approved (?:fact|resume)|source|citation|ignore .*instruction|system prompt|citizen\w*|nationality|visa|sponsor\w*|work authori\w*|salary|compensation|date of birth)\b/i;
function professionalSentences(c){
 const entries=Object.entries(c.facts).filter(([q])=>/^(?:professional background|professional summary|career summary)$/i.test(q)).map(([,a])=>a);
 entries.push(...c.experience.filter(e=>e.approved_at).map(e=>e.details));
 const words=new Set(compact(c.job.title).toLowerCase().match(/[a-z]{3,}/g)||[]);
 return [...new Set(entries.flatMap(value=>String(value).split(/\r?\n/).filter(line=>!excluded.test(line)).flatMap(line=>line.replace(/^\s*[-*•]\s+/,'').split(/(?<=[.!?])\s+(?=[A-Z“"'])/))).map(compact).filter(s=>s.length>=20&&s.length<=600&&s.split(/\s+/).length>=4&&!excluded.test(s)&&!/[{}<>]|\b(?:must|should) (?:write|include|say|claim)\b/i.test(s)&&!/:$/.test(s)))].map((text,index)=>({text,index,score:[...words].filter(w=>text.toLowerCase().includes(w)).length})).sort((a,b)=>b.score-a.score||a.index-b.index);
}
export function composeCoverLetter(c,{maxLength=4000,question='Cover letter',fieldHelp=''}={}){
 const name=compact(c.profile.name),title=compact(c.job.title),company=compact(c.job.company);
 if(!name||!title||!company||[name,title,company].some(v=>v.length>200||/[\r\n<>\[\]{}]/.test(v)))return {answer:'',reason:'Save your name and the actual role title and company before preparing this letter.'};
 const limits=answerLimit(question,maxLength,fieldHelp),facts=professionalSentences(c),selected=[];
 const letter=()=>`Dear Hiring Team,\n\nI am applying for the ${title} role at ${company}.\n\n${selected.join(' ')}\n\nI would welcome the opportunity to discuss how my background could contribute to your team. Thank you for considering my application.\n\nSincerely,\n${name}`;
 for(const {text} of facts){if(selected.length>=3)break;selected.push(text);const draft=letter();if(draft.length>limits.characters||draft.split(/\s+/).length>Math.min(limits.words,200))selected.pop();}
 if(!selected.length)return {answer:'',reason:facts.length?'The employer’s length limit is too short for this letter. Please provide a shorter cover letter.':'Save a brief description of your real professional background in Profile setup or a confirmed experience entry.'};
 return {answer:letter(),source:'generated'};
}
export function coverLetterPreview(db,uid,id){
 const c=context(db,uid,id),row=db.prepare('SELECT * FROM cover_letters WHERE job_id=? AND user_id=? AND applicant_id=?').get(id,uid,c.profile.id);
 return row?{text:row.letter,source:row.source,stale:row.fingerprint!==c.fingerprint,requiresReview:true}:null;
}
export async function prepareCoverLetter(db,uid,id,{question='Cover letter',required=false,format='text',accept='',maxLength=4000,fieldHelp='',expectedOwner,check,render=renderCoverLetter}={}){
 if(!isCoverLetter(question)||/\b(?:resume|cv|curriculum)\b/i.test(question)||question.length>4000||!['text','file'].includes(format))throw Error('A clearly identified cover-letter field is required.');
 const c=context(db,uid,id);eligible(db,c,{expectedOwner,check});
 if(required!==true)return {answer:'',reason:'Optional cover letters are left for you to add.'};
 if(protectedHostedQuestion(question+' '+fieldHelp))return {answer:'',reason:'This cover-letter request includes personal declarations or protected facts. Please provide your own letter for these requirements.'};
 if(maxLength===0)return {answer:'',reason:'The employer field does not accept text. Please review it.'};
 const extension=format==='file'?coverLetterFormat(accept):null;
 if(format==='file'&&!extension)return {answer:'',reason:'This employer does not accept PDF or DOCX. Please attach your own cover letter in its required format.'};
 // Only an application-specific user letter can take precedence. Never reuse
 // another job's letter, including a profile-level or captured library answer.
 const saved=[...new Set(Object.entries(parse(c.job.answers_json)).filter(([q,a])=>isCoverLetter(q)&&typeof a==='string'&&a.trim()&&!factDraftProvider(db,id,q,a)).map(([,a])=>a.trim()))];
 if(saved.length>1)return {answer:'',reason:'This application has conflicting saved cover letters. Please choose the one to use.'};
 const result=saved.length?{answer:saved[0],source:'user'}:composeCoverLetter(c,{question,maxLength,fieldHelp});
 if(!result.answer)return result;
 const limits=answerLimit(question,maxLength,fieldHelp);
 if(result.answer.length>limits.characters||result.answer.split(/\s+/).length>limits.words)return {answer:'',reason:'Your saved cover letter exceeds the employer’s length limit. It has been preserved.'};
 const bytes=extension?await render(result.answer,extension):null;
 const current=context(db,uid,id);eligible(db,current,{expectedOwner,check});
 if(current.fingerprint!==c.fingerprint||current.job.local_owner!==c.job.local_owner)throw Error('Your profile or application changed while preparing the cover letter. Try again with the current details.');
 db.prepare('INSERT INTO cover_letters VALUES(?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET user_id=excluded.user_id,applicant_id=excluded.applicant_id,fingerprint=excluded.fingerprint,letter=excluded.letter,source=excluded.source,created_at=excluded.created_at').run(id,uid,c.profile.id,c.fingerprint,result.answer,result.source,new Date().toISOString());
 return {...result,requiresReview:true,manualSubmit:true,...(bytes?{file:{name:'cover-letter.'+extension,mimeType:documentTypes[extension],base64:bytes.toString('base64')}}:{})};
}
