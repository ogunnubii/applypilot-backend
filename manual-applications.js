import {randomUUID} from 'node:crypto';
import {batchPreferences} from './application-batches.js';
import {safeFunnelURL} from './funnel-links.js';
import {priorApplication} from './application-dedup.js';
import {companyKey,historyKey} from './application-history.js';

// An explicit saved lead becomes visible for manual review without granting
// salary eligibility or submission evidence. Known employer forms can be prepared
// by the browser helper, with final submission left to the applicant.
export function loadManualApplication(db,userId,itemId,input={}){
 const value=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
 const title=value(input.title,200),company=value(input.company,200),notes=value(input.notes,2000);
 if(!title||!company)throw Error('Enter the job title and company.');
 const at=new Date().toISOString();db.exec('BEGIN IMMEDIATE');
 try{
  const item=db.prepare('SELECT * FROM funnel_items WHERE id=? AND user_id=?').get(itemId,userId);
  if(!item)throw Error('Saved job link not found.');
  if(item.job_id){db.exec('COMMIT');return {id:item.job_id,existing:true};}
  if(item.status!=='review')throw Error('Wait until the job link check finishes. Closed or excluded postings cannot be added here.');
  const profile=db.prepare('SELECT id FROM applicants WHERE id=? AND user_id=?').get(item.applicant_id,userId);
  if(!profile)throw Error('Applicant profile is unavailable.');
  const url=safeFunnelURL(item.url),candidate={title,company,url};
  const existing=db.prepare('SELECT id FROM jobs WHERE user_id=? AND applicant_id=? AND normalized_url=?').get(userId,profile.id,url)||priorApplication(db,userId,candidate);
  const imported=db.prepare('SELECT id FROM external_application_history WHERE user_id=? AND company_key=? AND title_key=?').get(userId,companyKey(company),historyKey(title));
  if(existing||imported){db.prepare("UPDATE funnel_items SET status='duplicate',job_id=?,title=?,company=?,message='Previously tracked application retained; no duplicate created.',updated_at=? WHERE id=?").run(existing?.id||null,title,company,at,item.id);db.exec('COMMIT');return {id:existing?.id||null,duplicate:true};}
  const batch=batchPreferences(db,userId);
  if(batch&&batch.applicant_id!==profile.id)throw Error('Choose the profile used by your current batch.');
  const size=batch?db.prepare('SELECT COUNT(*) AS n FROM application_batch_members WHERE batch_id=?').get(batch.current_batch).n:0;
  if(batch&&size>=20)throw Error('Your current batch already has 20 jobs. Finish it before adding another.');
  const id=randomUUID(),message='Manual review: check pay and eligibility before applying. The browser helper can fill supported forms; email-only postings and unsupported forms need your input. Final Submit stays with you.';
  const metadata={version:2,manualReview:true,pay:[],eligibility:{eligible:false,reason:'Pay, qualifications and work arrangement require review'},sourceUrl:url};
  db.prepare("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,notes,challenge,created_at,updated_at,job_metadata_json) VALUES(?,?,?,?,?,?,?,'needs_review',?,'Manual application',?,?,?)").run(id,userId,profile.id,title,company,url,url,notes,at,at,JSON.stringify(metadata));
  if(batch)db.prepare('INSERT INTO application_batch_members VALUES(?,?,?,?)').run(batch.current_batch,id,userId,size+1);
  db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'needs_review',?)").run(id,at,message);
  db.prepare("UPDATE funnel_items SET job_id=?,title=?,company=?,message='Loaded on Applications for manual review. Not queued or submitted.',updated_at=? WHERE id=?").run(id,title,company,at,item.id);
  db.exec('COMMIT');return {id,status:'needs_review'};
 }catch(error){db.exec('ROLLBACK');throw error;}
}
