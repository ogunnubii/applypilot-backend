import {randomUUID} from 'node:crypto';
import {currentSearchScope,currentScopeAssessment,scopeIntent,searchScopeSignature} from './search-scope.js';
import {matchAssessment} from './matching.js';
import {prioritizeApplications} from './application-diversity.js';
import {priorApplication,applicationRoleKey} from './application-dedup.js';
import {companyKey,historyKey} from './application-history.js';
import {employerHold} from './employer-limits.js';
import {excludesFrench,frenchApplication} from './language-policy.js';
import {supported,sameApplication} from './local-policy.js';
import {metadataFor} from './job-intelligence.js';
import {researchConsentWithdrawn} from './research-consent.js';
import {salaryTarget} from './support-career.js';

const terminal=new Set(['submitted','interview','rejected','offer','archived','duplicate']);
const clean=value=>String(value||'').toLowerCase().replace(/\bsr\.?\b/g,'senior').replace(/\bsre\b/g,'site reliability engineer').replace(/[^a-z0-9]+/g,' ').trim();
export function installPreparationCampaign(db){db.exec(`CREATE TABLE IF NOT EXISTS preparation_campaigns(user_id TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,applicant_id TEXT NOT NULL,target INTEGER NOT NULL,batch_size INTEGER NOT NULL,roles_json TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preparation_members(campaign_id TEXT NOT NULL,job_id TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL,position INTEGER NOT NULL,title_group TEXT NOT NULL,prepared_at TEXT,ready_at TEXT,PRIMARY KEY(campaign_id,job_id));`);
 for(const column of ['excluded_at','exclusion_reason'])if(!db.prepare('PRAGMA table_info(preparation_members)').all().some(c=>c.name===column))db.exec('ALTER TABLE preparation_members ADD COLUMN '+column+' TEXT');
}
function installed(db){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='preparation_campaigns'").get();}
export function preparationCampaign(db,uid){return installed(db)?db.prepare('SELECT * FROM preparation_campaigns WHERE user_id=?').get(uid):null;}
export function preparationMember(db,job){return installed(db)?db.prepare('SELECT * FROM preparation_members WHERE job_id=? AND user_id=?').get(job.id,job.user_id):null;}
export function titleGroup(title,roles){
 const value=' '+clean(title)+' ',matches=roles.map((role,index)=>({role,index,key:clean(role)})).filter(x=>value.includes(' '+x.key+' '));
 matches.sort((a,b)=>b.key.length-a.key.length||a.index-b.index);
 return matches[0]?.role||clean(title);
}
// Persisted campaign exposure drives each round. Title rotation precedes company,
// platform and fit ranking; unavailable titles do not stall unrelated eligible work.
export function rotateTitles(rows,roles,history=[]){
 const counts=new Map(),order=new Map(roles.map((r,i)=>[r,i]));for(const row of history){const group=row.title_group||titleGroup(row.title,roles);counts.set(group,(counts.get(group)||0)+1);}
 const remaining=rows.map((job,index)=>({job,index,group:titleGroup(job.title,roles)})),result=[];
 while(remaining.length){remaining.sort((a,b)=>(counts.get(a.group)||0)-(counts.get(b.group)||0)||(order.get(a.group)??roles.length)-(order.get(b.group)??roles.length)||a.index-b.index);const row=remaining.shift();result.push({...row.job,title_group:row.group});counts.set(row.group,(counts.get(row.group)||0)+1);}return result;
}
function attempted(db,job){return !!job.local_attempt_at||!!job.confirmation||['verifying','uncertain','submitted'].includes(job.local_phase)||['Submission in progress','Unconfirmed submission'].includes(job.challenge)||!!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('submission_started','automatic_submission','manual_submission','applicant_reported_submission','submitted','manual_confirmation') LIMIT 1").get(job.id)||!!db.prepare('SELECT 1 FROM autonomous_attempts WHERE job_id=?').get(job.id);}
export function preparationCandidateProblem(db,job,{fresh=true}={}){
 const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(job.applicant_id,job.user_id),scope=currentSearchScope(db,job),meta=metadataFor(job);
 if(!p?.consent||!p.email||!p.resume_path)return 'Your saved profile, consent and resume are required.';
 if(!scope)return 'An enabled structured search is required.';
 if(attempted(db,job)||terminal.has(job.status))return 'A previous application is protected against repeats.';
 if(fresh&&(!['saved','queued'].includes(job.status)||Number(job.attempts)||job.local_owner||job.handoff_available||job.challenge))return 'Only fresh untouched applications enter this campaign.';
 if(!supported(job.url)||meta.available!==true||!Number.isFinite(Date.parse(meta.checkedAt))||Date.now()-Date.parse(meta.checkedAt)>=86400000)return 'A fresh, available employer posting is required.';
 if(meta.searchScopeSignature!==searchScopeSignature(scope))return 'Refresh this posting against your current search.';
 if(!matchAssessment({...meta,title:job.title},scopeIntent(scope),p.focus).strong||currentScopeAssessment(db,job)?.eligibility?.eligible!==true)return 'Role or work-location eligibility needs review.';
 const minimum=db.prepare('SELECT minimum_cad FROM application_batch_preferences WHERE user_id=?').get(job.user_id)?.minimum_cad||120000;
 if(salaryTarget(meta.pay||[],minimum).reason==='Published range is below target')return 'Published pay is below your CAD '+minimum.toLocaleString()+' target.';
 if(excludesFrench(db,job.user_id)&&frenchApplication(job))return 'French application excluded.';
 if(employerHold(db,job))return employerHold(db,job).message;
 if(researchConsentWithdrawn(db,job.id,p.id))return 'Drafting consent needs review.';
 if(priorApplication(db,job.user_id,job)||db.prepare('SELECT 1 FROM external_application_history WHERE user_id=? AND company_key=? AND title_key=?').get(job.user_id,companyKey(job.company),historyKey(job.title)))return 'Previous application found.';
 // Interview variants (for example a weekend annotation) are held for review,
 // rather than treating another requisition URL as permission to reapply.
 const core=value=>applicationRoleKey(String(value).replace(/\([^)]*\)/g,''));
 const interviews=db.prepare("SELECT company,title FROM external_application_history WHERE user_id=? AND status='interview' UNION ALL SELECT company,title FROM jobs WHERE user_id=? AND status='interview'").all(job.user_id,job.user_id);
 if(interviews.some(old=>companyKey(old.company)===companyKey(job.company)&&core(old.title)===core(job.title)))return 'An interview already exists for this role.';
 return '';
}
export function populatePreparationCampaign(db,uid){
 const c=preparationCampaign(db,uid);if(!c?.enabled)return preparationSnapshot(db,uid);
 db.exec('BEGIN IMMEDIATE');try{
  // Recheck untouched selections as evidence changes. Retain exclusions for
  // audit and duplicate protection without spending one of the target places.
  for(const m of db.prepare('SELECT * FROM preparation_members WHERE campaign_id=? AND excluded_at IS NULL').all(c.id)){
   const j=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(m.job_id,uid);
   if(!j||!['saved','queued'].includes(j.status)||j.local_owner||j.local_attempt_at||Number(j.attempts))continue;
   const reason=preparationCandidateProblem(db,j),exclude=reason&&(/^Role or work-location|^Published pay|^French application excluded|^Previous application found|^An interview already exists/.test(reason)||metadataFor(j).available===false);
   if(exclude)db.prepare('UPDATE preparation_members SET excluded_at=?,exclusion_reason=?,ready_at=NULL WHERE job_id=?').run(new Date().toISOString(),reason,j.id);
  }
  const members=db.prepare('SELECT m.*,j.status FROM preparation_members m JOIN jobs j ON j.id=m.job_id WHERE m.campaign_id=? AND m.excluded_at IS NULL ORDER BY position').all(c.id);
  const nextPosition=db.prepare('SELECT COALESCE(MAX(position),0) n FROM preparation_members WHERE campaign_id=?').get(c.id).n;
  const capacity=Math.min(c.target-members.length,c.batch_size-members.filter(j=>!terminal.has(j.status)).length);
  if(capacity>0){const candidates=db.prepare("SELECT * FROM jobs WHERE user_id=? AND applicant_id=? AND status IN ('saved','queued') AND NOT EXISTS(SELECT 1 FROM preparation_members m WHERE m.job_id=jobs.id)").all(uid,c.applicant_id).filter(j=>!preparationCandidateProblem(db,j));
   const ordered=rotateTitles(prioritizeApplications(db,uid,candidates),JSON.parse(c.roles_json),members);
   for(const [i,j]of ordered.slice(0,capacity).entries()){
    db.prepare('INSERT INTO preparation_members(campaign_id,job_id,user_id,position,title_group) VALUES(?,?,?,?,?)').run(c.id,j.id,uid,nextPosition+i+1,j.title_group);
    if(j.status==='saved')db.prepare("UPDATE jobs SET status='queued',updated_at=? WHERE id=?").run(new Date().toISOString(),j.id);
   }
  }db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}return preparationSnapshot(db,uid);
}
export function startPreparationCampaign(db,uid,{applicant_id,target=200,batch_size=20,role_order}={}){
 if(!Number.isInteger(target)||target<1||target>200||!Number.isInteger(batch_size)||batch_size<1||batch_size>20)throw Error('Choose 1–200 applications and 1–20 open forms.');
 const scope=currentSearchScope(db,{user_id:uid,applicant_id});if(!scope)throw Error('Save an enabled structured search for this profile first.');
 const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(applicant_id,uid);if(!p?.consent||!p.email||!p.resume_path)throw Error('Complete your saved profile and resume first.');
 const roles=role_order??scope.roles;if(!Array.isArray(roles)||!roles.length||roles.length>200||roles.some(r=>typeof r!=='string'||!scope.roles.some(s=>clean(s)===clean(r))))throw Error('Use titles from the active structured search.');
 const old=preparationCampaign(db,uid);if(old&&(old.applicant_id!==applicant_id||old.target!==target||old.batch_size!==batch_size||JSON.stringify(roles)!==old.roles_json))throw Error('This campaign already exists. Resume it without replacing its history.');
 if(db.prepare("SELECT 1 FROM jobs WHERE user_id=? AND status='running' LIMIT 1").get(uid))throw Error('Let the current hosted form finish before switching to Chrome preparation.');
 db.exec('BEGIN IMMEDIATE');try{
  if(old)db.prepare('UPDATE preparation_campaigns SET enabled=1 WHERE user_id=?').run(uid);
  else db.prepare('INSERT INTO preparation_campaigns VALUES(?,?,?,?,?,?,1,?)').run(uid,randomUUID(),applicant_id,target,batch_size,JSON.stringify(roles),new Date().toISOString());
  db.prepare('UPDATE work_focus SET enabled=0,auto_submit=0,skip_blocked=0,job_id=NULL WHERE user_id=?').run(uid);
  db.prepare('UPDATE application_batch_preferences SET enabled=0 WHERE user_id=?').run(uid);
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}return populatePreparationCampaign(db,uid);
}
export function preparationSnapshot(db,uid){
 const c=preparationCampaign(db,uid);if(!c)return {enabled:false};
 const members=db.prepare('SELECT m.*,j.title,j.company,j.status,j.local_attempt_at,j.local_phase,j.updated_at FROM preparation_members m JOIN jobs j ON j.id=m.job_id WHERE m.campaign_id=? AND m.excluded_at IS NULL ORDER BY position').all(c.id).map((m,i)=>({...m,position:i+1}));
 return {enabled:!!c.enabled,id:c.id,applicant_id:c.applicant_id,target:c.target,batch_size:c.batch_size,selected:members.length,prepared:members.filter(j=>j.prepared_at).length,ready:members.filter(j=>j.ready_at&&!j.local_attempt_at&&j.status==='local_browser'&&Date.now()-Date.parse(j.ready_at)<90000).length,completed:members.filter(j=>['submitted','interview','rejected','offer'].includes(j.status)).length,role_order:JSON.parse(c.roles_json),members:members.map(({job_id,position,title_group,prepared_at,ready_at,status,title,company})=>({job_id,position,title_group,prepared_at,ready_at,status,title,company})),manual_submit:true};
}
export function preparationClaimProblem(db,job){
 const c=preparationCampaign(db,job.user_id);if(!c?.enabled)return null;
 const member=preparationMember(db,job);if(!member||member.campaign_id!==c.id||member.excluded_at)return 'This job is outside your Chrome preparation batch.';
 return preparationCandidateProblem(db,job,{fresh:job.status!=='local_browser'});
}
export function recordPreparationProgress(db,job,input){
 const member=preparationMember(db,job);if(!member||member.excluded_at)return;
 const ready=input.readyForSubmit===true&&input.blocked===true&&Array.isArray(input.fields)&&input.fields.length===0&&Number.isInteger(input.progress?.required)&&input.progress.required>0&&input.progress.required===input.progress.filled&&sameApplication(input.url,job.url)&&!attempted(db,job)&&!terminal.has(job.status);
 const at=new Date().toISOString();db.prepare('UPDATE preparation_members SET ready_at=?,prepared_at=CASE WHEN ? THEN COALESCE(prepared_at,?) ELSE prepared_at END WHERE job_id=? AND user_id=?').run(ready?at:null,ready?1:0,at,job.id,job.user_id);
}

