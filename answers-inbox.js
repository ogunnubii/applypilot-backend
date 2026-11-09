import {createHash} from 'node:crypto';
import {canCapture,canReuse} from './answer-library.js';
import {requestContinuation} from './continuation-queue.js';
import {hasFactDraft} from './draft-provenance.js';
import {hasResearchDraftForQuestion} from './google-research.js';

// Answers needed: one place to answer the questions that parked a form.
// This module stores only text the applicant typed. It never drafts, guesses,
// opens a browser, clicks Submit or restarts a paused or uncertain attempt.

const parse=(value,fallback)=>{try{return JSON.parse(value||'')??fallback;}catch{return fallback;}};
const SUBMISSION_EVENTS="('submission_started','automatic_submission','manual_submission','applicant_reported_submission','submitted','manual_confirmation')";
// A submission may be in flight or already made: the employer receipt decides.
const UNCERTAIN_CHALLENGES=new Set(['Unconfirmed submission','Submission in progress','Ready to submit','Employer application limit']);
// Where the applicant lives, recording or consent wording, and wording about one
// employer stay with that application even when the general library would allow reuse.
const SCOPED=/\b(?:address|street|apartment|suite|postal|post ?code|zip|mailing|residen(?:ce|tial)|where (?:do )?you live|record(?:ed|ing)?|consent|this (?:company|employer|organization|role|position|job|opportunity))\b/i;
const MAX_JOBS=50,MAX_QUESTIONS=60;

export const inboxCanReuse=question=>typeof question==='string'&&canReuse(question)&&!SCOPED.test(question);
// Consents, declarations, demographic, credential and payment questions are
// answered by the applicant on the employer page, never stored here.
export const employerOnly=question=>!canCapture(question)||/^required field\s*[*?]?$/i.test(String(question).trim());
// One typed answer may be copied, by explicit choice, to other parked forms asking
// the same question. Each application keeps its own copy; nothing goes to the profile.
// Employer-specific, salary, sponsorship and similar questions are never copied.
export const canCopyAcross=question=>typeof question==='string'&&!employerOnly(question)&&canReuse(question);
export const sameQuestionKey=question=>String(question).toLowerCase().replace(/\s+/g,' ').replace(/[\s*:?]+$/,'').trim();
const MAX_COPIES=20;

const tableExists=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const formKey=job=>createHash('sha256').update(JSON.stringify([job.id,job.url,job.required_fields_json])).digest('hex').slice(0,24);
const unanswered=(questions,answers)=>questions.filter(q=>!String(answers?.[q]??'').trim());
const editing=(db,id)=>tableExists(db,'answer_save_state')&&!!db.prepare('SELECT 1 FROM answer_save_state WHERE job_id=? AND editing=1').get(id);
function questionsOf(job){
 const fields=parse(job.required_fields_json,[]);
 return Array.isArray(fields)?[...new Set(fields.filter(q=>typeof q==='string'&&q.trim()&&q.length<=4000))]:[];
}
function draftBacked(db,id,question){
 // A model or research draft is provenance, not an applicant-stated fact.
 try{return hasFactDraft(db,id,question)||hasResearchDraftForQuestion(db,id,question);}catch{return true;}
}

// A parked form qualifies only while no submission can have started.
export function parkedForAnswers(db,job){
 if(!job)return false;
 const local=job.status==='local_browser'&&job.local_phase==='blocked',hosted=['paused','needs_review'].includes(job.status);
 if(!local&&!hosted)return false;
 if(job.local_attempt_at||job.confirmation||job.handoff_available||['verifying','uncertain','submitted'].includes(job.local_phase)||UNCERTAIN_CHALLENGES.has(job.challenge))return false;
 if(db.prepare(`SELECT 1 FROM events WHERE job_id=? AND type IN ${SUBMISSION_EVENTS}`).get(job.id))return false;
 if(tableExists(db,'autonomous_attempts')&&db.prepare('SELECT 1 FROM autonomous_attempts WHERE job_id=?').get(job.id))return false;
 return true;
}

export function answersInbox(db,uid){
 const rows=db.prepare("SELECT * FROM jobs WHERE user_id=? AND status IN ('local_browser','paused','needs_review') ORDER BY updated_at DESC,id LIMIT 200").all(uid);
 const jobs=[];let total=0,employer=0;
 for(const job of rows){
  if(jobs.length>=MAX_JOBS)break;
  if(!parkedForAnswers(db,job))continue;
  const open=unanswered(questionsOf(job),parse(job.answers_json,{})).slice(0,MAX_QUESTIONS);
  if(!open.length)continue;
  const questions=open.map(question=>employerOnly(question)
   ?{question,kind:'employer'}
   :{question,kind:'answer',reuse:inboxCanReuse(question)&&!draftBacked(db,job.id,question)});
  const answerable=questions.filter(q=>q.kind==='answer').length;
  total+=answerable;employer+=questions.length-answerable;
  jobs.push({id:job.id,company:job.company,title:job.title,url:job.url,mode:job.status==='local_browser'?'browser':'hosted',formKey:formKey(job),editing:editing(db,job.id),questions});
 }
 // Point each copyable question at the other listed forms that ask it too.
 for(const job of jobs)for(const item of job.questions){
  if(item.kind!=='answer'||!canCopyAcross(item.question)||draftBacked(db,job.id,item.question))continue;
  const key=sameQuestionKey(item.question);
  const others=jobs.filter(other=>other.id!==job.id&&!other.editing&&other.questions.some(q=>q.kind==='answer'&&sameQuestionKey(q.question)===key)).slice(0,MAX_COPIES);
  if(others.length)item.elsewhere=others.map(other=>({id:other.id,company:other.company,title:other.title,formKey:other.formKey}));
 }
 return {jobs,total,employer};
}

function fail(message,status=400){const error=Error(message);error.status=status;return error;}

// Save one typed answer, and optionally the same text for other listed forms.
// Optimistic checks keep a stale dashboard, a second tab or a helper write from
// being overwritten; every copy passes the same checks on its own form.
export function saveInboxAnswer(db,uid,jobId,{question,answer,remember=false,formKey:expected,also=[],check=()=>'',continueJob=requestContinuation}={}){
 if(typeof jobId!=='string'||!jobId)throw fail('Choose an application.');
 if(typeof question!=='string'||!question.trim())throw fail('Choose a question to answer.');
 if(typeof answer!=='string'||!answer.trim()||answer.length>4000)throw fail('Enter an answer up to 4000 characters.');
 if(!Array.isArray(also)||also.length>MAX_COPIES||also.some(x=>!x||typeof x.id!=='string'||!x.id||typeof x.formKey!=='string'))throw fail('Choose up to '+MAX_COPIES+' other applications.');
 const targets=[...new Map(also.filter(x=>x.id!==jobId).map(x=>[x.id,x])).values()];
 if(targets.length&&!canCopyAcross(question))throw fail('This answer is specific to one application and cannot be copied to others.',400);
 const value=answer.trim();
 const saved=writeAnswer(db,uid,jobId,question,value,{remember,expected});
 const copies=targets.map(target=>{
  const job=db.prepare('SELECT company,title,required_fields_json FROM jobs WHERE id=? AND user_id=?').get(target.id,uid);
  if(!job)return {id:target.id,saved:false,message:'Application not found.'};
  const own=questionsOf(job).find(q=>sameQuestionKey(q)===sameQuestionKey(question));
  if(!own)return {id:target.id,company:job.company,saved:false,message:'That question is not on this form.'};
  try{writeAnswer(db,uid,target.id,own,value,{remember:false,expected:target.formKey,source:'copied'});}
  catch(error){return {id:target.id,company:job.company,saved:false,message:error.message};}
  return {id:target.id,company:job.company,saved:true,resume:resumeAfterAnswer(db,uid,target.id,{check,continueJob})};
 });
 return {ok:true,...saved,resume:resumeAfterAnswer(db,uid,jobId,{check,continueJob}),also:copies};
}

function writeAnswer(db,uid,jobId,question,value,{remember=false,expected,source='typed'}={}){
 const at=new Date().toISOString();
 let remembered=false,profileConflict=false;
 db.exec('BEGIN IMMEDIATE');
 try{
  const job=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(jobId,uid);
  if(!job){throw fail('Application not found.',404);}
  if(!parkedForAnswers(db,job))throw fail('This application is no longer waiting for answers. Check its status before changing anything.',409);
  if(expected!==formKey(job))throw fail('This form changed since the list loaded. Refresh Answers needed.',409);
  if(!questionsOf(job).includes(question))throw fail('That question is not on this form.',409);
  if(employerOnly(question))throw fail('Answer this question yourself on the employer page.',400);
  if(source==='copied'&&(!canCopyAcross(question)||draftBacked(db,job.id,question)))throw fail('This question on this form stays with you.',400);
  if(editing(db,job.id))throw fail('This answer is being edited in the employer tab. Finish it there first.',409);
  const answers=parse(job.answers_json,{});
  if(!answers||typeof answers!=='object'||Array.isArray(answers))throw fail('Saved answers for this application could not be read.',409);
  if(String(answers[question]??'').trim())throw fail('This question was already answered elsewhere. Refresh to see it.',409);
  if(remember&&(!inboxCanReuse(question)||draftBacked(db,job.id,question)))throw fail('This answer stays with this application only.',400);
  Object.defineProperty(answers,question,{value,enumerable:true,configurable:true,writable:true});
  const changed=db.prepare('UPDATE jobs SET answers_json=?,updated_at=? WHERE id=? AND user_id=? AND status=? AND answers_json=? AND local_attempt_at IS NULL').run(JSON.stringify(answers),at,job.id,uid,job.status,job.answers_json);
  if(!changed.changes)throw fail('This application changed while saving. Refresh Answers needed.',409);
  if(remember){
   const profile=db.prepare('SELECT answers_json FROM applicants WHERE id=? AND user_id=?').get(job.applicant_id,uid);
   const facts=parse(profile?.answers_json,{});
   if(!profile||!facts||typeof facts!=='object'||Array.isArray(facts))profileConflict=true;
   // Never silently replace a different saved fact; the answer library decides that.
   else if(String(facts[question]??'').trim()&&String(facts[question]).trim()!==value)profileConflict=true;
   else{Object.defineProperty(facts,question,{value,enumerable:true,configurable:true,writable:true});db.prepare('UPDATE applicants SET answers_json=? WHERE id=? AND user_id=?').run(JSON.stringify(facts),job.applicant_id,uid);remembered=true;}
  }
  db.prepare('INSERT INTO events(job_id,at,type,message) VALUES(?,?,?,?)').run(job.id,at,'answer_saved',source==='copied'?'Saved from Answers needed: the applicant chose to use the same typed answer for this application':remembered?'Saved from Answers needed and kept for future applications':'Saved from Answers needed for this application only');
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
 return {remembered,profileConflict};
}

// After the last answer, a browser form joins the existing continuation queue,
// which re-checks the live form in its one matching tab. Hosted forms wait for
// the applicant's Continue click: a paused attempt is never restarted here.
export function resumeAfterAnswer(db,uid,jobId,{check=()=>'',continueJob=requestContinuation}={}){
 const job=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(jobId,uid);
 if(!parkedForAnswers(db,job))return {state:'held',message:'This application is no longer waiting for answers.'};
 const open=unanswered(questionsOf(job),parse(job.answers_json,{}));
 const employer=open.filter(employerOnly).length,remaining=open.length-employer;
 if(remaining)return {state:'waiting',remaining,employer,message:remaining+' more answer'+(remaining===1?'':'s')+' needed.'};
 if(employer)return {state:'employer',remaining:0,employer,message:'Answers saved. '+employer+' question'+(employer===1?'':'s')+' must be answered on the employer page.'};
 if(job.status!=='local_browser')return {state:'manual',message:'Answers saved. Use Continue on this application when you are ready.'};
 try{const result=continueJob(db,uid,jobId,check);return {state:result?.state||'queued',message:'Answers saved. The helper will continue this form in its tab. Final Submit stays yours.'};}
 catch(error){return {state:'held',message:String(error.message||'Answers saved. Continue was held.').slice(0,300)};}
}
