import {createHash} from 'node:crypto';

export function installNotifications(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS notification_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id), enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS blocker_emails(key TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, first_attempt INTEGER, next_attempt INTEGER NOT NULL DEFAULT 0, sent_at TEXT, last_error TEXT);`);
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
