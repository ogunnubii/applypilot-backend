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
export function applicationLimit(value){
 const text=String(value||'').replace(/[’]/g,"'").replace(/\s+/g,' ').trim();
 if(!/\b(?:you (?:have |have already )?reached your application limit|you(?:'ve| have) reached (?:the |your )?(?:maximum|limit) (?:number )?of applications|application limit (?:has been )?reached)\b/i.test(text))return null;
 const amount=text.match(/limit applications to (?:a total of )?(\d{1,3})\b/i);
 const span=text.match(/(?:over|within|in) (?:the |a )?(?:span|period|course)?(?: of)?\s*(\d{1,3})\s*days?\b/i);
 const count=amount?Number(amount[1]):null,days=span?Number(span[1]):null;
 return {count:count>0?count:null,days:days>0&&days<=365?days:null,
 message:'Employer application limit reached'+(count&&days?': '+count+' applications per '+days+' days.':'.')+' This is not a submission confirmation.'};
}
export function installEmployerLimits(db){
 db.exec('CREATE TABLE IF NOT EXISTS employer_limits(user_id TEXT NOT NULL,applicant_id TEXT NOT NULL,employer_key TEXT NOT NULL,company TEXT NOT NULL,observed_at TEXT NOT NULL,hold_until TEXT,limit_count INTEGER,window_days INTEGER,message TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(user_id,applicant_id,employer_key))');
 db.function('application_employer_key',{deterministic:true},(company,url)=>employerKey({company,url}));
 const match="EXISTS(SELECT 1 FROM employer_limits l WHERE l.user_id=NEW.user_id AND l.applicant_id=NEW.applicant_id AND l.employer_key=application_employer_key(NEW.company,NEW.url) AND (l.hold_until IS NULL OR l.hold_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))";
 db.exec("CREATE TRIGGER IF NOT EXISTS employer_limit_queue_insert BEFORE INSERT ON jobs WHEN NEW.status IN ('queued','running') AND "+match+" BEGIN SELECT RAISE(ABORT,'Employer application limit: automatic applications are paused for this employer'); END;");
 db.exec("CREATE TRIGGER IF NOT EXISTS employer_limit_queue_update BEFORE UPDATE OF status ON jobs WHEN NEW.status IN ('queued','running') AND OLD.status!=NEW.status AND "+match+" BEGIN SELECT RAISE(ABORT,'Employer application limit: automatic applications are paused for this employer'); END;");
}
export function employerHold(db,job,at=new Date().toISOString()){
 if(!job?.user_id||!job.applicant_id)return null;
 return db.prepare('SELECT * FROM employer_limits WHERE user_id=? AND applicant_id=? AND employer_key=? AND (hold_until IS NULL OR hold_until>?)').get(job.user_id,job.applicant_id,employerKey(job),at)||null;
}
export function employerLimits(db,userId){
 return db.prepare('SELECT applicant_id,employer_key,company,observed_at,hold_until,limit_count,window_days,message,source FROM employer_limits WHERE user_id=? AND (hold_until IS NULL OR hold_until>?) ORDER BY observed_at DESC').all(userId,new Date().toISOString());
}
export function recordEmployerLimit(db,userId,jobId,value,{source='Applicant reported employer limit',at=new Date().toISOString()}={}){
 const job=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(jobId,userId);
 if(!job)throw Error('Application not found');
 const parsed=applicationLimit(value),key=employerKey(job);
 if(!parsed||!key)throw Error('Paste the employer message saying your application limit was reached.');
 const existing=employerHold(db,job,at);
 // The first report starts a conservative hold; repeated checks never extend it.
 const until=existing?.hold_until||(parsed.days?new Date(Date.parse(at)+parsed.days*86400000).toISOString():null);
 const observed=existing?.observed_at||at;
 db.exec('BEGIN IMMEDIATE');
 try{
  db.prepare('INSERT INTO employer_limits(user_id,applicant_id,employer_key,company,observed_at,hold_until,limit_count,window_days,message,source) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,applicant_id,employer_key) DO UPDATE SET observed_at=excluded.observed_at,hold_until=excluded.hold_until,limit_count=excluded.limit_count,window_days=excluded.window_days,message=excluded.message,source=excluded.source').run(userId,job.applicant_id,key,job.company,observed,until,parsed.count,parsed.days,parsed.message,source);
  const jobs=db.prepare("SELECT * FROM jobs WHERE user_id=? AND applicant_id=? AND status NOT IN ('archived','duplicate','submitted','interview','rejected','offer')").all(userId,job.applicant_id);
  let held=0;
  for(const row of jobs){
   if(employerKey(row)!==key)continue;
   const message=parsed.message+' Other employers can continue.'+(until?' Conservative hold through '+until.slice(0,10)+'; the employer decides when eligibility resets.':' Check with the employer before continuing.');
   if(row.challenge==='Employer application limit')continue;
   db.prepare("UPDATE jobs SET status=CASE WHEN status IN ('saved','queued','paused','needs_review') THEN 'needs_review' ELSE status END,local_phase=CASE WHEN status='local_browser' THEN 'blocked' ELSE local_phase END,challenge='Employer application limit',updated_at=? WHERE id=?").run(at,row.id);
   db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'needs_review',?)").run(row.id,at,message);
   held++;
  }
  db.exec('COMMIT');return {company:job.company,held,holdUntil:until,message:parsed.message};
 }catch(error){db.exec('ROLLBACK');throw error;}
}
