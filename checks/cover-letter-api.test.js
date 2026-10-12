import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';

test('cover-letter API enforces owner/browser, preserves the paused application and deduplication, and requires manual submission',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'applypilot-cover-api-'));process.env.DATABASE_PATH=join(dir,'test.sqlite');process.env.SESSION_SECRET=randomUUID()+randomUUID();
 const {db}=await import('../db.js'),{issueToken}=await import('../auth.js');
 const device=randomUUID(),id=randomUUID(),paused='64b8308e-d40f-4b44-88c2-44a79d66df18',resume=join(dir,'fixture.pdf');writeFileSync(resume,'%PDF-1.4 synthetic resume');
 db.exec("INSERT INTO users VALUES('u','fixture@example.test','fixture','2026'),('other','other@example.test','fixture','2026')");
 db.prepare("INSERT INTO applicants(id,user_id,name,email,resume_path,consent,execution_mode,answers_json,created_at) VALUES('p','u','Fixture Applicant','fixture@example.test',?,1,'local',?,'2026')").run(resume,JSON.stringify({'Professional background':'I supported Linux services and resolved customer incidents.'}));
 for(const [job,status] of [[id,'local_browser'],[paused,'paused']]){const url='https://jobs.lever.co/fixture/'+job;db.prepare("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,local_owner,local_phase,created_at,updated_at) VALUES(?,'u','p','Support Engineer','Example Company',?,?,?,?, 'ready','2026','2026')").run(job,url,url,status,device);}
 db.prepare("UPDATE jobs SET title='Dedicated Support Engineer',company='Paused Fixture Company' WHERE id=?").run(paused);
 const pausedBefore=db.prepare('SELECT * FROM jobs WHERE id=?').get(paused);
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:resolve('.'),env:{...process.env,PORT:String(port),BIND_HOST:'127.0.0.1',PUBLIC_ORIGIN:base},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);const exited=new Promise(r=>child.once('exit',r));
 const api=async(path,method='GET',data,user='u',browser=device)=>{const r=await fetch(base+'/api'+path,{method,signal:AbortSignal.timeout(5000),headers:{Authorization:'Bearer '+issueToken(user),'Content-Type':'application/json','X-ApplyPilot-Device':browser},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,data:await r.json()};};
 const letter={question:'Cover letter',required:true,format:'text'};
 try{
  let ready=false;for(let i=0;i<80;i++){try{if((await api('/health')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert(ready,log);
  assert.equal((await api('/jobs/'+id+'/local/cover-letter','POST',letter,'other')).status,404);
  assert.equal((await api('/jobs/'+id+'/local/cover-letter','POST',letter,'u',randomUUID())).status,409);
  assert.equal((await api('/jobs/'+paused+'/local/cover-letter','POST',letter)).status,409);
  assert.equal((await api('/jobs/'+id+'/local/cover-letter','POST',{...letter,required:false})).data.answer,'');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cover_letters').get().n,0);
  const result=await api('/jobs/'+id+'/local/cover-letter','POST',letter);assert.equal(result.status,200,JSON.stringify(result));assert.match(result.data.answer,/Support Engineer role at Example Company/);
  const file=await api('/jobs/'+id+'/local/cover-letter','POST',{...letter,format:'file',accept:'.docx'});assert.equal(file.data.file.name,'cover-letter.docx');assert.notEqual(file.data.file.base64,Buffer.from('%PDF-1.4 synthetic resume').toString('base64'));
  const preview=await api('/jobs/'+id+'/cover-letter');assert.equal(preview.data.coverLetter.text,result.data.answer);assert.equal(preview.data.coverLetter.stale,false);
  assert.equal((await api('/jobs/'+id+'/cover-letter','GET',undefined,'other')).status,404);
  assert.equal((await api('/jobs/'+id+'/local/packet')).data.autonomousSubmit,false);
  // Even pre-existing explicit automatic authorization cannot submit a letter.
  db.prepare('INSERT INTO work_focus(user_id,enabled,job_id,auto_submit) VALUES(?,1,?,1)').run('u',id);
  const {reserveAutonomousAttempt,focusAllowsSubmit}=await import('../single-application.js');assert.equal(focusAllowsSubmit(db,db.prepare('SELECT * FROM jobs WHERE id=?').get(id)),false);assert.throws(()=>reserveAutonomousAttempt(db,id,'u',device),/not enabled/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM autonomous_attempts').get().n,0);
  db.prepare("UPDATE applicants SET name='Changed Applicant' WHERE id='p'").run();assert.equal((await api('/jobs/'+id+'/cover-letter')).data.coverLetter.stale,true);
  const current=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);assert.equal(current.status,'local_browser');assert.equal(current.local_attempt_at,null);
  assert.deepEqual(db.prepare('SELECT * FROM jobs WHERE id=?').get(paused),pausedBefore);
  assert.throws(()=>db.prepare("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,created_at,updated_at) VALUES(?,'u','p','Duplicate','Example Company',?,?,'2026','2026')").run(randomUUID(),current.url,current.normalized_url),/UNIQUE/);
 }finally{child.kill();await exited;db.close();rmSync(dir,{recursive:true,force:true});}
});
