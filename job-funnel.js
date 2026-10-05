import {randomUUID} from 'node:crypto';
import {parseFunnelLinks,safeFunnelURL,readPublicJob,jobFromHTML,applicationLinks} from './funnel-links.js';
import {parseIntent,directDiscoveryLink,detailForJob} from './discovery.js';
import {WORLDWIDE_TECH_INSTRUCTION} from './tech-search.js';
import {jobIntelligence} from './job-intelligence.js';
import {priorApplication} from './application-dedup.js';
import {companyKey,historyKey} from './application-history.js';
import {queueFoundApplications,setPipeline} from './application-pipeline.js';
import {supported} from './local-policy.js';
import {excludesFrench,frenchApplication} from './language-policy.js';

export function installFunnel(db){db.exec(`CREATE TABLE IF NOT EXISTS funnel_batches(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,applicant_id TEXT NOT NULL,created_at TEXT NOT NULL,last_processed_at TEXT,received INTEGER NOT NULL,repeated INTEGER NOT NULL,rejected INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS funnel_items(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES funnel_batches(id),user_id TEXT NOT NULL,applicant_id TEXT NOT NULL,url TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',job_id TEXT,title TEXT,company TEXT,message TEXT NOT NULL DEFAULT '',attempts INTEGER NOT NULL DEFAULT 0,lease_at TEXT,next_attempt_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(user_id,applicant_id,url));
CREATE INDEX IF NOT EXISTS funnel_due ON funnel_items(status,next_attempt_at,created_at);
CREATE INDEX IF NOT EXISTS funnel_owner ON funnel_items(user_id,updated_at);`);}
export function createFunnelBatch(db,userId,{applicant_id,links}){
 const profile=db.prepare('SELECT id FROM applicants WHERE id=? AND user_id=?').get(applicant_id,userId);if(!profile)throw Error('Choose your saved applicant profile.');
 const parsed=parseFunnelLinks(links);if(!parsed.links.length)throw Error(parsed.rejected[0]?.reason||'No public job links found.');
 const id=randomUUID(),now=new Date().toISOString();let added=0,repeated=parsed.repeated;
 db.exec('BEGIN IMMEDIATE');try{
  db.prepare('INSERT INTO funnel_batches(id,user_id,applicant_id,created_at,received,repeated,rejected) VALUES(?,?,?,?,?,?,?)').run(id,userId,profile.id,now,parsed.links.length,0,parsed.rejected.length);
  for(const url of parsed.links){const result=db.prepare('INSERT OR IGNORE INTO funnel_items(id,batch_id,user_id,applicant_id,url,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,userId,profile.id,url,now,now);if(result.changes)added++;else repeated++;}
  db.prepare('UPDATE funnel_batches SET received=?,repeated=? WHERE id=?').run(added,repeated,id);db.exec('COMMIT');return {id,added,repeated,rejected:parsed.rejected.length,reasons:[...new Set(parsed.rejected.map(r=>r.reason))]};
 }catch(error){db.exec('ROLLBACK');throw error;}
}
export function funnelStatus(db,userId){
 const totals={pending:0,checking:0,queued:0,review:0,duplicate:0,excluded:0,closed:0};for(const r of db.prepare('SELECT status,COUNT(*) AS n FROM funnel_items WHERE user_id=? GROUP BY status').all(userId))totals[r.status]=r.n;
 const batches=db.prepare('SELECT * FROM funnel_batches WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(userId).map(b=>({...b,counts:db.prepare('SELECT status,COUNT(*) AS count FROM funnel_items WHERE batch_id=? GROUP BY status').all(b.id)}));
 const items=db.prepare('SELECT f.id,f.batch_id,f.url,f.status,f.title,f.company,f.message,f.job_id,f.attempts,f.updated_at,j.status AS application_status FROM funnel_items f LEFT JOIN jobs j ON j.id=f.job_id WHERE f.user_id=? ORDER BY CASE f.status WHEN \'checking\' THEN 0 WHEN \'pending\' THEN 1 WHEN \'review\' THEN 2 ELSE 3 END,f.updated_at DESC LIMIT 100').all(userId);
 return {totals,batches,items,batchSize:5,intervalSeconds:30,checkedAt:new Date().toISOString()};
}
export function retryFunnelItem(db,userId,id){
 const changed=db.prepare("UPDATE funnel_items SET status='pending',attempts=0,next_attempt_at=NULL,message='Waiting for another check',updated_at=? WHERE id=? AND user_id=? AND status IN ('review','closed') AND job_id IS NULL").run(new Date().toISOString(),id,userId);
 if(!changed.changes)throw Error('This link is already processing or has an application record.');return {ok:true};
}
export function enableWorldwideDiscovery(db,userId,applicantId){
 const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(applicantId,userId);if(!p)throw Error('Choose your applicant profile.');
 const existing=db.prepare('SELECT id FROM searches WHERE user_id=? AND applicant_id=? AND instruction=?').get(userId,p.id,WORLDWIDE_TECH_INSTRUCTION),id=existing?.id||randomUUID();
 // Replacing searches for this profile is explicit, account-scoped and preserves history.
 db.exec('BEGIN IMMEDIATE');try{
  db.prepare('UPDATE searches SET enabled=0 WHERE user_id=? AND applicant_id=?').run(userId,p.id);
  if(existing)db.prepare('UPDATE searches SET enabled=1,auto_queue=1,last_run=NULL WHERE id=?').run(id);
  else db.prepare("INSERT INTO searches(id,user_id,applicant_id,instruction,boards_json,auto_queue,created_at) VALUES(?,?,?,?,'[]',1,?)").run(id,userId,p.id,WORLDWIDE_TECH_INSTRUCTION,new Date().toISOString());
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
 setPipeline(db,userId,true);return {id,instruction:WORLDWIDE_TECH_INSTRUCTION};
}
export async function resolveFunnelPosting(input,{details=detailForJob,read=readPublicJob}={}){
 let url=safeFunnelURL(input);
 for(let n=0;n<2;n++){
  if(directDiscoveryLink(url))return await details({url,company:decodeURIComponent(new URL(url).pathname.split('/')[1])})||{closed:true};
  const page=await read(url);url=page.url||url;
  if(directDiscoveryLink(url))continue;
  const job=jobFromHTML(page.html,url);
  if(job?.closed)return job;
  if(job&&supported(url))return job;
  const links=applicationLinks(page.html,url).filter(link=>link!==url);
  if(links.length===1){url=links[0];continue;}
  return {review:true,message:links.length>1?'This page has multiple applications. Paste the specific job links.':'Could not verify a supported application on this page. Paste the direct employer form link.'};
 }
 return {review:true,message:'The direct application could not be verified. Use its exact employer form link.'};
}
export async function processFunnel(db,{resolve=resolveFunnelPosting,limit=5,clock=()=>new Date().toISOString()}={}){
 const now=clock(),expired=new Date(Date.parse(now)-300000).toISOString();
 db.prepare("UPDATE funnel_items SET status='pending',lease_at=NULL WHERE status='checking' AND lease_at<?").run(expired);
 const due=db.prepare("SELECT f.* FROM funnel_items f JOIN funnel_batches b ON b.id=f.batch_id WHERE f.status='pending' AND (f.next_attempt_at IS NULL OR f.next_attempt_at<=?) ORDER BY COALESCE(b.last_processed_at,b.created_at),f.created_at,f.id LIMIT ?").all(now,limit);
 const results=[];
 for(const item of due){
  if(!db.prepare("UPDATE funnel_items SET status='checking',lease_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='pending'").run(clock(),clock(),item.id).changes)continue;
  const finish=(status,message,job=null)=>{db.prepare('UPDATE funnel_items SET status=?,message=?,job_id=COALESCE(?,job_id),title=COALESCE(?,title),company=COALESCE(?,company),lease_at=NULL,updated_at=? WHERE id=?').run(status,message.slice(0,500),job?.id||null,job?.title||null,job?.company||null,clock(),item.id);results.push({id:item.id,status});};
  try{
   const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(item.applicant_id,item.user_id);if(!p){finish('review','Applicant profile is no longer available.');continue;}
   const existing=db.prepare('SELECT id,title,company,status FROM jobs WHERE user_id=? AND applicant_id=? AND normalized_url=?').get(item.user_id,p.id,item.url);if(existing){finish('duplicate','Application already tracked; kept the existing record.',existing);continue;}
   const job=await resolve(item.url);
   if(!job||job.closed){finish('closed','The employer no longer lists this role.');continue;}
   if(job.review){finish('review',job.message);continue;}
   if(!supported(job.url)||!job.title||!job.company){finish('review','The employer form or job identity could not be verified.');continue;}
   if(excludesFrench(db,item.user_id)&&frenchApplication(job)){finish('excluded','French-language application excluded.');continue;}
   const prior=priorApplication(db,item.user_id,job)||db.prepare('SELECT id,company,title FROM external_application_history WHERE user_id=? AND company_key=? AND title_key=?').get(item.user_id,companyKey(job.company),historyKey(job.title));
   if(prior){const native=db.prepare('SELECT id,title,company FROM jobs WHERE id=? AND user_id=?').get(prior.id,item.user_id);finish('duplicate','Matched previous application history. No repeat application created.',native);continue;}
   const metadata=jobIntelligence(job,parseIntent(WORLDWIDE_TECH_INSTRUCTION),p.focus);
   if(!metadata.matched){finish('excluded','Role is outside the requested technology and IT categories.');continue;}
   if(!metadata.eligibility.eligible){finish('review',metadata.eligibility.reason);continue;}
   const url=safeFunnelURL(job.url),id=randomUUID(),at=clock();
   const result=db.prepare("INSERT OR IGNORE INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,notes,created_at,updated_at,job_metadata_json,match_score,discovery_priority,metadata_attempt_at) VALUES(?,?,?,?,?,?,?,'saved',?,?,?,?,?,?,?)").run(id,item.user_id,p.id,String(job.title).slice(0,200),String(job.company).slice(0,200),url,url,'Added through bulk-link funnel',at,at,JSON.stringify(metadata),metadata.score,100-metadata.score,at);
   if(!result.changes){const previous=db.prepare('SELECT id,title,company FROM jobs WHERE applicant_id=? AND normalized_url=?').get(p.id,url);finish('duplicate','Employer application already tracked.',previous);continue;}
   db.prepare('INSERT INTO events(job_id,at,type,message) VALUES(?,?,?,?)').run(id,at,'saved','Verified job added from bulk-link funnel.');
   queueFoundApplications(db,item.user_id,{applicantId:p.id});
   const saved=db.prepare('SELECT id,title,company,status,challenge FROM jobs WHERE id=?').get(id);
   finish(saved.status==='queued'?'queued':saved.status==='duplicate'?'duplicate':'review',saved.status==='queued'?'Queued for preparation. Final Submit stays with you.':saved.challenge||'Preparation needs a profile detail or employer review.',saved);
  }catch(error){
   if([404,410].includes(error.status))finish('closed','The employer posting is no longer available.');
   else if(item.attempts<2&&(error.status===429||error.status>=500||/timed out|timeout|fetch failed|ECONN|ENOTFOUND|cooling down/i.test(error.message))){db.prepare("UPDATE funnel_items SET status='pending',message=?,next_attempt_at=?,lease_at=NULL,updated_at=? WHERE id=?").run('Temporary source error; retry scheduled.',new Date(Date.parse(clock())+60000*(item.attempts+1)).toISOString(),clock(),item.id);}
   else finish('review',error.message||'This employer link needs review.');
  }finally{db.prepare('UPDATE funnel_batches SET last_processed_at=? WHERE id=?').run(clock(),item.batch_id);}
 }
 return results;
}
