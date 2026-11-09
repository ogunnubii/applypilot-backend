import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';

test('answers inbox and connection status over the real local server',{timeout:45000},async()=>{
 // All names, employers and answers below are synthetic fixtures in a temporary database.
 const dir=mkdtempSync(join(tmpdir(),'applypilot-inbox-api-'));
 process.env.DATABASE_PATH=join(dir,'test.sqlite');process.env.SESSION_SECRET=randomUUID()+randomUUID();
 const {db}=await import('../db.js'),{issueToken,hashPassword}=await import('../auth.js');
 const user=randomUUID(),stranger=randomUUID(),profile=randomUUID(),job=randomUUID(),resume=join(dir,'fixture.pdf');
 writeFileSync(resume,'%PDF-1.4\nFIXTURE');
 db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(user,'fixture@example.test',hashPassword(randomUUID()),'2026');
 db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(stranger,'stranger@example.test',hashPassword(randomUUID()),'2026');
 db.prepare("INSERT INTO applicants(id,user_id,name,email,resume_path,answers_json,consent,created_at) VALUES(?,?,'Fixture Person','fixture@example.test',?,'{}',1,'2026')").run(profile,user,resume);
 const url='https://jobs.lever.co/fixtureapi/'+job,questions=['Mailing address','Do you consent to this interview being recorded?'];
 db.prepare("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,local_phase,challenge,required_fields_json,answers_json,created_at,updated_at) VALUES(?,?,?,'Platform Engineer','Fixture API Labs',?,?,'local_browser','blocked','Missing answers',?,'{}','2026','2026')").run(job,user,profile,url,url,JSON.stringify(questions));
 db.prepare('INSERT INTO worker_status VALUES(1,?) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat').run(new Date(Date.now()-600000).toISOString());
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const base='http://127.0.0.1:'+port;let child,log='';
 const api=async(path,{token,method='GET',data,headers={}}={})=>{const response=await fetch(base+path,{method,signal:AbortSignal.timeout(5000),headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json',...headers},body:data===undefined?undefined:JSON.stringify(data)});const text=await response.text();let parsed;try{parsed=JSON.parse(text);}catch{parsed=text;}return {status:response.status,data:parsed,headers:response.headers};};
 const stop=async()=>{if(child?.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}};
 try{
  child=spawn(process.execPath,['server.js'],{cwd:resolve('.'),env:{...process.env,PORT:String(port),BIND_HOST:'127.0.0.1',PUBLIC_ORIGIN:base},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
  let up=false;for(let i=0;i<80&&!up;i++){try{up=(await api('/api/health')).status===200;}catch{}if(!up)await new Promise(r=>setTimeout(r,50));}
  assert(up,log);
  const token=issueToken(user),other=issueToken(stranger);

  const script=await api('/dashboard-panels.js');
  assert.equal(script.status,200);assert.match(script.headers.get('content-type'),/text\/javascript/);assert.match(script.data,/ApplyPilotPanels/);
  const dashboard=await api('/assistant');assert.match(dashboard.data,/src="\/dashboard-panels\.js"/);assert.match(dashboard.headers.get('content-security-policy'),/script-src 'self';/);

  assert.equal((await api('/api/answers-inbox')).status,401,'sign-in required');
  const inbox=await api('/api/answers-inbox',{token});
  assert.equal(inbox.status,200);assert.equal(inbox.data.jobs.length,1);
  assert.deepEqual(inbox.data.jobs[0].questions,[{question:'Mailing address',kind:'answer',reuse:false},{question:questions[1],kind:'employer'}]);
  assert.equal((await api('/api/answers-inbox',{token:other})).data.jobs.length,0,'other accounts see nothing');

  const formKey=inbox.data.jobs[0].formKey,post=(data,t=token)=>api('/api/answers-inbox/answer',{token:t,method:'POST',data});
  assert.equal((await post({jobId:job,question:'Mailing address',answer:'55 Fixture Street',formKey},other)).status,404);
  assert.equal((await post({jobId:job,question:'Mailing address',answer:'55 Fixture Street',remember:true,formKey})).status,400,'an address cannot be remembered');
  assert.equal((await post({jobId:job,question:questions[1],answer:'Yes',formKey})).status,400,'a consent is answered on the employer page');
  assert.equal((await post({jobId:job,question:'Mailing address',answer:'55 Fixture Street',formKey:'stale'})).status,409);
  const saved=await post({jobId:job,question:'Mailing address',answer:'55 Fixture Street',formKey});
  assert.equal(saved.status,200,JSON.stringify(saved.data));
  assert.equal(saved.data.remembered,false);assert.equal(saved.data.resume.state,'employer');
  assert.deepEqual(JSON.parse(db.prepare('SELECT answers_json FROM jobs WHERE id=?').get(job).answers_json),{'Mailing address':'55 Fixture Street'});
  assert.deepEqual(JSON.parse(db.prepare('SELECT answers_json FROM applicants WHERE id=?').get(profile).answers_json),{});
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job).status,'local_browser');
  assert(!db.prepare('SELECT 1 FROM continuation_requests WHERE job_id=?').get(job),'a form with an employer-page question stays parked');
  assert.equal((await post({jobId:job,question:'Mailing address',answer:'overwrite',formKey})).status,409,'a saved answer is never overwritten from a stale list');
  assert.equal((await post({jobId:job,question:'Mailing address',answer:'x',formKey,also:'not a list'})).status,400,'a malformed copy list is refused');

  const status=await api('/api/status',{token});
  assert.equal(status.status,200);assert.equal(status.data.workerOnline,false,'existing field unchanged');
  assert.equal(status.data.connection.ok,false);assert.equal(status.data.connection.worker.state,'offline');assert.equal(status.data.connection.helper.state,'unknown');
  await api('/api/autopilot',{token,headers:{'x-applypilot-device':randomUUID()}});
  assert.equal((await api('/api/status',{token})).data.connection.helper.state,'online','the signed-in helper poll counts as a check-in');
  assert.equal((await api('/api/status',{token:other})).data.connection.helper.state,'unknown','another account\'s helper does not');
 }finally{await stop();db.close();rmSync(dir,{recursive:true,force:true});}
});
