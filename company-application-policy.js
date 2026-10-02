import {employerKey} from './employer-limits.js';
import {companyKey} from './application-history.js';

const OUTCOMES=new Set(['submitted','interview','rejected','offer']);
const LIMIT_ERROR='Same-company application limit reached';
const DUPLICATE_ERROR='Exact requisition already started';

function bounded(value,fallback,min,max){
 if(value===undefined||value===null||String(value).trim()==='')return fallback;
 const parsed=Number(value);
 return Number.isFinite(parsed)?Math.max(min,Math.min(max,Math.trunc(parsed))):fallback;
}
export const companyApplicationLimit=(env=process.env)=>bounded(env.SAME_COMPANY_APPLICATION_LIMIT,5,1,50);
export const companyApplicationWindowDays=(env=process.env)=>bounded(env.SAME_COMPANY_WINDOW_DAYS,60,1,365);

function atsKey(job){
 try{
  const u=new URL(job.url),parts=u.pathname.split('/').filter(Boolean),host=u.hostname.toLowerCase();
  if(host==='jobs.smartrecruiters.com'&&parts[0])return 'smartrecruiters:'+parts[0].toLowerCase();
  if(host==='apply.workable.com'&&parts[0])return 'workable:'+parts[0].toLowerCase();
  const tenant=host.replace(/^(?:www\.)?/,'').split('.')[0];
  if(host.endsWith('.bamboohr.com')&&tenant)return 'bamboohr:'+tenant;
  if(host.endsWith('.recruitee.com')&&tenant)return 'recruitee:'+tenant;
  if((host.endsWith('.myworkdayjobs.com')||host.endsWith('.workdayjobs.com'))&&tenant&&!/^wd\d+$/i.test(tenant))return 'workday:'+tenant;
 }catch{}
 return '';
}
export function companyApplicationKeys(job){
 const name=companyKey(job?.company),keys=[employerKey(job||{}),atsKey(job||{}),name?'company:'+name:''];
 return [...new Set(keys.filter(Boolean))].sort();
}
function keysJSON(job){return JSON.stringify(companyApplicationKeys(job));}
function overlap(left,right){
 try{const b=new Set(JSON.parse(String(right||'[]')));return JSON.parse(String(left||'[]')).some(key=>b.has(key));}catch{return false;}
}
function cutoff(now,days){return new Date(now-days*86400000).toISOString();}
function started(job){return ['running','local_browser'].includes(job.status)||OUTCOMES.has(job.status)||Number(job.attempts)>0||!!job.local_attempt_at||!!job.confirmation;}
function appendNote(notes,message){const value=String(notes||'');return value.includes('Same-company limit reached:')?value:[value,message].filter(Boolean).join(' · ');}

export function companyApplicationPolicy(db,applicantId,job,{env=process.env,now=Date.now()}={}){
 const limit=companyApplicationLimit(env),windowDays=companyApplicationWindowDays(env),keys=companyApplicationKeys(job);
 const own=job?.id&&db.prepare('SELECT * FROM company_application_activity WHERE job_id=?').get(job.id);
 if(own)return {allowed:true,count:0,limit,windowDays,remaining:limit,resume:true};
 const exact=job?.normalized_url&&db.prepare('SELECT job_id FROM company_application_activity WHERE applicant_id=? AND normalized_url=? AND job_id!=? LIMIT 1').get(applicantId,job.normalized_url,job.id||'');
 if(exact)return {allowed:false,duplicate:true,count:0,limit,windowDays,remaining:0,message:'This exact requisition was already started and will not be opened again.'};
 if(!keys.length)return {allowed:true,count:0,limit,windowDays,remaining:limit};
 const rows=db.prepare('SELECT job_id,company_keys,started_at FROM company_application_activity WHERE applicant_id=? AND job_id!=? AND (started_at IS NULL OR started_at>=?)').all(applicantId,job?.id||'',cutoff(now,windowDays));
 const encoded=JSON.stringify(keys),count=rows.filter(row=>overlap(row.company_keys,encoded)).length;
 return {allowed:count<limit,count,limit,windowDays,remaining:Math.max(0,limit-count),message:`Same-company limit reached: ${limit} applications per rolling ${windowDays} days. This requisition will stay in Found until a slot opens.`};
}

export function deferForCompanyLimit(db,job,policy,{at=new Date().toISOString()}={}){
 const current=db.prepare('SELECT notes FROM jobs WHERE id=?').get(job.id),notes=appendNote(current?.notes??job.notes,policy.message);
 db.prepare("UPDATE jobs SET status='saved',notes=?,updated_at=? WHERE id=? AND status IN ('saved','queued','paused','needs_review') AND attempts=0 AND local_attempt_at IS NULL").run(notes,at,job.id);
 const previous=db.prepare("SELECT message FROM events WHERE job_id=? AND type='company_limit' ORDER BY id DESC LIMIT 1").get(job.id)?.message;
 if(previous!==policy.message)db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'company_limit',?)").run(job.id,at,policy.message);
 return {id:job.id,company:job.company,title:job.title,status:'saved',reason:policy.message};
}

export function markExactRequisitionDuplicate(db,job,policy,{at=new Date().toISOString()}={}){
 const message=policy?.message||'This exact requisition was already started and will not be opened again.';
 const changed=db.prepare("UPDATE jobs SET status='duplicate',challenge=?,updated_at=? WHERE id=? AND status IN ('saved','queued','paused','needs_review') AND attempts=0 AND local_attempt_at IS NULL").run(message,at,job.id).changes;
 if(changed){
  const previous=db.prepare("SELECT message FROM events WHERE job_id=? AND type='duplicate' ORDER BY id DESC LIMIT 1").get(job.id)?.message;
  if(previous!==message)db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'duplicate',?)").run(job.id,at,message);
 }
 return {id:job.id,company:job.company,title:job.title,status:changed?'duplicate':job.status,reason:message};
}

export function isCompanyApplicationPolicyError(error){return new RegExp(LIMIT_ERROR+'|'+DUPLICATE_ERROR,'i').test(String(error?.message||error));}

export function registerCompanyApplicationPolicyFunctions(db,{env=process.env}={}){
 db.function('application_company_keys',{deterministic:true},(company,url)=>keysJSON({company,url}));
 db.function('company_keys_overlap',{deterministic:true},(left,right)=>Number(overlap(left,right)));
 db.function('company_policy_limit',{deterministic:true},()=>companyApplicationLimit(env));
 db.function('company_policy_cutoff',()=>cutoff(Date.now(),companyApplicationWindowDays(env)));
}

export function installCompanyApplicationPolicy(db,{env=process.env}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS company_application_activity(
  job_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,applicant_id TEXT NOT NULL,company TEXT NOT NULL,
  company_keys TEXT NOT NULL,normalized_url TEXT NOT NULL,reserved_at TEXT NOT NULL,started_at TEXT
 );CREATE INDEX IF NOT EXISTS company_activity_applicant ON company_application_activity(applicant_id,started_at);CREATE UNIQUE INDEX IF NOT EXISTS company_activity_exact ON company_application_activity(applicant_id,normalized_url);`);
 registerCompanyApplicationPolicyFunctions(db,{env});
 const exact="EXISTS(SELECT 1 FROM company_application_activity a WHERE a.applicant_id=NEW.applicant_id AND a.job_id!=NEW.id AND a.normalized_url=NEW.normalized_url)";
 const full="(SELECT COUNT(*) FROM company_application_activity a WHERE a.applicant_id=NEW.applicant_id AND a.job_id!=NEW.id AND (a.started_at IS NULL OR a.started_at>=company_policy_cutoff()) AND company_keys_overlap(a.company_keys,application_company_keys(NEW.company,NEW.url)))>=company_policy_limit()";
 db.exec(`
 CREATE TRIGGER IF NOT EXISTS company_policy_insert_exact BEFORE INSERT ON jobs WHEN (NEW.status IN ('queued','running','local_browser','submitted','interview','rejected','offer') OR NEW.attempts>0 OR NEW.local_attempt_at IS NOT NULL) AND ${exact} BEGIN SELECT RAISE(ABORT,'${DUPLICATE_ERROR}'); END;
 CREATE TRIGGER IF NOT EXISTS company_policy_insert_limit BEFORE INSERT ON jobs WHEN NEW.status IN ('queued','running','local_browser') AND ${full} BEGIN SELECT RAISE(ABORT,'${LIMIT_ERROR}'); END;
 CREATE TRIGGER IF NOT EXISTS company_policy_update_exact BEFORE UPDATE OF status,attempts,local_attempt_at ON jobs WHEN (NEW.status IN ('queued','running','local_browser','submitted','interview','rejected','offer') OR NEW.attempts>0 OR NEW.local_attempt_at IS NOT NULL) AND ${exact} BEGIN SELECT RAISE(ABORT,'${DUPLICATE_ERROR}'); END;
 CREATE TRIGGER IF NOT EXISTS company_policy_update_limit BEFORE UPDATE OF status ON jobs WHEN NEW.status IN ('queued','running','local_browser') AND ${full} BEGIN SELECT RAISE(ABORT,'${LIMIT_ERROR}'); END;
 CREATE TRIGGER IF NOT EXISTS company_policy_insert_activity AFTER INSERT ON jobs WHEN NEW.status IN ('queued','running','local_browser','submitted','interview','rejected','offer') OR NEW.attempts>0 OR NEW.local_attempt_at IS NOT NULL BEGIN
  INSERT INTO company_application_activity(job_id,user_id,applicant_id,company,company_keys,normalized_url,reserved_at,started_at) VALUES(NEW.id,NEW.user_id,NEW.applicant_id,NEW.company,application_company_keys(NEW.company,NEW.url),NEW.normalized_url,NEW.updated_at,CASE WHEN NEW.status IN ('running','local_browser','submitted','interview','rejected','offer') OR NEW.attempts>0 OR NEW.local_attempt_at IS NOT NULL THEN NEW.updated_at END);
 END;
 CREATE TRIGGER IF NOT EXISTS company_policy_update_activity AFTER UPDATE OF status,attempts,local_attempt_at ON jobs WHEN NEW.status IN ('queued','running','local_browser','submitted','interview','rejected','offer') OR NEW.attempts>0 OR NEW.local_attempt_at IS NOT NULL BEGIN
  INSERT INTO company_application_activity(job_id,user_id,applicant_id,company,company_keys,normalized_url,reserved_at,started_at) VALUES(NEW.id,NEW.user_id,NEW.applicant_id,NEW.company,application_company_keys(NEW.company,NEW.url),NEW.normalized_url,NEW.updated_at,CASE WHEN NEW.status IN ('running','local_browser','submitted','interview','rejected','offer') OR NEW.attempts>0 OR NEW.local_attempt_at IS NOT NULL THEN NEW.updated_at END)
  ON CONFLICT(job_id) DO UPDATE SET company=excluded.company,company_keys=excluded.company_keys,normalized_url=excluded.normalized_url,started_at=COALESCE(company_application_activity.started_at,excluded.started_at);
 END;
 CREATE TRIGGER IF NOT EXISTS company_policy_release_reservation AFTER UPDATE OF status ON jobs WHEN NEW.status NOT IN ('queued','running','local_browser','submitted','interview','rejected','offer') AND NEW.attempts=0 AND NEW.local_attempt_at IS NULL BEGIN
  DELETE FROM company_application_activity WHERE job_id=NEW.id AND started_at IS NULL;
 END;
 CREATE TRIGGER IF NOT EXISTS company_policy_delete_reservation AFTER DELETE ON jobs BEGIN
  DELETE FROM company_application_activity WHERE job_id=OLD.id AND started_at IS NULL;
 END;
 CREATE TRIGGER IF NOT EXISTS company_policy_lock_started_identity BEFORE UPDATE OF url,normalized_url ON jobs
 WHEN (NEW.url!=OLD.url OR NEW.normalized_url!=OLD.normalized_url)
 AND EXISTS(SELECT 1 FROM company_application_activity a WHERE a.job_id=OLD.id AND a.started_at IS NOT NULL) BEGIN
  SELECT RAISE(ABORT,'Started application identity cannot change');
 END;`);

 const rows=db.prepare("SELECT j.*,(SELECT MIN(at) FROM events WHERE job_id=j.id AND type IN ('running','local_browser','submission_started','submitted','manual_confirmation')) AS first_start,(SELECT MIN(at) FROM events WHERE job_id=j.id AND type='queued') AS first_queue FROM jobs j WHERE j.status!='duplicate' AND (j.status IN ('queued','running','local_browser','submitted','interview','rejected','offer') OR j.attempts>0 OR j.local_attempt_at IS NOT NULL OR j.confirmation IS NOT NULL) ORDER BY COALESCE(first_start,first_queue,j.created_at),j.id").all();
 db.exec('BEGIN IMMEDIATE');
 try{
  const seed=(job,isStarted)=>{
   if(db.prepare('SELECT 1 FROM company_application_activity WHERE job_id=?').get(job.id))return;
   const policy=companyApplicationPolicy(db,job.applicant_id,job,{env});
   if(!isStarted&&!policy.allowed){
    if(policy.duplicate)markExactRequisitionDuplicate(db,job,policy);
    else deferForCompanyLimit(db,job,policy);
    return;
   }
   const reserved=job.first_queue||job.created_at||new Date().toISOString(),startedAt=isStarted?(job.first_start||job.local_attempt_at||job.updated_at||reserved):null;
   try{
    db.prepare('INSERT INTO company_application_activity(job_id,user_id,applicant_id,company,company_keys,normalized_url,reserved_at,started_at) VALUES(?,?,?,?,?,?,?,?)').run(job.id,job.user_id,job.applicant_id,job.company,keysJSON(job),job.normalized_url,reserved,startedAt);
   }catch(error){
    if(!/UNIQUE constraint failed: company_application_activity\.applicant_id, company_application_activity\.normalized_url/.test(error.message))throw error;
    if(!isStarted)markExactRequisitionDuplicate(db,job,{message:'This exact requisition was already started and will not be opened again.'});
   }
  };
  // Started work is durable history and cannot be undone. Seed it first so
  // only the earliest untouched reservations can consume the remaining slots.
  for(const job of rows.filter(started))seed(job,true);
  for(const job of rows.filter(job=>!started(job)))seed(job,false);
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
}
