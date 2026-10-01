import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';
const testRoot=process.env.APPLYPILOT_TEST_TMP||tmpdir();mkdirSync(testRoot,{recursive:true});const dir=mkdtempSync(join(testRoot,'applypilot-'));process.env.DATABASE_PATH=join(dir,'test.sqlite');process.env.SESSION_SECRET='test-only-secret-'.repeat(3);process.env.REGISTRATION_CODE='test-registration-'.repeat(2);
const {matches,matchAssessment}=await import('./matching.js');const {parseBoards,parseIntent,profileSearchInstruction,mergeProfileRoles,searchIntentForApplicant,runSearch,directDiscoveryLink}=await import('./discovery.js');const {db,now}=await import('./db.js');const {issueToken}=await import('./auth.js');
test('Role variants and Canadian cities match without accepting US-only remote',()=>{
 const intent=parseIntent('Find DevOps Engineer and Cloud Engineer; remote; Canada');
 for(const title of ['Senior SRE','Platform Engineer','Site Reliability Engineer II','DevOps Specialist'])assert(matches({title,location:'Toronto',remote:true},intent));
 assert(!matches({title:'DevOps Engineer',location:'United States',remote:true},intent));
 assert(!matches({title:'Senior Software Engineer Ruby Security Platform Authorization',location:'Canada',remote:true},intent));
 assert(!matches({title:'Sales Engineer',location:'Canada',remote:true},intent));
 assert(!matches({title:'DevOps Engineer',location:'London',remote:false},intent));
 assert(matches({title:'Cloud Engineer',location:'Worldwide',remote:true},intent));
 assert(matches({title:'Site Reliability Engineer',location:'Home based - Worldwide'},intent));
 assert(!matches({title:'Site Reliability Engineer',location:'Home based - United States'},intent));
 assert(!matches({title:'Nursing Director',location:'Canada'},parseIntent('Nurse; Canada')));
});
test('Discovery queues only eligible direct matches and deduplicates repeated runs',async()=>{
 db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('u','test@example.com','unused',now());
 db.prepare('INSERT INTO applicants(id,user_id,name,email,resume_path,consent,created_at) VALUES(?,?,?,?,?,?,?)').run('a','u','Tester','test@example.com','/fake.pdf',1,now());
 db.prepare('INSERT INTO searches(id,user_id,applicant_id,instruction,boards_json,auto_queue,created_at) VALUES(?,?,?,?,?,?,?)').run('s','u','a','DevOps Engineer; Canada','["https://jobs.lever.co/example"]',1,now());
 const original=global.fetch;global.fetch=async url=>({ok:true,headers:new Headers(),text:async()=>JSON.stringify(String(url).includes('api.lever.co')?[{text:'Site Reliability Engineer',categories:{location:'Toronto'},applyUrl:'https://jobs.lever.co/example/abc/apply'}]:String(url).includes('jobicy')?{jobs:[{jobTitle:'DevOps Engineer',companyName:'Aggregator fixture',jobGeo:'Canada',url:'https://jobicy.com/jobs/123-fixture'}]}:{data:[]})});
 try{const first=await runSearch('s','u');assert.equal(first.queued,1);assert.equal(first.added,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE company=?').get('Aggregator fixture').n,0);assert.equal((await runSearch('s','u')).added,0);db.prepare("UPDATE jobs SET status='saved' WHERE applicant_id='a'").run();assert.equal((await runSearch('s','u')).queued,1);assert.equal(JSON.parse(db.prepare("SELECT last_result_json FROM searches WHERE id='s'").get().last_result_json).queued,1);}finally{global.fetch=original}
});
test('Ashby discovery saves comparable roles but queues only strong profile matches',async()=>{
 db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('u2','second@example.com','unused',now());
 db.prepare('INSERT INTO applicants(id,user_id,name,email,location,focus,resume_path,consent,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('a2','u2','Second','second@example.com','Toronto, Ontario','DevOps Engineer, Cloud Support Engineer','/fake.pdf',1,now());
 db.prepare('INSERT INTO searches(id,user_id,applicant_id,instruction,boards_json,auto_queue,created_at) VALUES(?,?,?,?,?,?,?)').run('s2','u2','a2','DevOps Engineer; Toronto, remote Canada','["https://jobs.ashbyhq.com/fixture"]',1,now());
 const original=global.fetch;global.fetch=async url=>({ok:true,headers:new Headers(),text:async()=>JSON.stringify(String(url).includes('/job-board/fixture')?{jobs:[
  {title:'Cloud Support Engineer',location:'Toronto, Ontario',jobUrl:'https://jobs.ashbyhq.com/fixture/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'},
  {title:'Senior Cloud Support Engineer',location:'Toronto, Ontario',jobUrl:'https://jobs.ashbyhq.com/fixture/bbbbbbbb-cccc-dddd-eeee-ffffffffffff'},
  {title:'Cloud Support Engineer',location:'Remote - United States only',isRemote:true,jobUrl:'https://jobs.ashbyhq.com/fixture/cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa'}
 ]}:String(url).includes('api.lever.co')?[]:String(url).includes('jobicy')?{jobs:[]}:String(url).includes('arbeitnow')?{data:[]}:{jobs:[]})});
 try{const result=await runSearch('s2','u2');assert.equal(result.added,2);assert.equal(result.strongMatches,1);assert.equal(result.queued,1);assert.deepEqual(db.prepare("SELECT status FROM jobs WHERE applicant_id='a2' ORDER BY title").all().map(row=>row.status),['queued','saved']);}finally{global.fetch=original}
});
test('Expanded roles preserve CI/CD and the requested location priority',async()=>{
 const {locationPriority}=await import('./matching.js');
 const roles=['Application Support Engineer','Technical Support Engineer','Cloud Support Engineer','Production Support Engineer','Systems Administrator','Infrastructure Engineer','DevOps Engineer','Platform Engineer','NOC Engineer','CI/CD Engineer','Head of Infrastructure','Build and Release Engineer'];
 const intent=parseIntent(roles.join(', ')+'; priority: York Region > Toronto > GTA > remote > Canada > worldwide');
 assert.equal(intent.roles.length,12);assert(intent.roles.includes('ci/cd engineer'));
 for(const title of roles)assert(matches({title,location:'Berlin'},intent));
 assert.deepEqual([{location:'Markham, Ontario'},{location:'North York, Toronto'},{location:'Mississauga'},{location:'Remote - Canada'},{location:'Vancouver, Canada'},{location:'Berlin'}].map(locationPriority),[0,1,2,3,4,5]);
 assert(!matches({title:'Accountant',location:'Markham'},intent));
});
test('Comparable infrastructure titles are discovered but only strong, location-compatible roles auto-queue',()=>{
 const intent=parseIntent('DevOps Engineer; priority: York Region > Toronto > GTA > remote > Canada > worldwide');
 assert.equal(matchAssessment({title:'Cloud Operations Engineer',location:'Toronto'},intent,'DevOps Engineer, Cloud Engineer').strong,true);
 assert.equal(matchAssessment({title:'DevOps Manager',location:'Toronto'},intent,'DevOps Engineer').strong,false);
 assert.equal(matchAssessment({title:'Senior DevOps Engineer',location:'Toronto'},intent,'Operations Manager, DevOps Engineer').strong,false);
 assert.equal(matchAssessment({title:'DevOps Engineer',location:'Remote - United States only',remote:true},intent,'DevOps Engineer').strong,false);
 assert.equal(matchAssessment({title:'DevOps Engineer',location:'Berlin'},intent,'DevOps Engineer').strong,false);
 assert.equal(matchAssessment({title:'DevOps Engineer',location:'Worldwide'},intent,'DevOps Engineer').strong,true);
 assert.equal(matches({title:'Senior Software Engineer, Infrastructure Security',location:'Toronto'},intent),false);
});
test('Conflicting occupation and function titles are never strong auto-queue matches',()=>{
 const location='Toronto, Ontario';
 for(const [wanted,title] of [
  ['Senior DevOps Engineer','Senior Manager, DevOps'],
  ['DevOps Engineer','DevOps Sales Specialist'],
  ['Registered Nurse','Nurse Aide'],
  ['Registered Nurse','Nurse Educator'],
  ['Systems Administrator','Business Systems Engineer']
 ]){
  const assessment=matchAssessment({title,location},parseIntent(`${wanted}; Toronto`),wanted);
  assert.equal(assessment.strong,false,`${wanted} should not auto-queue ${title}`);
 }
 assert.equal(matchAssessment({title:'Senior Site Reliability Engineer',location},parseIntent('Senior DevOps Engineer; Toronto')).strong,true);
 assert.equal(matchAssessment({title:'Site Reliability Engineer',location},parseIntent('Senior DevOps Engineer; Toronto')).strong,false);
 assert.equal(matchAssessment({title:'DevOps Specialist',location},parseIntent('DevOps Engineer; Toronto')).strong,true);
 for(const otherRole of ['Head of Infrastructure','Operations Manager','Senior SRE']){
  const mixed=parseIntent(`DevOps Engineer, ${otherRole}; Toronto`);
  assert.equal(matchAssessment({title:'DevOps Engineer',location},mixed).strong,true,`${otherRole} must not contaminate the DevOps role`);
 }
});
test('Shared role suffixes and local-plus-remote location lists stay specific',()=>{
 const intent=parseIntent('DevOps or Infrastructure Engineer; York Region, Toronto, remote Canada');
 assert.deepEqual(intent.roles,['devops engineer','infrastructure engineer']);assert.equal(intent.remote,false);
 assert.deepEqual(intent.localPlaces,['york region','toronto']);assert.deepEqual(intent.remotePlaces,['canada']);
 assert(matches({title:'DevOps Engineer',location:'Markham, Ontario'},intent));
 assert(matches({title:'Infrastructure Engineer',location:'Remote - Canada',remote:true},intent));
 assert(!matches({title:'DevOps Engineer',location:'Vancouver, Canada',remote:false},intent));
 assert(!matches({title:'DevOps Engineer',location:'Calgary, Alberta',remote:false},intent));
 assert.equal(matchAssessment({title:'DevOps Manager',location:'Toronto'},intent).strong,false);
 const reversed=parseIntent('DevOps or Infrastructure Engineer; remote Canada, Toronto, York Region');
 assert.deepEqual(reversed.localPlaces,['toronto','york region']);assert.deepEqual(reversed.remotePlaces,['canada']);assert.equal(reversed.remote,false);
 assert(matches({title:'DevOps Engineer',location:'Toronto, Ontario',remote:false},reversed));
 assert(matches({title:'DevOps Engineer',location:'Remote - Canada',remote:true},reversed));
 assert.equal(matchAssessment({title:'DevOps Engineer',location:'Vancouver, Canada',remote:false},reversed).strong,false);
 assert.equal(matchAssessment({title:'DevOps Engineer',location:'Calgary, Alberta',remote:false},reversed).strong,false);
});
test('Mixed local and remote-country constraints are order-independent',()=>{
 for(const instruction of ['DevOps Engineer; Toronto, remote Canada','DevOps Engineer; remote Canada, Toronto']){
  const intent=parseIntent(instruction);
  assert.deepEqual(intent.localPlaces,['toronto']);assert.deepEqual(intent.remotePlaces,['canada']);assert.deepEqual(intent.places,['toronto']);assert.equal(intent.remote,false);
  assert.equal(matchAssessment({title:'DevOps Engineer',location:'Toronto, Ontario',remote:false},intent).strong,true);
  assert.equal(matchAssessment({title:'DevOps Engineer',location:'Remote - Canada',remote:true},intent).strong,true);
  assert.equal(matchAssessment({title:'DevOps Engineer',location:'Vancouver, Canada',remote:false},intent).strong,false);
  assert.equal(matchAssessment({title:'DevOps Engineer',location:'Calgary, Alberta',remote:false},intent).strong,false);
 }
});
test('Remote-country and free-text city clauses never fall open to worldwide matches',()=>{
 const remoteCanada=parseIntent('DevOps Engineer; remote Canada');assert.equal(remoteCanada.remote,true);
 assert(matches({title:'DevOps Engineer',location:'Remote - Canada',remote:true},remoteCanada));
 assert(!matches({title:'DevOps Engineer',location:'Toronto',remote:false},remoteCanada));
 assert(!matches({title:'DevOps Engineer',location:'Remote - United States only',remote:true},remoteCanada));
 for(const instruction of ['DevOps Engineer; remote; Canada','DevOps Engineer; Canada remote']){
  const intent=parseIntent(instruction);assert.equal(intent.remote,true);assert.deepEqual(intent.places,[]);assert.deepEqual(intent.remotePlaces,['canada']);
  assert(matches({title:'DevOps Engineer',location:'Remote - Canada',remote:true},intent));
  assert(!matches({title:'DevOps Engineer',location:'Toronto',remote:false},intent));
 }
 const berlin=parseIntent('DevOps Engineer; Berlin');assert.deepEqual(berlin.places,['berlin']);
 assert(matches({title:'DevOps Engineer',location:'Berlin, Germany'},berlin));
 assert(!matches({title:'DevOps Engineer',location:'Toronto'},berlin));
 assert(!matches({title:'DevOps Engineer',location:'Remote - Canada',remote:true},berlin));
 const newYork=parseIntent('DevOps Engineer; New York, NY');assert.deepEqual(newYork.places,['new york ny']);
 assert(matches({title:'DevOps Engineer',location:'New York, NY'},newYork));
 assert(!matches({title:'DevOps Engineer',location:'Toronto'},newYork));
});
test('Resume discovery prefers explicit profile roles and carries the saved Canadian location',()=>{
 const instruction=profileSearchInstruction({focus:'Infrastructure Engineer, Cloud Support Engineer',location:'Toronto, Ontario'},['Software Engineer','Project Manager']);
 assert.equal(instruction,'infrastructure engineer, cloud support engineer; Toronto, Ontario, remote Canada');
 const intent=parseIntent(instruction);assert.deepEqual(intent.roles,['infrastructure engineer','cloud support engineer']);
 assert(matches({title:'Cloud Support Engineer',location:'Remote - Canada',remote:true},intent));
 assert(!matches({title:'Project Manager',location:'Toronto'},intent));
});
test('Saved profile roles expand discovery without weakening level or location checks',()=>{
 const intent=mergeProfileRoles(parseIntent('DevOps Engineer; Toronto, remote Canada'),'Infrastructure Engineer, Cloud Support Engineer');
 assert(intent.roles.includes('cloud support engineer'));
 assert.equal(matchAssessment({title:'Cloud Support Engineer',location:'Toronto'},intent).strong,true);
 assert.equal(matchAssessment({title:'Senior Cloud Support Engineer',location:'Toronto'},intent).strong,false);
 assert.equal(matches({title:'Cloud Support Engineer',location:'Remote - United States only',remote:true},intent),false);
});
test('Old auto-generated searches refresh location from the current profile on every run',()=>{
 const applicant={focus:'DevOps Engineer',location:'Toronto, Ontario'};
 const refreshed=searchIntentForApplicant({instruction:'DevOps Engineer',auto_generated:1},applicant);
 assert.equal(refreshed.instruction,'devops engineer; Toronto, Ontario, remote Canada');
 assert(matches({title:'DevOps Engineer',location:'Toronto'},refreshed.intent));
 assert(matches({title:'DevOps Engineer',location:'Remote - Canada',remote:true},refreshed.intent));
 assert(!matches({title:'DevOps Engineer',location:'Berlin'},refreshed.intent));
 assert(!matches({title:'DevOps Engineer',location:'Remote - United States only',remote:true},refreshed.intent));
 const manual=searchIntentForApplicant({instruction:'DevOps Engineer; priority: York Region > Toronto > GTA > remote > Canada > worldwide',auto_generated:0},applicant);
 assert.equal(manual.instruction,'DevOps Engineer; priority: York Region > Toronto > GTA > remote > Canada > worldwide');
});
test('Ashby employer boards and direct application links are accepted without broadening arbitrary hosts',()=>{
 assert.deepEqual(parseBoards('https://jobs.ashbyhq.com/Blackpoint%20Cyber'),['https://jobs.ashbyhq.com/Blackpoint%20Cyber']);
 assert.deepEqual(parseBoards('https://jobs.ashbyhq.com/marble.ai'),['https://jobs.ashbyhq.com/marble.ai']);
 assert(directDiscoveryLink('https://jobs.ashbyhq.com/hopper/d0d53b33-ed77-49b5-9d17-624bc946be4b'));
 assert(!directDiscoveryLink('https://example.com/hopper/d0d53b33-ed77-49b5-9d17-624bc946be4b'));
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
  for(const origin of ['https://applypilot-jobs.netlify.app','https://applypilot-jobs.pages.dev']){const r=await fetch(base+'/api/health',{headers:{Origin:origin}});assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),origin);}
  assert.equal((await fetch(base+'/api/health',{method:'OPTIONS',headers:{Origin:'https://other.pages.dev'}})).status,403);
  assert.equal((await fetch(base+'/api/health',{headers:{Origin:'https://applypilot-jobs.pages.dev.evil.example'}})).status,403);
  const headers={Authorization:'Bearer '+issueToken('u'),Origin:base,'Content-Type':'application/json','X-ApplyPilot-Device':'11111111-1111-1111-1111-111111111111'};
  assert.equal((await (await fetch(base+'/api/status',{headers})).json()).workerOnline,false);
  const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  db.prepare("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,challenge,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'needs_review','Unconfirmed submission',?,?)").run(id,'u','a','SRE','Example','https://jobs.lever.co/example/def','https://jobs.lever.co/example/def',now(),now());
  assert.equal((await fetch(base+'/api/jobs/'+id+'/queue',{method:'POST',headers,body:'{}'})).status,409);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/handoff/open',{method:'POST',headers,body:'{}'})).status,409);
  assert.equal((await fetch(base+'/api/jobs/'+id+'/handoff/view',{method:'POST',headers:{...headers,Authorization:'Bearer '+issueToken('other')},body:'{}'})).status,404);
  const save=await fetch(base+'/api/jobs/'+id+'/answers',{method:'PUT',headers,body:JSON.stringify({question:'Why this role?',answer:'I enjoy infrastructure operations.',remember:true})});assert.equal(save.status,200);assert.equal(JSON.parse(db.prepare('SELECT answers_json FROM applicants WHERE id=?').get('a').answers_json)['Why this role?'],undefined);
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
  const intent={url:'https://jobs.lever.co/example/def/apply',before:'Application form',human:true};
  assert.equal((await fetch(endpoint+'attempt',{method:'POST',headers,body:JSON.stringify({...intent,human:false})})).status,409);
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
 assert.equal(canonicalJobURL('https://jobs.ashbyhq.com/hopper/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/application?utm_source=test'),canonicalJobURL('https://jobs.ashbyhq.com/hopper/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
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

test('Fast handoff acknowledges input without screenshots and still verifies receipts on view',async()=>{
 const {Handoffs}=await import('./handoff.js');let screenshots=0,submitted=0,intents=0,body='Application form';const keys=[],scroll=[];
 const page={isClosed:()=>false,frames:()=>[page],url:()=> 'https://jobs.lever.co/example/one',locator:()=>({innerText:async()=>body}),screenshot:async()=>{screenshots++;return Buffer.from('same-frame')},keyboard:{insertText:async x=>keys.push(x),press:async x=>keys.push(x)},mouse:{move:async(...p)=>scroll.push(p),wheel:async(...p)=>scroll.push(p)},evaluate:async()=>false};
 const context={pages:()=>[page],close:async()=>{}};const h=new Handoffs({onClose:()=>{},onResume:()=>{},onSubmitted:()=>submitted++,onPossibleSubmit:()=>intents++});await h.hold({id:'j',user_id:'u'},context,page);
 assert.deepEqual(await h.command('u','j','text',{text:'Hello',render:false}),{accepted:true});assert.equal(screenshots,0);
 await h.command('u','j','key',{key:'ArrowLeft',render:false});await h.command('u','j','scroll',{y:30,x:2,pointerX:100,pointerY:200,render:false});assert.deepEqual(keys,['Hello','ArrowLeft']);assert.deepEqual(scroll,[[100,200],[2,30]]);
 const first=await h.command('u','j','view');const second=await h.command('u','j','view',{frameId:first.frameId});assert(first.image);assert.equal(second.image,undefined);
 await h.command('u','j','key',{key:'Enter',render:false});assert.equal(intents,1);body='Thank you for applying';assert.equal((await h.command('u','j','view')).submitted,true);assert.equal(submitted,1);
});
