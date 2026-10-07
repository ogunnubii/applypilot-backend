import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
test('real API autosaves drafts, learns completed factual answers, resumes once and archives without losing outcomes',{timeout:30000},async()=>{
 const root=process.env.APPLYPILOT_TEST_TMP||'data/test-tmp';mkdirSync(root,{recursive:true});process.env.DATABASE_PATH=resolve(join(mkdtempSync(join(root,'batch-api-')),'test.sqlite'));process.env.SESSION_SECRET='isolated-test-secret-never-used-in-production';
 const {db}=await import('../db.js'),{issueToken}=await import('../auth.js');const job=randomUUID(),done=randomUUID();
 db.exec("INSERT INTO users VALUES('u','test@example.test','fixture','2026');INSERT INTO applicants(id,user_id,name,email,resume_path,consent,created_at) VALUES('p','u','Fixture','test@example.test','fixture.pdf',1,'2026')");
 for(const [id,status]of [[job,'local_browser'],[done,'submitted']])db.prepare("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,local_phase,required_fields_json,created_at,updated_at) VALUES(?,'u','p','Support Engineer',? ,?, ?,?,'blocked','[\"Preferred technology\"]','2026','2026')").run(id,id,'https://jobs.lever.co/'+id+'/role','https://jobs.lever.co/'+id+'/role',status);
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:resolve('.'),env:{...process.env,PORT:String(port),BIND_HOST:'127.0.0.1',PUBLIC_ORIGIN:'http://127.0.0.1:'+port,REGISTRATION_CODE:'isolated-test-registration-code-only'},stdio:['ignore','pipe','pipe']});let log='';child.stderr.on('data',x=>log+=x);child.stdout.on('data',x=>log+=x);child.on('error',x=>log+=x.message);const exited=new Promise(r=>child.once('exit',r));
 const api=async(path,method='GET',data)=>{const r=await fetch('http://127.0.0.1:'+port+'/api'+path,{method,signal:AbortSignal.timeout(2000),headers:{Authorization:'Bearer '+issueToken('u'),'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json()};};
 try{
  let ready=false;for(let i=0;i<60;i++){if(child.exitCode!==null)break;try{ready=(await api('/health')).status===200;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,150));}assert(ready,log||'API startup did not complete within the test window');
  const payload={question:'Preferred technology',answer:'Linux',remember:true,autosave:true,resume:false};assert.equal((await api('/jobs/'+job+'/answers','PUT',payload)).status,200);
  assert.equal(JSON.parse(db.prepare("SELECT answers_json FROM applicants WHERE id='p'").get().answers_json)['Preferred technology'],undefined,'typing draft is not reusable yet');assert.equal(db.prepare('SELECT COUNT(*) n FROM continuation_requests').get().n,0);
  assert.equal((await api('/jobs/'+job+'/answers','PUT',{...payload,answer:'Linux and SQL',resume:true})).status,200);
  assert.equal(JSON.parse(db.prepare("SELECT answers_json FROM applicants WHERE id='p'").get().answers_json)['Preferred technology'],'Linux and SQL');assert.equal(db.prepare('SELECT COUNT(*) n FROM answer_history WHERE job_id=?').get(job).n,0,'dashboard answers are not evidence of a populated employer form');assert.equal(db.prepare('SELECT state FROM continuation_requests WHERE job_id=?').get(job).state,'queued');
  const secret=await api('/jobs/'+job+'/answers','PUT',{...payload,question:'Password',answer:'not-a-real-password',resume:true});assert.equal(secret.status,400);
  const {operationSnapshot}=await import('../operation-evidence.js');assert.equal(operationSnapshot(db,'u').totals.worked,0);db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,'2026','filled','Filled 3 standard fields')").run(job);assert.equal(operationSnapshot(db,'u').totals.worked,1);
  const reset=await api('/application-batch','POST',{action:'reset',applicant_id:'p',minimum_cad:120000,degree:'Electrical and Computer Engineering'});assert.equal(reset.status,200,JSON.stringify(reset));assert.equal(reset.data.archived,1);assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(done).status,'submitted');assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job).status,'archived');assert.equal(operationSnapshot(db,'u').totals.worked,1,'queue clearing retains past form counts');assert.equal(JSON.parse(db.prepare('SELECT answers_json FROM jobs WHERE id=?').get(job).answers_json)['Preferred technology'],'Linux and SQL');
  assert.equal((await api('/jobs/'+job+'/answers','PUT',{...payload,resume:true})).status,409,'archived jobs cannot be changed by an old browser');
 }finally{child.kill();await exited;db.close();}
});
