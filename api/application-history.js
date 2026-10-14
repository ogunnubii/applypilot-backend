import {randomUUID} from 'node:crypto';
import {companyKey,historyKey,normalizeHistoryRows} from '../application-history.js';
import {DatabaseError} from '../database/async-database.js';

class RequestError extends Error {constructor(status,message){super(message);this.status=status;}}
const key=(company,title)=>JSON.stringify([companyKey(company),historyKey(title)]);
export async function applicationHistory(database,{uid,method,input}){
 if(!uid)return {status:401,body:{error:'Sign in required'}};
 let clean;
 if(method==='POST')try{clean=normalizeHistoryRows(input?.rows);}catch{return {status:400,body:{error:'Import 1–500 records with a valid company, title, status and interview stage.'}};}
 else if(method!=='GET')return {status:405,body:{error:'Unsupported operation.'}};
 try{
  const body=await database[method==='GET'?'read':'write'](async tx=>{
   if(!await tx.get('SELECT id FROM users WHERE id=?',uid))throw new RequestError(401,'Sign in required');
   if(method==='GET')return {records:await tx.all('SELECT id,company,title,status,source,notes,imported_at,work_mode,country,interview_at,interview_stage FROM external_application_history WHERE user_id=? ORDER BY company,title',uid)};
   const wanted=new Set(clean.map(r=>key(r.company,r.title))),matches=new Map();
   // Compute the shared native normalization in JS, with bounded pages. No
   // connection-local SQL function is required by this repository's queries.
   for(let offset=0;;offset+=100){
    const page=await tx.all(`SELECT id,company,title,status,handoff_available,local_attempt_at,attempts,confirmation,local_phase,challenge,
     EXISTS(SELECT 1 FROM autonomous_attempts a WHERE a.job_id=jobs.id) AS has_intent,
     EXISTS(SELECT 1 FROM events e WHERE e.job_id=jobs.id AND e.type IN ('submission_started','manual_submission','automatic_submission','applicant_reported_submission','submitted','manual_confirmation')) AS has_evidence
     FROM jobs WHERE user_id=? ORDER BY id LIMIT 100 OFFSET ?`,uid,offset);
    if(offset+page.length>20000)throw new RequestError(409,'History import requires a smaller verified account projection.');
    for(const job of page){const k=key(job.company,job.title);if(wanted.has(k)){if(!matches.has(k))matches.set(k,[]);matches.get(k).push(job);}}
    if(page.length<100)break;
   }
   let added=0,updated=0,blocked=0;const active=new Map(),at=new Date().toISOString();
   for(const row of clean){
    const ck=companyKey(row.company),tk=historyKey(row.title);if(!ck||!tk)throw new RequestError(400,'Company and title must contain letters or numbers');
    const old=await tx.get('SELECT * FROM external_application_history WHERE user_id=? AND company_key=? AND title_key=?',uid,ck,tk);
    const status=old&&row.status==='applied'&&old.status!=='applied'?old.status:row.status;
    if(old){await tx.run('UPDATE external_application_history SET status=?,notes=?,updated_at=?,work_mode=?,country=?,interview_at=?,interview_stage=? WHERE id=? AND user_id=?',status,row.notes||old.notes,at,row.work_mode==='unknown'?old.work_mode:row.work_mode,row.country||old.country,row.interview_at||old.interview_at,row.interview_stage||old.interview_stage,old.id,uid);updated++;}
    else{await tx.run('INSERT INTO external_application_history(id,user_id,company,title,company_key,title_key,status,source,notes,imported_at,updated_at,work_mode,country,interview_at,interview_stage) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',randomUUID(),uid,row.company,row.title,ck,tk,status,row.source,row.notes,at,at,row.work_mode,row.country,row.interview_at,row.interview_stage||'scheduled');added++;}
    for(const job of matches.get(key(row.company,row.title))||[]){
     // An imported external record is not an employer receipt for this job.
     // Retain every active/uncertain attempt's status, challenge and evidence.
     const attempted=job.local_attempt_at||job.confirmation||job.attempts>0||job.has_intent||job.has_evidence||['verifying','uncertain','submitted'].includes(job.local_phase)||['Unconfirmed submission','Submission in progress'].includes(job.challenge);
     if(['saved','queued','paused','needs_review'].includes(job.status)&&!job.handoff_available&&!attempted){
      await tx.run("UPDATE jobs SET status='duplicate',challenge='Already applied externally',updated_at=? WHERE id=? AND user_id=?",at,job.id,uid);
      await tx.run("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'duplicate',?)",job.id,at,'Matched imported external application history; repeat application blocked');blocked++;job.status='duplicate';
     }else if(['running','local_browser'].includes(job.status)||attempted)active.set(job.id,{id:job.id,company:job.company,title:job.title});
    }
   }
   const {n:total}=await tx.get('SELECT count(*) n FROM external_application_history WHERE user_id=?',uid);
   return {added,updated,blocked,active:[...active.values()],total};
  });return {status:200,body};
 }catch(error){
  if(error instanceof RequestError)return {status:error.status,body:{error:error.message}};
  return {status:503,body:{error:'History import could not be confirmed. Reload the saved history before retrying.',code:error instanceof DatabaseError?error.code:'database_unavailable'}};
 }
}
