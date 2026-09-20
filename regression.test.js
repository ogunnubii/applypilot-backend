import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';
const dir=mkdtempSync(join(tmpdir(),'applypilot-'));process.env.DATABASE_PATH=join(dir,'test.sqlite');process.env.SESSION_SECRET='test-only-secret-'.repeat(3);process.env.REGISTRATION_CODE='test-registration-'.repeat(2);
const {matches}=await import('./matching.js');const {parseIntent,runSearch}=await import('./discovery.js');const {db,now}=await import('./db.js');const {issueToken}=await import('./auth.js');
test('Role variants and Canadian cities match without accepting US-only remote',()=>{
 const intent=parseIntent('Find DevOps Engineer and Cloud Engineer; remote; Canada');
 for(const title of ['Senior SRE','Platform Engineer','Site Reliability Engineer II','DevOps Specialist'])assert(matches({title,location:'Toronto',remote:true},intent));
 assert(!matches({title:'DevOps Engineer',location:'United States',remote:true},intent));
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
 try{const first=await runSearch('s','u');assert.equal(first.queued,1);assert.equal((await runSearch('s','u')).added,0);}finally{global.fetch=original}
});
test('HTTP: ownership, companion UI, heartbeat and uncertain submission guard',async()=>{
 const port=19000+Math.floor(Math.random()*1000),base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:new URL('.',import.meta.url),env:{...process.env,PORT:String(port),PUBLIC_ORIGIN:'https://applypilot-jobs.netlify.app',SERVICE_ORIGIN:base},stdio:'pipe'});
 let logs='';child.stderr.on('data',d=>logs+=d);try{
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50));}assert(ready,logs);
  assert.equal((await fetch(base+'/assistant')).status,200);
  assert.equal((await fetch(base+'/api/status')).status,401);
  const headers={Authorization:'Bearer '+issueToken('u'),Origin:base,'Content-Type':'application/json'};
  assert.equal((await (await fetch(base+'/api/status',{headers})).json()).workerOnline,false);
  const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  db.prepare("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,challenge,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'needs_review','Unconfirmed submission',?,?)").run(id,'u','a','SRE','Example','https://jobs.lever.co/example/def','https://jobs.lever.co/example/def',now(),now());
  assert.equal((await fetch(base+'/api/jobs/'+id+'/queue',{method:'POST',headers,body:'{}'})).status,409);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/queue',{method:'POST',headers:{...headers,Authorization:'Bearer '+issueToken('other')},body:'{}'})).status,404);
  assert.equal((await fetch(base+'/api/chat',{method:'POST',headers,body:JSON.stringify({applicant_id:'a',message:'Help'})})).status,400);
 }finally{child.kill();await new Promise(r=>child.once('exit',r));}
});
test.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
