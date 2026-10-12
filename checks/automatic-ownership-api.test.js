import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';

test('local claim distinguishes hosted members from outsiders without changing applications or receipt evidence',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'applypilot-ownership-'));process.env.DATABASE_PATH=join(dir,'test.sqlite');process.env.SESSION_SECRET=randomUUID()+randomUUID();
 const {db}=await import('../db.js'),{issueToken}=await import('../auth.js');
 const member=randomUUID(),outside=randomUUID(),unknown=randomUUID(),paused='64b8308e-d40f-4b44-88c2-44a79d66df18',device=randomUUID();
 db.exec("INSERT INTO users VALUES('u','fixture@example.test','fixture','2026'),('other','other@example.test','fixture','2026');INSERT INTO applicants(id,user_id,name,email,consent,execution_mode,created_at) VALUES('p','u','Fixture Applicant','fixture@example.test',1,'cloud','2026')");
 for(const id of [member,outside,unknown,paused]){const url='https://jobs.lever.co/fixture-'+id;db.prepare("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,challenge,job_metadata_json,created_at,updated_at) VALUES(?,'u','p',?,?,?,?, 'paused','Manual review',?,'2026','2026')").run(id,id===paused?'Dedicated Support Engineer':'Senior DevOps Engineer',id===member?'Chromatic':id===paused?'OpenAI':'Synthetic '+id,url,url,JSON.stringify({manualReview:true}));}
 db.prepare("UPDATE jobs SET local_attempt_at='2026',local_phase='uncertain',challenge='Unconfirmed submission' WHERE id=?").run(unknown);
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:resolve('.'),env:{...process.env,PORT:String(port),BIND_HOST:'127.0.0.1',PUBLIC_ORIGIN:base},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);const exited=new Promise(r=>child.once('exit',r));
 const api=async(path,method='GET',user='u')=>{const r=await fetch(base+'/api'+path,{method,signal:AbortSignal.timeout(5000),headers:{Authorization:'Bearer '+issueToken(user),'Content-Type':'application/json','X-ApplyPilot-Device':device},body:method==='POST'?'{}':undefined});return {status:r.status,data:await r.json()};};
 const records=()=>({jobs:db.prepare('SELECT * FROM jobs ORDER BY id').all(),events:db.prepare('SELECT * FROM events ORDER BY id').all(),attempts:db.prepare('SELECT * FROM autonomous_attempts').all(),campaigns:db.prepare('SELECT * FROM automatic_campaigns').all(),members:db.prepare('SELECT * FROM automatic_members ORDER BY job_id').all()});
 try{
  let ready=false;for(let i=0;i<80;i++){try{if((await api('/health')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert(ready,log);
  db.exec("INSERT INTO automatic_campaigns VALUES('u','campaign','p',1,20,2,'2026')");
  // A historical settled member still owns its execution source; it need not
  // be the selected/current job to produce the hosted-worker error.
  db.prepare("INSERT INTO automatic_members VALUES(?,'u','campaign',1,1,'DevOps Engineer','blocked','Manual review','2026','2026')").run(member);
  db.prepare("INSERT INTO autonomous_attempts VALUES(?,'hosted-worker','2026')").run(unknown);
  const before=records();
  assert.deepEqual(await api('/jobs/'+member+'/local/claim','POST'),{status:409,data:{error:'This automatic campaign application belongs to the hosted worker.'}});
  for(const id of [outside,unknown,paused])assert.deepEqual(await api('/jobs/'+id+'/local/claim','POST'),{status:409,data:{error:'This job is outside the current automatic batch.'}});
  assert.equal((await api('/jobs/'+member+'/local/claim','POST','other')).status,404);
  assert.deepEqual(records(),before,'rejected claims preserve all jobs, the paused OpenAI record, unknown attempts, receipts and campaign state');
  db.exec("UPDATE automatic_campaigns SET enabled=0 WHERE user_id='u'");
  const listed=await api('/jobs');assert.equal(listed.status,200);
  const listedJobs=[...listed.data.jobs,...listed.data.deferred];
  assert(listedJobs.some(j=>j.id===member),JSON.stringify(listed.data));
  assert.equal(listedJobs.find(j=>j.id===member).automatic_member,true);
  assert.equal(listedJobs.find(j=>j.id===outside).automatic_member,false);
  const foreign=await api('/jobs','GET','other');assert.deepEqual(foreign.data.jobs,[]);
  assert.equal((await api('/jobs/'+member+'/local/claim','POST')).data.error,'This automatic campaign application belongs to the hosted worker.');
  assert.equal((await api('/jobs/'+outside+'/local/claim','POST')).data.error,'Automatic campaign is stopped.');
  assert.deepEqual(db.prepare('SELECT * FROM jobs ORDER BY id').all(),before.jobs);
  assert.deepEqual(db.prepare('SELECT * FROM autonomous_attempts').all(),before.attempts);
 }finally{child.kill();await exited;db.close();rmSync(dir,{recursive:true,force:true});}
});
