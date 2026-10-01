import {priorApplication} from './application-dedup.js';
import {companyKey,historyKey} from './application-history.js';
import {supported} from './local-policy.js';
import {metadataFor} from './job-intelligence.js';
import {researchConsentWithdrawn} from './research-consent.js';
export function installPipeline(db){
 db.exec("CREATE TABLE IF NOT EXISTS pipeline_preferences(user_id TEXT PRIMARY KEY,auto_queue_found INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL)");
}
export function pipelineEnabled(db,userId){
 return !!db.prepare('SELECT auto_queue_found FROM pipeline_preferences WHERE user_id=?').get(userId)?.auto_queue_found;
}
export function queueFoundApplications(db,userId,{applicantId=null}={}){
 const result={queued:0,held:0,duplicates:0,applications:[]},at=new Date().toISOString();
 const record=(job,type,message)=>db.prepare('INSERT INTO events(job_id,at,type,message) VALUES(?,?,?,?)').run(job.id,at,type,message);
 db.exec('BEGIN IMMEDIATE');
 try{
  const rows=db.prepare("SELECT * FROM jobs WHERE user_id=? AND status='saved' AND (? IS NULL OR applicant_id=?) ORDER BY match_score DESC,created_at,id").all(userId,applicantId,applicantId);
  for(const job of rows){
   const profile=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(job.applicant_id,userId);
   const imported=db.prepare('SELECT 1 FROM external_application_history WHERE user_id=? AND company_key=? AND title_key=?').get(userId,companyKey(job.company),historyKey(job.title));
   const duplicate=priorApplication(db,userId,job)||imported;
   const priorAttempt=job.local_attempt_at||Number(job.attempts)>0||job.handoff_available||db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submission_started','submitted','manual_confirmation')").get(job.id);
   let reason='';
   if(priorAttempt)reason='Previous application work or a submission attempt exists. Check the existing employer session or receipt before continuing.';
   else if(duplicate){
    db.prepare("UPDATE jobs SET status='duplicate',challenge='Already applied or in progress',updated_at=? WHERE id=? AND status='saved'").run(at,job.id);
    record(job,'duplicate','Prior application retained; repeat application excluded from the pipeline.');result.duplicates++;continue;
   }else if(job.challenge)reason='Resolve the existing application blocker: '+job.challenge;
   else if(!profile?.consent||!profile.email||!profile.resume_path)reason='Profile consent, email and a resume are required before application preparation.';
   else if(metadataFor(job).available===false)reason='A current employer posting could not be verified. Check that the application link is still available.';
   else if(!supported(job.url))reason='A supported direct employer application link is required.';
   else if(researchConsentWithdrawn(db,job.id,profile.id))reason='Google public job-page drafting consent was withdrawn.';
   if(reason){
    db.prepare("UPDATE jobs SET status='needs_review',challenge=COALESCE(challenge,'Pipeline needs attention'),updated_at=? WHERE id=? AND status='saved'").run(at,job.id);
    record(job,'needs_review',reason);result.held++;result.applications.push({id:job.id,company:job.company,title:job.title,status:'needs_review',reason});continue;
   }
   const update=db.prepare("UPDATE jobs SET status='queued',updated_at=? WHERE id=? AND user_id=? AND status='saved' AND local_attempt_at IS NULL AND attempts=0 AND handoff_available=0").run(at,job.id,userId);
   if(update.changes){record(job,'queued','Found job added to the ranked application pipeline.');result.queued++;result.applications.push({id:job.id,company:job.company,title:job.title,status:'queued'});}
  }
  db.exec('COMMIT');return result;
 }catch(error){db.exec('ROLLBACK');throw error;}
}
export function pipelineStatus(db,userId){
 return {enabled:pipelineEnabled(db,userId),found:db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND status='saved'").get(userId).n};
}
export function setPipeline(db,userId,enabled){
 if(typeof enabled!=='boolean')throw Error('Choose whether found jobs should queue automatically.');
 db.prepare('INSERT INTO pipeline_preferences(user_id,auto_queue_found,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET auto_queue_found=excluded.auto_queue_found,updated_at=excluded.updated_at').run(userId,enabled?1:0,new Date().toISOString());
 if(enabled)db.prepare('DELETE FROM work_focus WHERE user_id=?').run(userId);
 return {...pipelineStatus(db,userId),result:enabled?queueFoundApplications(db,userId):null};
}
export function queueEnabledPipelines(db){
 return db.prepare('SELECT user_id FROM pipeline_preferences WHERE auto_queue_found=1').all().map(row=>({userId:row.user_id,...queueFoundApplications(db,row.user_id)}));
}
