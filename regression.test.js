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
  assert.equal((await fetch(base+'/assistant')).status,200);assert.equal((await fetch(base+'/setup')).status,200);assert.equal((await fetch(base+'/setup.js')).status,200);assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(duplicateId).status,'duplicate');assert(db.prepare('SELECT COUNT(*) AS n FROM events WHERE job_id=?').get(duplicateId).n>0);
  assert.equal((await fetch(base+'/api/status')).status,401);
  const headers={Authorization:'Bearer '+issueToken('u'),Origin:base,'Content-Type':'application/json','X-ApplyPilot-Device':'11111111-1111-1111-1111-111111111111'};
  assert.equal((await (await fetch(base+'/api/status',{headers})).json()).workerOnline,false);
  const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  db.prepare("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,challenge,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'needs_review','Unconfirmed submission',?,?)").run(id,'u','a','SRE','Example','https://jobs.lever.co/example/def','https://jobs.lever.co/example/def',now(),now());
  assert.equal((await fetch(base+'/api/jobs/'+id+'/queue',{method:'POST',headers,body:'{}'})).status,409);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/handoff/open',{method:'POST',headers,body:'{}'})).status,409);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/handoff/view',{method:'POST',headers:{...headers,Authorization:'Bearer '+issueToken('other')},body:'{}'})).status,404);
  const save=await fetch(base+'/api/jobs/'+id+'/answers',{method:'PUT',headers,body:JSON.stringify({question:'Why this role?',answer:'I enjoy infrastructure operations.',remember:true})});assert.equal(save.status,200);assert.equal(JSON.parse(db.prepare('SELECT answers_json FROM applicants WHERE id=?').get('a').answers_json)['Why this role?'],'I enjoy infrastructure operations.');
  assert.equal((await (await fetch(base+'/api/jobs/'+id+'/answers',{headers})).json()).answers['Why this role?'],'I enjoy infrastructure operations.');
  assert.equal((await fetch(base+'/api/jobs/'+id+'/answers',{method:'PUT',headers:{...headers,Authorization:'Bearer '+issueToken('other')},body:'{}'})).status,404);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/continue',{method:'POST',headers,body:JSON.stringify({answers:{Question:'Answer'}})})).status,409);
  db.prepare("UPDATE jobs SET status='needs_review',challenge='Missing answers' WHERE id=?").run(id);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/continue',{method:'POST',headers:{...headers,Authorization:'Bearer '+issueToken('other')},body:JSON.stringify({answers:{Question:'Answer'}})})).status,404);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/continue',{method:'POST',headers,body:JSON.stringify({answers:{Question:'Answer'}})})).status,200);
  const continued=db.prepare('SELECT status,answers_json FROM jobs WHERE id=?').get(id);assert.equal(continued.status,'queued');assert.equal(JSON.parse(continued.answers_json).Question,'Answer');
  assert.equal((await fetch(base+'/api/jobs/'+id+'/continue',{method:'POST',headers,body:JSON.stringify({answers:{Question:'Changed'}})})).status,409);
  db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(id);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/confirm',{method:'POST',headers,body:JSON.stringify({receipt:'Employer confirmation 1234'})})).status,409);
  db.prepare("UPDATE jobs SET status='needs_review' WHERE id=?").run(id);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/confirm',{method:'POST',headers,body:JSON.stringify({receipt:'Employer confirmation 1234'})})).status,200);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(id).status,'submitted');

  assert.equal((await fetch(base+'/api/jobs/'+id+'/queue',{method:'POST',headers:{...headers,Authorization:'Bearer '+issueToken('other')},body:'{}'})).status,404);
  db.prepare("UPDATE jobs SET status='needs_review',challenge='Missing answers' WHERE id=?").run(id);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/local/claim',{method:'POST',headers:{...headers,Authorization:'Bearer '+issueToken('other')},body:'{}'})).status,404);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/local/claim',{method:'POST',headers,body:'{}'})).status,200);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(id).status,'local_browser');
  assert.equal((await fetch(base+'/api/jobs/'+id+'/queue',{method:'POST',headers,body:'{}'})).status,409);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/handoff/open',{method:'POST',headers,body:'{}'})).status,409);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/local/progress',{method:'POST',headers,body:JSON.stringify({fields:['Work authorization'],message:'Needs work authorization'})})).status,200);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/local/submitted',{method:'POST',headers,body:JSON.stringify({receipt:'Thank you for applying',afterSubmit:false})})).status,400);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/local/submitted',{method:'POST',headers,body:JSON.stringify({receipt:'Please complete the form',afterSubmit:true})})).status,400);
  const endpoint=base+'/api/jobs/'+id+'/local/';
  assert.equal((await fetch(endpoint+'claim',{method:'POST',headers:{...headers,'X-ApplyPilot-Device':'22222222-2222-2222-2222-222222222222'},body:'{}'})).status,409);
  assert.equal((await fetch(endpoint+'submitted',{method:'POST',headers,body:JSON.stringify({receipt:'Thank you for applying',url:'https://jobs.lever.co/example/def',afterSubmit:true})})).status,400);
  assert.equal((await fetch(endpoint+'attempt',{method:'POST',headers,body:JSON.stringify({url:'https://jobs.lever.co/example/other',before:'Application'})})).status,409);
  assert.equal((await fetch(endpoint+'attempt',{method:'POST',headers,body:JSON.stringify({url:'https://jobs.lever.co/example/def',before:'I certify these statements'})})).status,409);
  const intent={url:'https://jobs.lever.co/example/def/apply',before:'Application form'};
  assert.equal((await fetch(endpoint+'attempt',{method:'POST',headers,body:JSON.stringify(intent)})).status,200);
  assert.equal((await fetch(endpoint+'attempt',{method:'POST',headers,body:JSON.stringify(intent)})).status,409);
  assert.equal((await (await fetch(endpoint+'claim',{method:'POST',headers,body:'{}'})).json()).attempted,true);
  assert.equal((await fetch(endpoint+'submitted',{method:'POST',headers,body:JSON.stringify({receipt:'Thank you for applying',url:'https://jobs.lever.co/example/other',afterSubmit:true})})).status,400);
  assert.equal((await fetch(endpoint+'submitted',{method:'POST',headers,body:JSON.stringify({receipt:'Thank you for applying',url:'https://jobs.lever.co/example/def',afterSubmit:true})})).status,200);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/outcome',{method:'PUT',headers,body:JSON.stringify({status:'offer'})})).status,200);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/queue',{method:'POST',headers,body:'{}'})).status,409);
  db.prepare("UPDATE jobs SET status='submitted' WHERE id=?").run(id);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(id).status,'submitted');
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

test('Live handoff isolates owners, preserves context on resume and expires idle sessions',async()=>{
 const {Handoffs}=await import('./handoff.js');let time=0,closed=0,resumed=0,submitted=0,body='Application form';
 const page={isClosed:()=>false,locator:()=>({innerText:async()=>body}),frames:()=>[page],screenshot:async()=>Buffer.from('mock-image'),url:()=> 'https://jobs.lever.co/example/abc',keyboard:{insertText:async()=>{},press:async()=>{}},mouse:{click:async()=>{},wheel:async()=>{}},evaluate:async()=>false};
 const context={pages:()=>[page],close:async()=>{closed++}};
 const h=new Handoffs({clock:()=>time,onResume:async(j,s)=>{assert.equal(s.context,context);resumed++},onClose:()=>{},onSubmitted:()=>{submitted++},onPossibleSubmit:()=>{}});
 await h.hold({id:'job',user_id:'owner'},context,page);
 await assert.rejects(h.command('other','job','view'),/No live browser/);
 assert((await h.command('owner','job','view')).image);
 await h.command('owner','job','resume');assert.equal(resumed,1);assert.equal(closed,0);assert.equal(h.sessions.size,0);
 await h.hold({id:'job',user_id:'owner'},context,page);body='Thank you for applying';assert.equal((await h.command('owner','job','view')).submitted,undefined);assert.equal((await h.command('owner','job','key',{key:'Enter'})).submitted,true);assert.equal(submitted,1);assert.equal(closed,1);
 body='Application form';await h.hold({id:'job',user_id:'owner'},context,page);time=16*60*1000;await h.expire();assert.equal(h.sessions.size,0);assert.equal(closed,2);
});

test('Full handoff slots evict an idle browser instead of stopping queued work',async()=>{
 const {Handoffs}=await import('./handoff.js');let closed=0;const events=[];
 const page={frames:()=>[page],url:()=> 'https://jobs.lever.co/example/one',locator:()=>({innerText:async()=> 'Form'})};
 const context={pages:()=>[page],close:async()=>{closed++;}};
 const h=new Handoffs({max:1,onClose:(job,message)=>events.push({id:job.id,message}),onResume:()=>{},onSubmitted:()=>{},onPossibleSubmit:()=>{}});
 await h.hold({id:'first'},context,page);await h.hold({id:'second'},context,page);
 assert.equal(closed,1);assert(!h.sessions.has('first'));assert(h.sessions.has('second'));assert.equal(events[0].id,'first');
 h.sessions.get('second').busy=true;assert.equal(await h.hold({id:'third'},context,page),false);assert(h.sessions.has('second'));assert.equal(closed,2);
});
