import {receipt} from './local-policy.js';

export function employerKey(job){
 try{
  const u=new URL(job.url),parts=u.pathname.split('/').filter(Boolean);
  if(['jobs.ashbyhq.com','jobs.eu.ashbyhq.com'].includes(u.hostname)&&parts[0])return 'ashby:'+parts[0].toLowerCase();
  if(['jobs.lever.co','jobs.eu.lever.co'].includes(u.hostname)&&parts[0])return 'lever:'+parts[0].toLowerCase();
  if(['boards.greenhouse.io','job-boards.greenhouse.io'].includes(u.hostname)&&parts[0])return 'greenhouse:'+parts[0].toLowerCase();
 }catch{}
 const name=String(job.company||'').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g,'');
 return name?'company:'+name:'';
}
export function applicationQuota(value){
 const text=String(value||'').replace(/[’]/g,"'").replace(/[–—]/g,'-').replace(/\s+/g,' ').trim();
 const amount=text.match(/(?:limit (?:applications|submissions) to (?:a total of )?|(?:submit|apply)(?: to)? up to )(\d{1,3})\b/i);
 if(!amount)return null;
 const tail=text.slice(amount.index,amount.index+amount[0].length+180);
 const span=tail.match(/(?:over|within|in) (?:the |a )?(?:span|period|course)?(?: of)?\s*(\d{1,3})[ -]*days?\b/i);
 const count=Number(amount[1]),days=span?Number(span[1]):null;
 return count>0&&days>0&&days<=365?{count,days}:null;
}
export function applicationLimit(value){
 const text=String(value||'').replace(/[’]/g,"'").replace(/\s+/g,' ').trim();
 const quota=applicationQuota(text);
 const reached=/\b(?:you (?:have |have already )?reached your application limit|you(?:'ve| have) reached (?:the |your )?(?:maximum|limit) (?:number )?of applications|application limit (?:has been )?reached)\b/i.test(text);
 const refusal=quota&&/\b(?:could(?:n't| not)|cannot|can't|unable to) submit (?:your |the )?application\b/i.test(text);
 if(!reached&&!refusal)return null;
 const {count=null,days=null}=quota||{};
 return {count,days,
 message:'Employer application limit reached'+(count&&days?': '+count+' applications per '+days+' days.':'.')+' This is not a submission confirmation.'};
}
export function installEmployerLimits(db){
 db.exec('CREATE TABLE IF NOT EXISTS employer_limits(user_id TEXT NOT NULL,applicant_id TEXT NOT NULL,employer_key TEXT NOT NULL,company TEXT NOT NULL,observed_at TEXT NOT NULL,hold_until TEXT,limit_count INTEGER,window_days INTEGER,message TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(user_id,applicant_id,employer_key))');
 const columns=db.prepare('PRAGMA table_info(employer_limits)').all().map(c=>c.name);
 if(!columns.includes('reached_at')){db.exec('ALTER TABLE employer_limits ADD COLUMN reached_at TEXT');db.exec('ALTER TABLE employer_limits ADD COLUMN reported_until TEXT');db.exec('UPDATE employer_limits SET reached_at=observed_at,reported_until=hold_until');}
 db.function('application_employer_key',{deterministic:true},(company,url)=>employerKey({company,url}));
 const match="EXISTS(SELECT 1 FROM employer_limits l WHERE l.user_id=NEW.user_id AND l.applicant_id=NEW.applicant_id AND l.employer_key=application_employer_key(NEW.company,NEW.url) AND (l.hold_until IS NULL OR l.hold_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))";
 db.exec("CREATE TRIGGER IF NOT EXISTS employer_limit_queue_insert BEFORE INSERT ON jobs WHEN NEW.status IN ('queued','running') AND "+match+" BEGIN SELECT RAISE(ABORT,'Employer application limit: automatic applications are paused for this employer'); END;");
 db.exec("CREATE TRIGGER IF NOT EXISTS employer_limit_queue_update BEFORE UPDATE OF status ON jobs WHEN NEW.status IN ('queued','running') AND OLD.status!=NEW.status AND "+match+" BEGIN SELECT RAISE(ABORT,'Employer application limit: automatic applications are paused for this employer'); END;");
}
export function employerHold(db,job,at=new Date().toISOString()){
 if(!job?.user_id||!job.applicant_id)return null;
 const row=db.prepare('SELECT * FROM employer_limits WHERE user_id=? AND applicant_id=? AND employer_key=?').get(job.user_id,job.applicant_id,employerKey(job));
 if(!row)return null;
 const state=quotaState(db,row,at);
 return state.hold_until===null||state.hold_until>at?state:null;
}
export function employerLimits(db,userId){
 return employerQuotas(db,userId).filter(row=>row.hold_until===null||row.hold_until>new Date().toISOString());
}
export function employerQuotas(db,userId,at=new Date().toISOString()){
 return db.prepare('SELECT * FROM employer_limits WHERE user_id=? ORDER BY observed_at DESC').all(userId).map(row=>quotaState(db,row,at));
}

// Receipt dates are when evidence was recorded, not rejection/interview dates.
// A later manual receipt can conservatively delay review, never create an earlier slot.
function quotaState(db,row,at){
 if(!Object.hasOwn(row,'reached_at')||!row.limit_count||!row.window_days)return row;
 const jobs=db.prepare(`SELECT j.*, (SELECT MIN(e.at) FROM events e WHERE e.job_id=j.id AND e.type IN ('submitted','manual_confirmation')) AS receipt_at,
 (SELECT MIN(e.at) FROM events e WHERE e.job_id=j.id AND e.type IN ('submission_started','applicant_reported_submission')) AS attempt_at
 FROM jobs j WHERE j.user_id=? AND j.applicant_id=?`).all(row.user_id,row.applicant_id);
 const unique=new Map(),windowMs=row.window_days*86400000,now=Date.parse(at);
 for(const job of jobs){
  if(employerKey(job)!==row.employer_key)continue;
  let identity=job.id;
  try{const u=new URL(job.url);identity=u.origin.toLowerCase()+u.pathname.replace(/\/(?:application|apply)\/?$/i,'').replace(/\/$/,'').toLowerCase();}catch{}
  const valid=job.receipt_at&&receipt(job.confirmation||'')&&!/placeholder|example\.com|github\.com|unconfirmed|simulat|test receipt/i.test(job.confirmation||'');
  const previous=unique.get(identity)||{};
  const confirmed=valid?Date.parse(job.receipt_at):NaN;
  const attempt=Date.parse(job.attempt_at||job.local_attempt_at||'');
  if(Number.isFinite(confirmed))previous.confirmed=Math.min(previous.confirmed??Infinity,confirmed);
  // A known quota refusal did not consume another slot.
  if(job.challenge!=='Employer application limit'&&Number.isFinite(attempt))previous.attempt=Math.min(previous.attempt??Infinity,attempt);
  unique.set(identity,previous);
 }
 const receipts=[...unique.values()].filter(j=>Number.isFinite(j.confirmed)).map(j=>j.confirmed).sort((a,b)=>a-b);
 const current=receipts.filter(t=>t>now-windowMs&&t<=now);
 const uncertain=[...unique.values()].filter(j=>!Number.isFinite(j.confirmed)&&j.attempt>now-windowMs&&j.attempt<=now).length;
 const reached=Date.parse(row.reached_at||'');
 const atReport=receipts.filter(t=>t>reached-windowMs&&t<=reached);
 let until='',basis='recorded-receipts';
 if(current.length>=row.limit_count)until=new Date(current[current.length-row.limit_count]+windowMs).toISOString();
 // An explicit refusal is authoritative even when older/off-platform history is missing.
 if(Number.isFinite(reached)&&atReport.length<row.limit_count&&(row.reported_until===null||row.reported_until>at)){
  if(row.reported_until===null||!until||row.reported_until>until){until=row.reported_until;basis='reported-limit';}
 }
 if(until!==row.hold_until)db.prepare('UPDATE employer_limits SET hold_until=? WHERE user_id=? AND applicant_id=? AND employer_key=?').run(until,row.user_id,row.applicant_id,row.employer_key);
 return {...row,hold_until:until,basis,confirmed_in_window:current.length,uncertain_attempts:uncertain,remaining_from_records:until===null||until>at?0:Math.max(0,row.limit_count-current.length),next_review_at:until||null};
}
export function recordEmployerLimit(db,userId,jobId,value,{source='Applicant reported employer limit',at=new Date().toISOString()}={}){
 const job=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(jobId,userId);
 if(!job)throw Error('Application not found');
 const refusal=applicationLimit(value),parsed=refusal||applicationQuota(value),key=employerKey(job);
 if(!parsed||!key)throw Error('Paste the employer message saying your application limit was reached.');
 const existing=db.prepare('SELECT * FROM employer_limits WHERE user_id=? AND applicant_id=? AND employer_key=?').get(userId,job.applicant_id,key);
 // The first report starts a conservative hold; repeated checks never extend it.
 const activeReport=existing?.reached_at&&(existing.reported_until===null||existing.reported_until>at);
 const reached=refusal?(activeReport?existing.reached_at:at):(existing?.reached_at||null);
 const reportedUntil=refusal?(activeReport?existing.reported_until:(parsed.days?new Date(Date.parse(at)+parsed.days*86400000).toISOString():null)):(existing?.reported_until??null);
 const observed=activeReport?existing.observed_at:at;
 const message=refusal?.message||'Employer policy: '+parsed.count+' applications per '+parsed.days+' days. A policy notice alone does not mean the limit was reached.';
 db.exec('BEGIN IMMEDIATE');
 try{
  db.prepare('INSERT INTO employer_limits(user_id,applicant_id,employer_key,company,observed_at,hold_until,limit_count,window_days,message,source,reached_at,reported_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,applicant_id,employer_key) DO UPDATE SET observed_at=excluded.observed_at,hold_until=excluded.hold_until,limit_count=COALESCE(excluded.limit_count,employer_limits.limit_count),window_days=COALESCE(excluded.window_days,employer_limits.window_days),message=excluded.message,source=excluded.source,reached_at=excluded.reached_at,reported_until=excluded.reported_until').run(userId,job.applicant_id,key,job.company,observed,reached?reportedUntil:'',parsed.count,parsed.days,message,source,reached,reportedUntil);
  const hold=employerHold(db,job,at),until=hold?.hold_until;
  const jobs=db.prepare("SELECT * FROM jobs WHERE user_id=? AND applicant_id=? AND status NOT IN ('archived','duplicate','submitted','interview','rejected','offer')").all(userId,job.applicant_id);
  let held=0;
  for(const row of jobs){
   if(!hold||employerKey(row)!==key)continue;
   const message=hold.message+' Other employers can continue.'+(until?' Review after '+until+'; the employer decides when eligibility resets.':' Check with the employer before continuing.');
   if(row.challenge==='Employer application limit')continue;
   db.prepare("UPDATE jobs SET status=CASE WHEN status IN ('saved','queued','paused','needs_review') THEN 'needs_review' ELSE status END,local_phase=CASE WHEN status='local_browser' THEN 'blocked' ELSE local_phase END,challenge='Employer application limit',updated_at=? WHERE id=?").run(at,row.id);
   db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'needs_review',?)").run(row.id,at,message);
   held++;
  }
  db.exec('COMMIT');return {company:job.company,held,holdUntil:until||null,message,policyOnly:!refusal};
 }catch(error){db.exec('ROLLBACK');throw error;}
}
