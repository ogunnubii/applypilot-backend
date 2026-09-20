import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';
const dir=mkdtempSync(join(tmpdir(),'applypilot-'));process.env.DATABASE_PATH=join(dir,'test.sqlite');process.env.SESSION_SECRET='test-only-secret-'.repeat(3);process.env.REGISTRATION_CODE='test-registration-'.repeat(2);
const {matches}=await import('./matching.js');const {parseIntent,runSearch}=await import('./discovery.js');const {db,now}=await import('./db.js');const {issueToken}=await import('./auth.js');
test('Role variants and Canadian cities match without accepting US-only remote',()=>{
 const intent=parseIntent('Find DevOps Engineer and Cloud Engineer; remote; Canada');
 for(const title of ['Senior SRE','Platform Engineer','Site Reliability Engineer II','DevOps Specialist'])assert(matches({title,location:'Toronto',remote:true},intent));
 assert(!matches({title:'DevOps Engineer',location:'United States',remote:true},intent));
 assert(!matches({title:'Senior Software Engineer Ruby Security Platform Authorization',location:'Canada',remote:true},intent));
 assert(!matches({title:'Sales Engineer',location:'Canada',remote:true},intent));
 assert(!matches({title:'DevOps Engineer',location:'London',remote:false},intent));
 assert(matches({title:'Cloud Engineer',location:'Worldwide',remote:true},intent));
 assert(!matches({title:'Nursing Director',location:'Canada'},parseIntent('Nurse; Canada')));
});
test('Discovery queues only eligible direct matches and deduplicates repeated runs',async()=>{
 db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('u','test@example.com','unused',now());
 db.prepare('INSERT INTO applicants(id,user_id,name,email,resume_path,consent,created_at) VALUES(?,?,?,?,?,?,?)').run('a','u','Tester','test@example.com','/fake.pdf',1,now());
 db.prepare('INSERT INTO searches(id,user_id,applicant_id,instruction,boards_json,auto_queue,created_at) VALUES(?,?,?,?,?,?,?)').run('s','u','a','DevOps Engineer; Canada','["https://jobs.lever.co/example"]',1,now());
 const original=global.fetch;global.fetch=async url=>({ok:true,headers:new Headers(),text:async()=>JSON.stringify(String(url).includes('api.lever.co')?[{text:'Site Reliability Engineer',categories:{location:'Toronto'},applyUrl:'https://jobs.lever.co/example/abc/apply'}]:String(url).includes('jobicy')?{jobs:[]}:{data:[]})});
 try{const first=await runSearch('s','u');assert.equal(first.queued,1);assert.equal((await runSearch('s','u')).added,0);db.prepare("UPDATE jobs SET status='saved' WHERE applicant_id='a'").run();assert.equal((await runSearch('s','u')).queued,1);assert.equal(JSON.parse(db.prepare("SELECT last_result_json FROM searches WHERE id='s'").get().last_result_json).queued,1);}finally{global.fetch=original}
});
test('HTTP: ownership, companion UI, heartbeat and uncertain submission guard',async()=>{
 const duplicateId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
 db.prepare("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'saved',?,?)").run(duplicateId,'u','a','SRE','Example','https://jobs.lever.co/example/abc/apply','https://jobs.lever.co/example/abc/apply',now(),now());
 const port=19000+Math.floor(Math.random()*1000),base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:new URL('.',import.meta.url),env:{...process.env,PORT:String(port),PUBLIC_ORIGIN:'https://applypilot-jobs.netlify.app',SERVICE_ORIGIN:base},stdio:'pipe'});
 let logs='';child.stderr.on('data',d=>logs+=d);try{
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50));}assert(ready,logs);
  assert.equal((await fetch(base+'/assistant')).status,200);assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(duplicateId).status,'duplicate');assert(db.prepare('SELECT COUNT(*) AS n FROM events WHERE job_id=?').get(duplicateId).n>0);
  assert.equal((await fetch(base+'/api/status')).status,401);
  const headers={Authorization:'Bearer '+issueToken('u'),Origin:base,'Content-Type':'application/json'};
  assert.equal((await (await fetch(base+'/api/status',{headers})).json()).workerOnline,false);
  const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  db.prepare("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,challenge,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'needs_review','Unconfirmed submission',?,?)").run(id,'u','a','SRE','Example','https://jobs.lever.co/example/def','https://jobs.lever.co/example/def',now(),now());
  assert.equal((await fetch(base+'/api/jobs/'+id+'/queue',{method:'POST',headers,body:'{}'})).status,409);
  const save=await fetch(base+'/api/jobs/'+id+'/answers',{method:'PUT',headers,body:JSON.stringify({question:'Why this role?',answer:'I enjoy infrastructure operations.'})});assert.equal(save.status,200);
  assert.equal((await (await fetch(base+'/api/jobs/'+id+'/answers',{headers})).json()).answers['Why this role?'],'I enjoy infrastructure operations.');
  assert.equal((await fetch(base+'/api/jobs/'+id+'/answers',{method:'PUT',headers:{...headers,Authorization:'Bearer '+issueToken('other')},body:'{}'})).status,404);
  db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(id);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/confirm',{method:'POST',headers,body:JSON.stringify({receipt:'Employer confirmation 1234'})})).status,409);
  db.prepare("UPDATE jobs SET status='needs_review' WHERE id=?").run(id);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/confirm',{method:'POST',headers,body:JSON.stringify({receipt:'Employer confirmation 1234'})})).status,200);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(id).status,'submitted');

  assert.equal((await fetch(base+'/api/jobs/'+id+'/queue',{method:'POST',headers:{...headers,Authorization:'Bearer '+issueToken('other')},body:'{}'})).status,404);
  assert.equal((await fetch(base+'/api/chat',{method:'POST',headers,body:JSON.stringify({applicant_id:'a',message:'Help'})})).status,400);
 }finally{if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}}
});
test.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});

test('Canonical URLs collapse Lever apply aliases; upload selection rejects ambiguity',async()=>{
 const {canonicalJobURL,pickResumeField}=await import('./form-policy.js');
 assert.equal(canonicalJobURL('https://jobs.lever.co/newton/abc/apply?source=feed'),canonicalJobURL('https://jobs.lever.co/newton/abc'));
 assert.notEqual(canonicalJobURL('https://jobs.lever.co/newton/abc'),canonicalJobURL('https://jobs.lever.co/newton/def'));
 assert.equal(pickResumeField([{id:'resume'},{id:'cover letter'}]),0);
 assert.equal(pickResumeField([{label:'Resume'},{label:'Alternative resume'}]),-1);
 assert.equal(pickResumeField([{label:'Cover letter'}]),-1);
 assert.equal(pickResumeField([{name:'resume upload'},{name:'portfolio'}]),0);
});

test('Radio choices require an exact approved question and unambiguous option',async()=>{
 const {approvedRadioIndex}=await import('./form-policy.js');
 const options=[{question:'Work authorized? *',label:'Yes'},{question:'Work authorized? *',label:'No'}];
 assert.equal(approvedRadioIndex(options,{'Work authorized?':'Yes'}),0);
 assert.equal(approvedRadioIndex(options,{'Different question':'Yes'}),-1);
 assert.equal(approvedRadioIndex([...options,options[0]],{'Work authorized?':'Yes'}),-1);
 assert.equal(approvedRadioIndex(options,{}),-1);
});
