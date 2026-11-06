import {installAccountPolicy,canEmailAccount} from './account-policy.js';
import {createHash} from 'node:crypto';
import {applicationEvidence,applicationSource} from './operation-evidence.js';

export function installNotifications(db) {
  installAccountPolicy(db);
  db.exec(`CREATE TABLE IF NOT EXISTS notification_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id), enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS submission_emails(job_id TEXT NOT NULL REFERENCES jobs(id), recipient TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, first_attempt INTEGER, next_attempt INTEGER NOT NULL DEFAULT 0, sent_at TEXT, last_error TEXT, PRIMARY KEY(job_id,recipient));
    CREATE TABLE IF NOT EXISTS blocker_emails(key TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, first_attempt INTEGER, next_attempt INTEGER NOT NULL DEFAULT 0, sent_at TEXT, last_error TEXT);`);
  db.exec('CREATE TABLE IF NOT EXISTS submission_email_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id), email TEXT NOT NULL, since TEXT NOT NULL)');
}
// One address the account owner chose to receive a summary of each confirmed
// application. Only applications confirmed after it was set are sent.
export function submissionRecipient(value){
  const email=String(value??'').trim().toLowerCase();
  if(!email)return '';
  if(email.length>254||!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email))throw Error('Enter a valid email address for submission summaries');
  return email;
}
export function emailConfigured(env=process.env) {
  try { return !!(env.RESEND_API_KEY && env.BLOCKER_EMAIL_FROM && new URL(env.PUBLIC_ORIGIN).protocol==='https:'); } catch { return false; }
}
export function blockerReason(job) {
  if (/captcha|verification/i.test(job.challenge||'')) return 'Complete human verification.';
  if (/sign-in|mfa/i.test(job.challenge||'')) return 'Complete employer sign-in or authentication.';
  if (/sensitive/i.test(job.challenge||'')) return 'Review a legal declaration or other sensitive action yourself.';
  if (/submission/i.test(job.challenge||'')) return 'Check the employer receipt before retrying; a submission may already have occurred.';
  return 'Provide missing information or review the application blocker.';
}
export async function sendBlockerEmails(db,{env=process.env,fetchImpl=fetch,time=Date.now()}={}) {
  if (!emailConfigured(env)) return {configured:false,sent:0};
  const jobs=db.prepare(`SELECT j.*,u.email FROM jobs j JOIN users u ON u.id=j.user_id JOIN notification_preferences p ON p.user_id=u.id AND p.enabled=1 WHERE j.status IN ('paused','needs_review') OR (p.enabled=1 AND j.status='local_browser' AND j.local_phase='blocked')`).all();
  const active=new Set();
  for (const job of jobs) {
    if(!canEmailAccount(db,job.user_id))continue;
    const key=createHash('sha256').update(JSON.stringify([job.id,job.challenge,job.required_fields_json,job.local_phase])).digest('hex');active.add(key);
    const url=new URL('/automate.html',env.PUBLIC_ORIGIN);url.hash='job-'+job.id;
    const clean=s=>String(s||'').replace(/[\r\n]/g,' ').slice(0,180);
    const payload={from:env.BLOCKER_EMAIL_FROM,to:[job.email],subject:'ApplyPilot: an application needs your input',text:`${clean(job.title)} — ${clean(job.company)}\n\n${blockerReason(job)}\n\nContinue securely in ApplyPilot:\n${url}\n\nSign in, open the highlighted application, and choose Take over or provide the missing answer. If its browser session expired, choose Prepare live application. Never retry an uncertain submission without checking the receipt.\n\nYou can turn these emails off in your application dashboard.`};
    db.prepare('INSERT OR IGNORE INTO blocker_emails(key,job_id,payload) VALUES(?,?,?)').run(key,job.id,JSON.stringify(payload));
  }
  let sent=0;
  for(const row of db.prepare("SELECT * FROM blocker_emails WHERE state='pending' AND next_attempt<=? ORDER BY next_attempt LIMIT 10").all(time)) {
    if(!active.has(row.key))continue;
    // Provider idempotency expires after 24h. Ambiguous sends then require review.
    if(row.first_attempt && time-row.first_attempt>23*3600000){db.prepare("UPDATE blocker_emails SET state='failed',last_error='Delivery uncertain; review provider logs' WHERE key=?").run(row.key);continue;}
    db.prepare('UPDATE blocker_emails SET attempts=attempts+1,first_attempt=COALESCE(first_attempt,?),next_attempt=? WHERE key=?').run(time,time+300000,row.key);
    try {
      const r=await fetchImpl('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':'applypilot-'+row.key},body:row.payload,signal:AbortSignal.timeout(15000)});
      if(!r.ok)throw Error('Email provider returned '+r.status);
      db.prepare("UPDATE blocker_emails SET state='sent',sent_at=?,last_error=NULL WHERE key=?").run(new Date(time).toISOString(),row.key);sent++;
    }catch(e){db.prepare('UPDATE blocker_emails SET last_error=? WHERE key=?').run('Email delivery failed; retry scheduled',row.key);}
  }
  return {configured:true,sent};
}

const line=(label,value)=>{const v=String(value??'').replace(/[\r\n]+/g,' ').trim();return v?label+': '+v.slice(0,400):'';};
function money(pay){
  return (Array.isArray(pay)?pay:[]).filter(p=>p&&Number(p.min)>0).slice(0,2).map(p=>[p.currency||'currency unknown',Number(p.min).toLocaleString('en-CA'),p.max&&p.max!==p.min?'– '+Number(p.max).toLocaleString('en-CA'):'',p.period?'per '+p.period:'',p.estimated?'(annual equivalent estimated)':''].filter(Boolean).join(' ')).join('; ');
}
// Job facts only: no saved answers, resume, phone, or form contents.
export function submissionEmailText(job,{origin}={}){
  let m={};try{m=JSON.parse(job.job_metadata_json||'{}');}catch{}
  const n=m.native||{},source=applicationSource(job);
  const sourceLabel={direct:'Direct employer application',linkedin:'LinkedIn Easy Apply',indeed:'Indeed Apply'}[source];
  const hiring=(n.hiring?.signals||[]).map(x=>x.evidence).filter(Boolean).join('; ');
  const url=origin?new URL('/automate.html#job-'+job.id,origin).toString():'';
  return [
    'Application submitted and confirmed by the employer.','',
    line('Role',job.title),line('Company',job.company),line('Job link',job.url),
    line('Applied through',sourceLabel),line('Found via',m.foundVia),
    line('Location',m.location||n.location),line('Workplace',m.remote===true||n.eligible?'Remote':''),
    line('Posted pay',money(m.pay||n.pay)||'Not published'),
    line('Eligibility',m.eligibility?.reason),
    line('Hiring signals',hiring),
    line('Applicant profile',[job.applicant_name,job.applicant_email].filter(Boolean).join(', ')),
    line('Submitted at',job.submitted_at),line('Employer confirmation',job.confirmation),
    '',url?'Open in ApplyPilot: '+url:''
  ].filter((x,i,a)=>x||a[i-1]).join('\n').trim();
}
export async function sendSubmissionEmails(db,{env=process.env,fetchImpl=fetch,time=Date.now()}={}){
  if(!emailConfigured(env))return {configured:false,sent:0};
  const jobs=db.prepare(`SELECT j.*,p.email AS recipient,p.since AS recipient_since,a.name AS applicant_name,a.email AS applicant_email,
    (SELECT MIN(e.at) FROM events e WHERE e.job_id=j.id AND e.type IN ('submitted','manual_confirmation')) AS submitted_at,
    EXISTS(SELECT 1 FROM events e WHERE e.job_id=j.id AND e.type IN ('submitted','manual_confirmation')) AS receipt_event,
    EXISTS(SELECT 1 FROM events e WHERE e.job_id=j.id AND e.type='submission_started') AS attempt_event
    FROM jobs j JOIN submission_email_preferences p ON p.user_id=j.user_id
    LEFT JOIN applicants a ON a.id=j.applicant_id
    WHERE j.status IN ('submitted','interview') AND NOT EXISTS(SELECT 1 FROM submission_emails s WHERE s.job_id=j.id AND s.recipient=p.email) AND (SELECT MIN(e.at) FROM events e WHERE e.job_id=j.id AND e.type IN ('submitted','manual_confirmation'))>=p.since`).all();
  for(const job of jobs){
    if(!canEmailAccount(db,job.user_id))continue;
    const evidence=applicationEvidence(job);if(!evidence.confirmed)continue;
    const clean=s=>String(s||'').replace(/[\r\n]/g,' ').slice(0,120);
    const payload={from:env.BLOCKER_EMAIL_FROM,to:[job.recipient],subject:'Applied: '+clean(job.title)+' — '+clean(job.company),text:submissionEmailText(job,{origin:env.PUBLIC_ORIGIN})};
    db.prepare('INSERT OR IGNORE INTO submission_emails(job_id,recipient,payload) VALUES(?,?,?)').run(job.id,job.recipient,JSON.stringify(payload));
  }
  let sent=0;
  for(const row of db.prepare("SELECT * FROM submission_emails WHERE state='pending' AND next_attempt<=? ORDER BY next_attempt LIMIT 10").all(time)){
    if(row.first_attempt&&time-row.first_attempt>23*3600000){db.prepare("UPDATE submission_emails SET state='failed',last_error='Delivery uncertain; review provider logs' WHERE job_id=? AND recipient=?").run(row.job_id,row.recipient);continue;}
    db.prepare('UPDATE submission_emails SET attempts=attempts+1,first_attempt=COALESCE(first_attempt,?),next_attempt=? WHERE job_id=? AND recipient=?').run(time,time+300000,row.job_id,row.recipient);
    const key=createHash('sha256').update(JSON.stringify(['submission',row.job_id,row.recipient])).digest('hex');
    try{
      const r=await fetchImpl('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':'applypilot-submission-'+key},body:row.payload,signal:AbortSignal.timeout(15000)});
      if(!r.ok)throw Error('Email provider returned '+r.status);
      db.prepare("UPDATE submission_emails SET state='sent',sent_at=?,last_error=NULL WHERE job_id=? AND recipient=?").run(new Date(time).toISOString(),row.job_id,row.recipient);sent++;
    }catch{db.prepare('UPDATE submission_emails SET last_error=? WHERE job_id=? AND recipient=?').run('Email delivery failed; retry scheduled',row.job_id,row.recipient);}
  }
  return {configured:true,sent};
}
