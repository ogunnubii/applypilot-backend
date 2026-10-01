const {test}=require('node:test');
const fs=require('node:fs'),path=require('node:path');
const sources=Object.fromEntries(["application-pipeline.js","application-dedup.js","assistant-page.html","assistant-client.js","extension/background.js","extension/content.js","extension/policy.js","work-eligibility.js","discovery.js","operation-evidence.js","continuation-queue.js","answer-library.js","worker.js","job-intelligence.js","matching.js","db.js","server.js","public-answer-fill.js","google-research.js","research-consent.js","resume-editor.js","web/setup.html","web/setup.js","extension/popup.js","extension/popup.html"].map(file=>[file,fs.readFileSync(path.join(__dirname,'..',file),'utf8')]));
test("routine submissions and receipt safety",()=>(async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const wait=()=>new Promise(r=>setTimeout(r,35));
 async function scenario(extra='',{denied=false,initialAttempt=false,automatic=true,receipt=false}={}){
  const dom=new JSDOM('<form><label>Full name<input required></label>'+extra+'<button type="button" id="submit">Submit application</button></form>',{runScripts:'outside-only',url:'https://jobs.ashbyhq.com/example/12345678-1234-1234-1234-123456789abc'}),w=dom.window;
  Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  w.HTMLElement.prototype.getClientRects=function(){return this.type==='hidden'||this.closest('[hidden]')?[]:[{}]};
  const messages=[],timers=[];let attempted=initialAttempt,clicks=0;
  w.setInterval=fn=>{timers.push(fn);return timers.length};w.clearInterval=()=>{};
  w.document.getElementById('submit').onclick=()=>{assert(attempted,'intent must precede click');clicks++;if(receipt)w.document.querySelector('form').innerHTML='<p>Thank you for applying</p>';};
  w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);if(m.action==='packet')return {ok:true,data:{job:{title:'Fixture',attempted},profile:{name:'Applicant'},answers:{},resume:{name:'resume.pdf',base64:''}}};if(m.action==='state')return {ok:true,data:{attempted,automatic:automatic&&!attempted}};if(m.action==='attempt'){if(denied)return {ok:false,error:'transport uncertain'};assert(!attempted);attempted=true;}return {ok:true,data:{}};}}};
  w.eval(sources['extension/policy.js']);w.eval(sources['extension/content.js']);await wait();
  for(const fn of [...timers])await fn();await wait();for(const fn of [...timers])await fn();
  return {messages,clicks,close:()=>w.close()};
 }
 let f=await scenario('',{receipt:true});assert.equal(f.clicks,1);assert.equal(f.messages.filter(m=>m.action==='attempt').length,1);assert(f.messages.some(m=>m.action==='receipt'));f.close();
 for(const opts of [{denied:true},{initialAttempt:true},{automatic:false}]){f=await scenario('',opts);assert.equal(f.clicks,0);f.close();}
 for(const extra of ['<p>By submitting you provide consent for a criminal record check.</p>','<label>Unknown fact<input required></label>','<div class="g-recaptcha"></div>','<input type="password">','<p>By submitting, I certify that these statements are true.</p>']){f=await scenario(extra);assert.equal(f.clicks,0);assert(!f.messages.some(m=>m.action==='attempt'));f.close();}
 return 'PASS extension: one submit after durable intent, receipt confirmation, no duplicate, unknown facts/CAPTCHA/login/legal/transport block';
})());
test("interview integration and deduplication",()=>(async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://marvelous-vitality-production-c2d8.up.railway.app/'}),w=dom.window;
 const jobs=[{id:'native',title:'Staff Engineer',company:'Clutch',status:'interview',updated_at:'2026-10-01T00:00:00Z',confirmation:'Receipt',notes:''},{id:'saved',company:'Example',title:'Engineer',status:'saved',updated_at:'2026-10-01T00:00:00Z',execution_mode:'local'}];
 const records=[{id:'px',company:'Project X',title:'Senior Data Platform Engineer',status:'interview',interview_stage:'completed',notes:'GitLab CI and DevSecOps',interview_at:'September 29, 2026, 4 PM',source:'Applicant',work_mode:'unknown'},{id:'clutch',company:'Clutch Technologies Inc.',title:'Staff Engineer',status:'interview',source:'Email',interview_stage:'scheduled'},{id:'past',company:'Hidden Past Employer',title:'Past Job',status:'applied'}];
 w.sessionStorage.setItem('applypilot-token','fixture');
 w.setInterval=()=>0;
 w.fetch=async(url,options)=>({ok:true,json:async()=>{const p=String(url).replace('/api','');if(p==='/jobs')return {jobs};if(p==='/status')return {workerOnline:true};if(p==='/application-history')return {records};if(p==='/searches')return {searches:[]};if(p==='/notifications')return {enabled:false};return {enabled:false,parked:0};}});
 w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);await new Promise(r=>setTimeout(r,100));
 assert.equal(w.document.querySelector('#interview-count').textContent,'2','deduplicated native and external interviews');
 const board=[...w.document.querySelector('#jobs').children];assert.equal(board.filter(e=>e.dataset.state==='interview').length,2);
 const filter=w.document.querySelector('[data-filter=interview]');filter.click();
 assert.equal(board.filter(e=>!e.hidden).length,2);assert(board.find(e=>e.textContent.includes('Project X')).textContent.includes('Completed interview'));
 assert(w.document.querySelector('#career-overview').textContent.includes('GitLab CI and DevSecOps'));
 assert(!w.document.body.textContent.includes('Hidden Past Employer'));
 assert.equal(w.document.querySelector('#external-history').open,false);assert(w.document.querySelector('#job-saved').textContent.includes('Example'));assert(w.document.querySelector('#external-px').textContent.includes('Project X'));
 const form=w.document.querySelector('#career-overview form'),input=form.querySelector('textarea');form.closest('details').open=true;input.value='Unsaved feedback';await w.eval('refresh(true)');assert.equal(input.value,'Unsaved feedback');
 dom.window.close();return 'PASS UI: imported and native interviews merged, filter/count correct, completed feedback visible, prior jobs hidden, edits preserved';
})());
test("eligible global work evidence",()=>(async()=>{
const assert=require('node:assert/strict'),{workEligibility:f}=await import('data:text/javascript;base64,'+Buffer.from(sources['work-eligibility.js']).toString('base64'));
const cases=[
 [{location:'Toronto, Canada',description:'Full time employee; remote'},false],
 [{location:'Toronto',description:'We welcome incorporated contractors for this project'},true],
 [{location:'London',description:'We offer visa sponsorship for this role.'},true],
 [{location:'London',description:'Visa sponsorship is not available.'},false],
 [{location:'UK remote',remote:true,description:'Remote work within the UK.'},false],
 [{location:'Remote worldwide',remote:true,description:'Work from anywhere in the world.'},true],
 [{location:'Remote worldwide',remote:true,description:'You must be based in the UK'},false],
 [{location:'Canada',description:'We offer visa sponsorship'},false],
 [{location:'Berlin',employmentType:'Contract'},true],
 [{location:'Canada',employmentType:'Contract'},false]
];for(const [j,expected] of cases)assert.equal(f(j).eligible,expected,JSON.stringify(j));return 'PASS 10 eligibility fixtures: explicit sponsorship, remote scope, Canada B2B-only, negative evidence';
})());
test("browser queue reliability",()=>(async()=>{
 const assert=require('node:assert/strict'),vm=require('node:vm');let gets=0,queries=[];
 const state={records:{broken:{id:'broken',auto:true,phase:'ready',touched:0,url:'https://jobs.lever.co/example/a'}},queue:[],enabled:true};
 const noOp={addListener(){}},chrome={storage:{local:{get:async()=>state,set:async v=>Object.assign(state,v)}},tabs:{get:async()=>{gets++;throw Error('missing tab');},query:async q=>{queries.push(q);return [{id:4}];},onRemoved:noOp},scripting:{executeScript:async({args})=>[{result:{data:args[1]==='/jobs'?{jobs:[]}:{ok:true}}}]},runtime:{onMessage:noOp,onStartup:noOp,onInstalled:noOp},alarms:{onAlarm:noOp}};
 const context={chrome,URL,console,Date,crypto:require('node:crypto').webcrypto,importScripts(){},ApplyPilotPolicy:{sameApplication:()=>false,supported:()=>true}};
 vm.runInNewContext(sources['extension/background.js']+';globalThis.testTick=tick;',context);await context.testTick();
 assert.equal(gets,0,'missing tab ID must never reach chrome.tabs.get');assert.equal(state.records.broken.auto,false);
 assert(queries.some(q=>q.url?.includes('https://marvelous-vitality-production-c2d8.up.railway.app/*')));
 return 'PASS background: missing tab IDs safely paused; authenticated Railway tabs included for sync';
})());

test('Greenhouse matching does not download all job descriptions',()=>(async()=>{
const assert=require('node:assert/strict'),readJSON=async()=>{throw Error('unexpected request')},urls=[];
const cachedJSON=async url=>{urls.push(url);return {jobs:[{id:42,title:'DevOps Engineer',location:{name:'London'},absolute_url:'https://job-boards.greenhouse.io/example/jobs/42'}]};};
const source=sources['discovery.js'].slice(sources['discovery.js'].indexOf('async function listBoard'),sources['discovery.js'].indexOf('const defaultBoards'));
const listBoard=new Function('cachedJSON','readJSON',source+';return listBoard;')(cachedJSON,readJSON);
const jobs=await listBoard('https://job-boards.greenhouse.io/example');assert(!urls[0].includes('content=true'));assert.equal(jobs[0].descriptionURL,'https://boards-api.greenhouse.io/v1/boards/example/jobs/42?pay_transparency=true');
return 'PASS Greenhouse adapter: bounded metadata feed and separate per-job evidence URL';
})());

test('React Select opens before discovering options and verifies the selected value',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 async function scenario({ambiguous=false,accepted=true,preselected=false,legal=''}={}){
  const dom=new JSDOM('<form><label id="country-label">Country</label><div class="select__control"><div class="select__value-container"><input id="country" role="combobox" aria-labelledby="country-label" aria-required="true" aria-expanded="false"></div></div>'+legal+'<button type="button" id="submit">Submit application</button></form>',{runScripts:'outside-only',url:'https://job-boards.greenhouse.io/example/jobs/42'}),w=dom.window;
  Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  w.HTMLElement.prototype.getClientRects=function(){return this.isConnected&&!this.closest('[hidden]')?[{}]:[];};
  w.setInterval=()=>0;w.clearInterval=()=>{};const messages=[];let attempts=0,clicks=0;
  const input=w.document.querySelector('input'),container=input.parentElement;
  const select=()=>{const selected=w.document.createElement('div');selected.className='select__single-value';selected.textContent='Canada';container.prepend(selected);input.value='';input.setAttribute('aria-expanded','false');w.document.getElementById('country-options')?.remove();};
  if(preselected)select();
  input.onclick=()=>{if(w.document.getElementById('country-options'))return;const list=w.document.createElement('div');list.id='country-options';list.setAttribute('role','listbox');for(let i=0;i<(ambiguous?2:1);i++){const option=w.document.createElement('div');option.setAttribute('role','option');option.textContent='Canada +1';option.onclick=()=>{if(accepted)select();else {input.value='Canada';list.remove();}};list.append(option);}w.document.body.append(list);input.setAttribute('aria-controls',list.id);input.setAttribute('aria-expanded','true');};
  w.document.getElementById('submit').onclick=()=>{assert(attempts===1);clicks++;};
  w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);if(m.action==='packet')return {ok:true,data:{job:{title:'Fixture'},profile:{location:'Toronto, Ontario, Canada'},answers:{},resume:{name:'resume.pdf',base64:''}}};if(m.action==='state')return {ok:true,data:{automatic:true,attempted:!!attempts}};if(m.action==='attempt')attempts++;return {ok:true,data:{}};}}};
  w.eval(sources['extension/policy.js']);w.eval(sources['extension/content.js']);await new Promise(r=>setTimeout(r,1150));
  const result={attempts,clicks,messages};w.close();return result;
 }
 const success=await scenario();assert.equal(success.clicks,1);assert(success.messages.some(m=>m.action==='capture'&&m.fields.some(f=>f.question==='Country'&&f.answer==='Canada')));
 assert.equal((await scenario({preselected:true})).clicks,1);
 for(const opts of [{ambiguous:true},{accepted:false},{legal:'<p>Agreement to Arbitrate: please read the arbitration agreement.</p>'},{legal:'<label>Unknown employer question<input required></label>'}])assert.equal((await scenario(opts)).attempts,0);
});
test('progress counts are based on evidence and do not recount outcomes',async()=>{
 const assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
 const policy='data:text/javascript;base64,'+Buffer.from(sources['extension/policy.js']+'\nexport const receipt=globalThis.ApplyPilotPolicy.receipt;').toString('base64');
 const code=sources['operation-evidence.js'].replace("'./local-policy.js'",JSON.stringify(policy));
 const {operationSnapshot}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE jobs(id TEXT,user_id TEXT,company TEXT,title TEXT,url TEXT,status TEXT,confirmation TEXT,local_phase TEXT,local_attempt_at TEXT,updated_at TEXT); CREATE TABLE events(job_id TEXT,type TEXT,message TEXT); CREATE TABLE answer_history(job_id TEXT);');
 const insert=db.prepare("INSERT INTO jobs(id,user_id,status,confirmation,local_attempt_at,local_phase) VALUES(?,'owner',?,?,?,?)");
 insert.run('receipt','interview','Browser extension observed: Thank you for applying',null,null);
 insert.run('placeholder','submitted','Applicant verified: https://github.com/example',null,null);
 insert.run('uncertain','local_browser',null,'2026-10-01','verifying');
 insert.run('zero','queued',null,null,null);
 insert.run('filled','needs_review',null,null,null);
 insert.run('captured','local_browser',null,null,'blocked');
 insert.run('archive','archived','Thank you for applying',null,null);
 db.exec("INSERT INTO events VALUES('receipt','submitted','Receipt'),('placeholder','manual_confirmation','Manual'),('archive','submitted','Receipt'),('zero','filled','Filled 0 standard fields'),('filled','filled','Filled 3 standard fields'); INSERT INTO answer_history VALUES('captured');");
 const snapshot=operationSnapshot(db,'owner');assert.deepEqual(snapshot.totals,{confirmed:1,worked:4,awaiting:1,active:1,stalled:0,blocked:2,unverifiedOutcome:1,automatic:0,assisted:0,unknown:1});
 assert.equal(operationSnapshot(db,'another-user').applications.length,0);
 db.prepare("UPDATE jobs SET status='offer' WHERE id='receipt'").run();assert.equal(operationSnapshot(db,'owner').totals.confirmed,1);db.close();
});
test('local missing answers are saved without queuing a new attempt',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://marvelous-vitality-production-c2d8.up.railway.app/'}),w=dom.window,requests=[];
 w.setInterval=()=>0;w.fetch=async(url,opts)=>{requests.push([url,opts?.method]);return {ok:true,json:async()=>({})};};w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);
 const job={id:'local',applicant_id:'p',company:'Example',title:'Engineer',status:'local_browser',local_phase:'blocked',challenge:'Local browser',required_fields_json:'["Preferred name","Required field","AI Policy for Application"]',answers_json:'{}'};
 w.renderMissingAnswers([job]);const section=w.document.querySelector('#missing-answers'),form=section.querySelector('form'),input=form.querySelector('textarea');assert(!section.hidden);assert.equal(form.querySelectorAll('textarea').length,1);assert.equal(section.querySelector('details').open,false);input.value='Applicant';
 w.eval('refresh=async()=>{}');await form.onsubmit({preventDefault(){}});assert(requests.some(([url,method])=>url.endsWith('/answers')&&method==='PUT'));assert(!requests.some(([url])=>url.endsWith('/continue')));
 section.dataset.dirty='false';w.renderMissingAnswers([{...job,local_attempt_at:'2026-10-01'}]);assert(section.hidden,'attempted application must not re-enter the answer/resume flow');w.close();
});

test('dashboard resume rejects attempted applications and other origins',async()=>{
 const assert=require('node:assert/strict'),vm=require('node:vm');
 const state={automaticDefault:true,device:'00000000-0000-0000-0000-000000000001',enabled:true,records:{j:{id:'j',attempted:true,phase:'blocked'}},queue:[]};
 const noop={addListener(){}},chrome={storage:{local:{get:async()=>state,set:async v=>Object.assign(state,v),setAccessLevel:async()=>{}}},runtime:{onMessage:noop,onStartup:noop,onInstalled:noop},alarms:{get:async()=>({}),onAlarm:noop},tabs:{onRemoved:noop}};
 const context={chrome,URL,console,Date,crypto:require('node:crypto').webcrypto,importScripts(){},ApplyPilotPolicy:{}};
 vm.runInNewContext(sources['extension/background.js']+';globalThis.testHandle=handle;',context);
 await assert.rejects(()=>context.testHandle({action:'resume-existing',id:'j'},{tab:{id:1},frameId:0,url:'https://malicious.example/'}),/Untrusted/);
 await assert.rejects(()=>context.testHandle({action:'resume-existing',id:'j'},{tab:{id:1},frameId:0,url:'https://marvelous-vitality-production-c2d8.up.railway.app/'}),/cannot automatically restart/);
 assert.equal(state.records.j.attempted,true);
});

test('continuation queue validates readiness, isolates users and never redispatches an uncertain request',async()=>{
 const assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
 const policy=sources['extension/policy.js']+'\nexport const sensitive=globalThis.ApplyPilotPolicy.sensitive;';
 const canCapture=sources['answer-library.js'].match(/export const canCapture=.*?;\n/)[0];
 const library='data:text/javascript;base64,'+Buffer.from(policy+'\n'+canCapture).toString('base64');
 const code=sources['continuation-queue.js'].replace("'./answer-library.js'",JSON.stringify(library));
 const q=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE applicants(id TEXT,user_id TEXT,consent INTEGER,email TEXT,resume_path TEXT);CREATE TABLE jobs(id TEXT,user_id TEXT,applicant_id TEXT,status TEXT,local_phase TEXT,local_attempt_at TEXT,handoff_available INTEGER,challenge TEXT,required_fields_json TEXT,answers_json TEXT,url TEXT,company TEXT,title TEXT);CREATE TABLE events(id INTEGER PRIMARY KEY,job_id TEXT,type TEXT,message TEXT);CREATE TABLE work_focus(user_id TEXT,enabled INTEGER,job_id TEXT);INSERT INTO applicants VALUES('p','u',1,'applicant@example.test','resume.pdf')");
 q.installContinuations(db);
 const base={id:'a',user_id:'u',status:'local_browser',local_phase:'blocked',consent:1,email:'applicant@example.test',has_resume:1,required_fields_json:'["Country"]',answers_json:'{"Country":"Canada"}'};
 const insert=id=>db.prepare("INSERT INTO jobs VALUES(?,'u','p','local_browser','blocked',NULL,0,'Local browser',?,?,?,'Fixture','Engineer')").run(id,base.required_fields_json,base.answers_json,'https://jobs.lever.co/fixture/'+id);
 for(const change of [{local_attempt_at:'yesterday'},{attempt_event:1},{status:'interview'},{consent:0},{has_resume:0},{local_phase:'ready'},{required_fields_json:'[]'},{required_fields_json:'["AI policy"]'},{required_fields_json:'["Preferred name"]'},{progress_message:'Complete the CAPTCHA challenge'},{challenge:'Sign-in'}])assert(q.continuationProblem({...base,...change}),JSON.stringify(change));
 assert.equal(q.continuationProblem(base),'');insert('a');insert('b');
 assert.throws(()=>q.requestContinuation(db,'other','a'),/not found/);
 q.requestContinuation(db,'u','a');q.requestContinuation(db,'u','a');q.requestContinuation(db,'u','b');
 assert.equal(q.listContinuations(db,'u').length,2);assert.equal(q.listContinuations(db,'other').length,0);
 let claim=q.claimContinuation(db,'u');assert.equal(claim.jobId,'a');assert.equal(q.claimContinuation(db,'u'),null,'another dashboard cannot claim concurrently');
 assert.throws(()=>q.settleContinuation(db,'other','a',claim.claimId,'started'),/no longer pending/);
 q.settleContinuation(db,'u','a',claim.claimId,'busy');claim=q.claimContinuation(db,'u');assert.equal(claim.jobId,'a');q.settleContinuation(db,'u','a',claim.claimId,'started');
 assert.throws(()=>q.requestContinuation(db,'u','a'),/already requested/);
 claim=q.claimContinuation(db,'u');assert.equal(claim.jobId,'b');
 db.prepare("UPDATE continuation_requests SET claimed_at='2000-01-01' WHERE job_id='b'").run();
 assert.equal(q.claimContinuation(db,'u'),null);assert.equal(q.listContinuations(db,'u')[0].state,'review');
 assert.throws(()=>q.settleContinuation(db,'u','b',claim.claimId,'busy'),/no longer pending/);
 insert('changed');q.requestContinuation(db,'u','changed');db.prepare("UPDATE jobs SET required_fields_json=? WHERE id='changed'").run(JSON.stringify(["Unknown fact"]));
 assert.equal(q.claimContinuation(db,'u'),null);assert(q.listContinuations(db,'u').some(r=>r.job_id==='changed'&&r.state==='review'));
 insert('attempted');q.requestContinuation(db,'u','attempted');db.prepare("INSERT INTO events(job_id,type,message) VALUES('attempted','submission_started','intent')").run();assert.equal(q.claimContinuation(db,'u'),null);
 insert('focus');q.requestContinuation(db,'u','focus');db.exec("INSERT INTO work_focus VALUES('u',1,'another')");assert.equal(q.claimContinuation(db,'u'),null);
 db.exec('DELETE FROM work_focus');assert.equal(q.claimContinuation(db,'u',()=> 'Consent withdrawn'),null);
 assert.equal(db.prepare("SELECT state FROM continuation_requests WHERE job_id='focus'").get().state,'review');
 assert.equal(db.prepare("SELECT local_attempt_at FROM jobs WHERE id='a'").get().local_attempt_at,null,'queue management never records submission intent');
 db.close();
});

test('saving complete browser answers requests continuation, partial and protected forms stay paused',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 async function scenario(questions,attempted=false){
  const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://marvelous-vitality-production-c2d8.up.railway.app/'}),w=dom.window,requests=[];
  w.setInterval=()=>0;w.fetch=async(url,opts)=>{requests.push([url,opts?.method,opts?.body]);return {ok:true,json:async()=>({state:'queued'})};};
  w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);w.eval('refresh=async()=>{}');
  w.renderMissingAnswers([{id:'j',applicant_id:'p',company:'Fixture',title:'Engineer',status:'local_browser',local_phase:'blocked',required_fields_json:JSON.stringify(questions),answers_json:'{}',local_attempt_at:attempted?'today':null}]);
  const section=w.document.querySelector('#missing-answers'),form=section.querySelector('form');
  if(form){form.querySelector('textarea').value='Applicant';await form.onsubmit({preventDefault(){}});}
  const result={requests,hidden:section.hidden};w.close();return result;
 }
 let r=await scenario(['Preferred name']);assert(r.requests.some(([url,method])=>url.endsWith('/continuation')&&method==='POST'));assert(!r.requests.some(([url])=>url.endsWith('/continue')||url.endsWith('/attempt')));
 for(const questions of [['Preferred name','Unknown fact'],['Preferred name','AI policy']]){r=await scenario(questions);assert(!r.requests.some(([url])=>url.endsWith('/continuation')));}
 assert((await scenario(['Preferred name'],true)).hidden);
});

test('dashboard only retries an explicit busy refusal and honours a paused helper',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://marvelous-vitality-production-c2d8.up.railway.app/'}),w=dom.window,requests=[];
 w.setInterval=()=>0;w.fetch=async(url,opts)=>{requests.push([String(url),opts?.body&&JSON.parse(opts.body)]);return {ok:true,json:async()=>String(url).endsWith('/claim')?{request:{jobId:'j',claimId:'lease'}}:{requests:[]}};};
 w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']+';window.configureContinuationTest=(enabled,handler)=>{nextContinuationCheck=0;browserHelperStatus={enabled,version:"0.6.1",checkedAt:Date.now()};resumeLocalApplication=handler;};');
 w.configureContinuationTest(false,async()=>{});
 await w.drainContinuations({requests:[{state:'queued'}]});assert.equal(requests.filter(([url])=>url.endsWith('/claim')).length,0);
 for(const [error,expected] of [['Another application is running. Your answers are saved.','busy'],['Browser response timed out','review'],['','started']]){
  w.configureContinuationTest(true,async()=>{if(error)throw Error(error);return {};});
  await w.drainContinuations({requests:[{state:'queued'}]});
  const settle=requests.filter(([url])=>url.endsWith('/continuation')).at(-1);assert.equal(settle[1].result,expected);
 }
 w.close();
});

test('saved profile fills basic field aliases while unknown and conflicting answers remain blank',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://marvelous-vitality-production-c2d8.up.railway.app/'}),w=dom.window;
 const profile={id:'p',name:'Test Applicant',location:'Toronto, Ontario, Canada',reusableAnswers:{School:'First University',University:'Second University'}};
 w.setInterval=()=>0;w.fetch=async()=>({ok:true,json:async()=>({applicants:[profile]})});w.eval(sources['extension/policy.js']);w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);
 w.renderMissingAnswers([{id:'j',applicant_id:'p',company:'Fixture',title:'Engineer',status:'local_browser',local_phase:'blocked',required_fields_json:JSON.stringify(['Given name','Country','State / Province','City','University','Do you need visa sponsorship?']),application_only_questions:['Do you need visa sponsorship?'],answers_json:'{}'}]);
 const form=w.document.querySelector('#missing-answers form');await form.querySelector('button').onclick();
 const values=Object.fromEntries([...form.querySelectorAll('textarea[data-answer-key]')].map(i=>[i.getAttribute('aria-label'),i.value]));
 assert.equal(values['Given name'],'Test');assert.equal(values.Country,'Canada');assert.equal(values['State / Province'],'Ontario');assert.equal(values.City,'Toronto');assert.equal(values.University,'','conflicting aliases must remain blank');assert.equal(values['Do you need visa sponsorship?'],'');
 w.close();
});

test('stalled browser sessions are separated from filling and receipt filters exclude placeholders',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const policy='data:text/javascript;base64,'+Buffer.from(sources['extension/policy.js']+'\nexport const receipt=globalThis.ApplyPilotPolicy.receipt;').toString('base64');
 const {applicationEvidence}=await import('data:text/javascript;base64,'+Buffer.from(sources['operation-evidence.js'].replace("'./local-policy.js'",JSON.stringify(policy))).toString('base64'));
 const stale={id:'stale',company:'Stale',title:'Engineer',status:'local_browser',local_phase:'ready',updated_at:'2026-09-01',execution_mode:'local'};
 assert(applicationEvidence(stale).stalled);assert(!applicationEvidence(stale).active);assert(applicationEvidence({...stale,updated_at:new Date().toISOString()}).active);
 const jobs=[stale,{id:'receipt',company:'Receipt',title:'Engineer',status:'submitted',confirmation:'Thank you for applying',receipt_event:1},{id:'placeholder',company:'Placeholder',title:'Engineer',status:'submitted',confirmation:'Applicant verified GitHub'}];
 const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://marvelous-vitality-production-c2d8.up.railway.app/'}),w=dom.window;
 w.setInterval=()=>0;w.fetch=async url=>({ok:true,json:async()=>{const p=String(url).replace('/api','');if(p==='/jobs')return {jobs};if(p==='/application-history')return {records:[]};if(p==='/status')return {workerOnline:true};if(p==='/operations')return {totals:{stalled:1,confirmed:1},applications:jobs.map(j=>({id:j.id,...applicationEvidence(j)})),checkedAt:new Date().toISOString()};return {requests:[],searches:[],events:[]};}});
 w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);await w.refresh(true);
 assert.equal(w.document.querySelector('#applying-count').textContent,'0');assert(w.document.querySelector('#job-stale').textContent.includes('Browser check needed'));
 w.HTMLElement.prototype.scrollIntoView=function(){};[...w.document.querySelectorAll('#operations button')].find(b=>b.textContent.includes('Receipts recorded')).click();assert(!w.document.querySelector('#job-receipt').hidden);assert(w.document.querySelector('#job-placeholder').hidden);
 [...w.document.querySelectorAll('#operations button')].find(b=>b.textContent.includes('Browser check needed')).click();assert(!w.document.querySelector('#job-stale').hidden);assert(w.document.querySelector('#job-receipt').hidden);
 [...w.document.querySelectorAll('#operations button')].find(b=>b.textContent.includes('Needs a step')).click();assert(w.document.querySelector('#job-stale').hidden,'stalled forms have a separate metric');
 w.close();
});

test('employer error pages are classified without mistaking job descriptions for errors',async()=>{
 const assert=require('node:assert/strict'),vm=require('node:vm'),ctx={URL};vm.runInNewContext(sources['extension/policy.js'],ctx);
 const f=ctx.ApplyPilotPolicy.employerPageIssue;
 assert.equal(f({title:'Greenhouse',text:"Error 503\nService Unavailable\nWe're a little lost in the weeds right now."}).code,503);
 for(const status of [500,502,503,504])assert.equal(f({status}).retryable,true);
 for(const status of [403,404,410,429])assert.equal(f({status}).retryable,false);
 assert.equal(f({text:'We are looking for an engineer who troubleshoots Error 503 Service Unavailable'}),null);
 assert.equal(f({text:'Error 503 Service Unavailable',hasForm:true}),null);
 assert.equal(f({text:'Thank you for applying'}),null);
 assert.equal(f({text:'Service Unavailable'}).code,503);
 assert.equal(f({title:'Careers',text:'Error 503\nService Unavailable'}).code,503);
});

test('content agent reports an employer outage without filling, capturing, submitting or falsely confirming',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 for(const attempted of [false,true]){
  const dom=new JSDOM('<title>Greenhouse</title><main><h1>Error 503</h1>\n<h2>Service Unavailable</h2>\n<p>We are a little lost in the weeds right now.</p></main>',{runScripts:'outside-only',url:'https://job-boards.greenhouse.io/example/jobs/42'}),w=dom.window,messages=[];
  Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  w.HTMLElement.prototype.getClientRects=()=>[{}];w.setInterval=()=>{throw Error('An error page must stop its monitor');};w.clearInterval=()=>{};
  w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);if(m.action==='packet')return {ok:true,data:{job:{title:'Fixture',attempted},profile:{},answers:{}}};if(m.action==='state')return {ok:true,data:{attempted,automatic:!attempted}};return {ok:true,data:{message:'Employer site temporarily unavailable (HTTP 503).'}};}}};
  w.eval(sources['extension/policy.js']);w.eval(sources['extension/content.js']);await new Promise(r=>setTimeout(r,35));
  assert.equal(messages.filter(m=>m.action==='site-error').length,1);
  assert(!messages.some(m=>['attempt','capture','receipt','form-opened','progress'].includes(m.action)));
  assert(w.document.querySelector('[role=status]').textContent.includes('HTTP 503'));w.close();
 }
});

test('employer retry uses one delayed GET only for a new empty page, and honours all attempt and stop guards',async()=>{
 const assert=require('node:assert/strict'),vm=require('node:vm');
 function scenario(changes={},enabled=true){
  let clock=1000000;class Clock extends Date{static now(){return clock;}}
  const url='https://job-boards.greenhouse.io/example/jobs/42',state={records:{j:{id:'j',url,tabId:3,auto:true,phase:'ready',touched:clock,safeInitialLoad:true,...changes}},enabled,automaticDefault:true,device:'fixture',queue:[]},updates=[],requests=[];
  const noop={addListener(){}},chrome={storage:{local:{get:async()=>state,set:async v=>Object.assign(state,v),setAccessLevel:async()=>{}}},runtime:{onMessage:noop,onStartup:noop,onInstalled:noop,getURL:p=>'chrome-extension://fixture/'+p},alarms:{get:async()=>({}),onAlarm:noop},tabs:{get:async()=>({id:3,url}),update:async(id,options)=>{updates.push({id,...options});},query:async()=>[{id:1}],onRemoved:noop},scripting:{executeScript:async({args})=>{requests.push(args);return [{result:{data:args[1]==='/jobs'?{jobs:[]}:args[1].endsWith('/packet')?{job:{attempted:!!state.serverAttempted}}:{ok:true}}}];}}};
  const ctx={chrome,URL,console,Date:Clock,crypto:require('node:crypto').webcrypto,importScripts(){}};
  vm.runInNewContext(sources['extension/policy.js'],ctx);vm.runInNewContext(sources['extension/background.js']+';globalThis.testHandle=handle;globalThis.testTick=tick;globalThis.testEligible=eligible;',ctx);
  const sender={tab:{id:3},url,frameId:0};
  return {state,updates,requests,ctx,send:(m={})=>ctx.testHandle({action:'site-error',code:503,empty:true,initial:true,...m},sender),advance:async()=>{clock+=61000;await ctx.testTick();},url};
 }
 let f=scenario();let result=await f.send();assert(result.message.includes('once'));assert.equal(f.updates.length,0);
 const candidate={id:'another',url:f.url.replace('42','43'),status:'queued',execution_mode:'local'};
 assert.equal(f.ctx.testEligible(candidate,f.state),false,'same employer host waits during its cooldown');
 assert.equal(f.ctx.testEligible({...candidate,url:'https://jobs.lever.co/example/other'},f.state),true,'other sites can continue');
 await f.advance();assert.equal(f.updates.length,1);assert.equal(f.updates[0].url,f.url,'fresh GET of original job URL');
 await f.send();await f.advance();assert.equal(f.updates.length,1,'repeated 503 never creates a retry loop');
 for(const changes of [{attempted:true},{safeInitialLoad:false},{safeInitialLoad:undefined},{formTouched:true},{steps:1},{auto:false},{siteRetries:1}]){
  f=scenario(changes);await f.send();await f.advance();assert.equal(f.updates.length,0,JSON.stringify(changes));
 }
 for(const message of [{code:429},{code:403},{code:404},{code:410},{empty:false},{initial:false}]){
  f=scenario();await f.send(message);await f.advance();assert.equal(f.updates.length,0,JSON.stringify(message));
 }
 f=scenario({},false);await f.send();await f.advance();assert.equal(f.updates.length,0,'paused helper never retries');
 f=scenario();await f.send();f.state.serverAttempted=true;await f.advance();assert.equal(f.updates.length,0,'fresh server attempt guard');
 f=scenario();await f.send();await f.ctx.testHandle({action:'stop'},{url:'chrome-extension://fixture/popup.html'});await f.advance();assert.equal(f.updates.length,0);assert.equal(f.state.records.j.siteRetryAt,0);
 f=scenario();await f.ctx.testHandle({action:'form-opened'},{tab:{id:3},url:f.url,frameId:0});await f.send();await f.advance();assert.equal(f.updates.length,0,'even an unfilled rendered form disables automatic reload');
});

test('hosted worker stops an HTTP 503 before inspecting or submitting a form and releases its browser',async()=>{
 const assert=require('node:assert/strict'),vm=require('node:vm'),ctx={URL};vm.runInNewContext(sources['extension/policy.js'],ctx);
 let status='running',challenge=null,closed=false,gotoCount=0;const events=[];
 const db={prepare(sql){return {get(){if(sql.includes('FROM applicants'))return {id:'p',user_id:'u',consent:1,email:'applicant@example.test',resume_path:'fixture.pdf',answers_json:'{}'};return {status,challenge};},run(...values){if(sql.startsWith('UPDATE jobs SET status=')){status=values[0];challenge=values[1];}}};}};
 const page={setDefaultTimeout(){},goto:async()=>{gotoCount++;return {status:()=>503};},waitForTimeout:async()=>{},locator(selector){if(selector==='body')return {innerText:async()=>'Error 503\nService Unavailable'};if(selector==='form,input:visible,textarea:visible,select:visible')return {count:async()=>0};throw Error('Must not inspect/fill an error page: '+selector);},isClosed:()=>false};
 const context={newPage:async()=>page,close:async()=>{closed=true;}};const browser={newContext:async()=>context};
 const code=sources['worker.js'].replace(/import\s+[^;]+;/g,'').replace(/main\(\)\.catch[\s\S]*$/,'');
 const run=new Function('db','event','now','installLibrary','installDrafts','installResearch','reusableAnswers','researchConsentWithdrawn','hostAllowed','employerPageIssue',code+';return run;')(db,(id,type,message)=>events.push({type,message}),()=>new Date().toISOString(),()=>{},()=>{},()=>{},()=>({}),()=>false,()=>true,ctx.ApplyPilotPolicy.employerPageIssue);
 await run({id:'j',user_id:'u',applicant_id:'p',url:'https://job-boards.greenhouse.io/example/jobs/42'},browser);
 assert.equal(gotoCount,1);assert.equal(status,'needs_review');assert.equal(challenge,'Employer site unavailable');assert(closed);
 assert(events.some(e=>e.message.includes('HTTP 503')));assert(!events.some(e=>['filled','submitted'].includes(e.type)));
});

function pureModule(file,bindings={}){
 const code=sources[file].replace(/^import .+;\s*$/gm,'').replace(/\bexport\s+(?=(?:async\s+)?function|const|let|class)/g,'');
 return new Function(...Object.keys(bindings),code+';return {installPipeline:typeof installPipeline==="function"?installPipeline:null,pipelineEnabled:typeof pipelineEnabled==="function"?pipelineEnabled:null,queueFoundApplications:typeof queueFoundApplications==="function"?queueFoundApplications:null,setPipeline:typeof setPipeline==="function"?setPipeline:null,pipelineStatus:typeof pipelineStatus==="function"?pipelineStatus:null,sameApplication:typeof sameApplication==="function"?sameApplication:null,priorApplication:typeof priorApplication==="function"?priorApplication:null,installRepeatGuard:typeof installRepeatGuard==="function"?installRepeatGuard:null,compensation:typeof compensation==="function"?compensation:null,jobIntelligence:typeof jobIntelligence==="function"?jobIntelligence:null,nextApplication:typeof nextApplication==="function"?nextApplication:null,nextApplicationEligible:typeof nextApplicationEligible==="function"?nextApplicationEligible:null,sourceBatch:typeof sourceBatch==="function"?sourceBatch:null,cachedJSON:typeof cachedJSON==="function"?cachedJSON:null,runSearch:typeof runSearch==="function"?runSearch:null};')(...Object.values(bindings));
}
test('posted pay preserves currency, period, pay tiers and conservative unknowns',()=>{
 const assert=require('node:assert/strict'),{compensation}=pureModule('job-intelligence.js');
 let pay=compensation({salaryRange:{currency:'CAD',interval:'hour',min:90,max:110}})[0];
 assert.equal(pay.annualMin,187200);assert.equal(pay.annualMax,228800);assert(pay.estimated);assert.equal(pay.assumption,'2,080 paid hours');
 const gh={pay_input_ranges:[{min_cents:35000000,max_cents:50000000,currency_type:'USD',title:'US salary'}]};
 assert.equal(compensation(gh).length,0,'without period, cents alone must not imply yearly');
 pay=compensation({...gh,description:'Annual salary range is shown below.'})[0];assert.equal(pay.annualMin,350000);assert(!pay.estimated);
 const multi=compensation({compensation:{compensationTiers:[{title:'Canada',components:[{compensationType:'Salary',interval:'1 YEAR',currencyCode:'CAD',minValue:100000,maxValue:150000},{compensationType:'Equity',interval:'1 YEAR',currencyCode:'CAD',minValue:10,maxValue:20}]},{title:'US',components:[{compensationType:'Salary',interval:'1 YEAR',currencyCode:'USD',minValue:90000,maxValue:130000}]}]}});
 assert.equal(multi.length,2);assert.deepEqual(multi.map(p=>p.currency),['CAD','USD']);assert.equal(multi[0].label,'Canada');
 assert.equal(compensation({description:'Competitive salary $100k - $140k'}).length,0);
 assert.equal(compensation({description:'Salary CAD 120,000–150,000 per year'})[0].annualMax,150000);
 assert.equal(compensation({salaryRange:{currency:'USD',interval:'year',min:150000,max:100000}}).length,0);
});
test('next application ranks eligible fresh strong matches and never repeats attempted jobs',()=>{
 const assert=require('node:assert/strict'),{nextApplication}=pureModule('job-intelligence.js');
 const meta={available:true,strong:true,eligibility:{eligible:true},checkedAt:new Date().toISOString()};
 const row=(id,score,changes={})=>({id,match_score:score,status:'saved',attempts:0,job_metadata_json:JSON.stringify(meta),...changes});
 const jobs=[row('attempted',100,{local_attempt_at:'2026-01-01'}),row('ineligible',99,{job_metadata_json:JSON.stringify({...meta,eligibility:{eligible:false}})}),row('submitted',100,{status:'submitted'}),row('busy',100,{attempts:1}),row('unverified',100,{job_metadata_json:'{}'}),row('stale',100,{job_metadata_json:JSON.stringify({...meta,checkedAt:'2020-01-01'})}),row('best',94),row('other',90)];
 assert.equal(nextApplication(jobs).id,'best');assert.equal(nextApplication(jobs.filter(j=>!['best','other'].includes(j.id))),null);
});
test('minute discovery rotates sources fairly and coalesces cached reads',async()=>{
 const assert=require('node:assert/strict');let reads=0;
 const {sourceBatch,cachedJSON}=pureModule('discovery.js',{fetch:async()=>{reads++;return {ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({jobs:[]})};}});
 const boards=['a','b','c','d','e','f','g'];let cursor=0,seen=new Set();
 for(let i=0;i<boards.length;i++){const b=sourceBatch(boards,cursor);assert.equal(b.boards.length,4);b.boards.forEach(x=>seen.add(x));cursor=b.next;}
 assert.equal(seen.size,7);assert.equal(sourceBatch([],0).boards.length,0);
 await Promise.all(Array.from({length:10},()=>cachedJSON('https://boards.example/jobs')));assert.equal(reads,1);
 await cachedJSON('https://boards.example/jobs');assert.equal(reads,1);
 assert(sources['discovery.js'].includes('SEARCH_INTERVAL_SECONDS=60'));
 assert(!sources['discovery.js'].includes('SEARCH_INTERVAL_HOURS'));
});
test('employer rate limits stop repeated requests during cooldown',async()=>{
 const assert=require('node:assert/strict');let reads=0;
 const {cachedJSON}=pureModule('discovery.js',{fetch:async()=>{reads++;return {ok:false,status:429,headers:{get:()=> '300'}};}});
 await assert.rejects(cachedJSON('https://boards.example/a'),/429/);
 await assert.rejects(cachedJSON('https://boards.example/b'),/cooling down/);assert.equal(reads,1);
});
test('ranked salary card is prominent and annual estimates remain explicit',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://example.com'}),w=dom.window;
 w.setInterval=()=>0;
 w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);
 w.eval("document.querySelector('#workspace').hidden=false");
 const metadata={available:true,strong:true,eligibility:{eligible:true},checkedAt:new Date().toISOString(),location:'Worldwide remote',reasons:['Strong role match'],pay:[{currency:'CAD',annualMin:187200,annualMax:228800,min:90,max:110,period:'hour',estimated:true,assumption:'2,080 paid hours'}]};
 w.eval('renderNextMatch('+JSON.stringify([{id:'match',title:'Cloud Engineer',company:'Example',url:'https://example.com/job',status:'saved',match_score:94,metadata}])+')');
 assert.equal(w.document.querySelector('#workspace').firstElementChild.id,'next-match');
 assert(w.document.querySelector('#next-match').textContent.includes('CAD 187,200–228,800 / year · estimate'));
 assert(w.document.querySelector('#next-match').textContent.includes('2,080 paid hours'));
 assert(w.document.querySelector('#next-match').textContent.includes('Apply to this match next'));w.close();
});

test('discovery updates existing pay without resetting attempts and queues every verified new eligible job',async()=>{
 const assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),{randomUUID}=require('node:crypto'),db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE applicants(id TEXT PRIMARY KEY,user_id TEXT,focus TEXT,email TEXT,resume_path TEXT,consent INTEGER);CREATE TABLE searches(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,instruction TEXT,boards_json TEXT,auto_queue INTEGER,auto_generated INTEGER,enabled INTEGER,source_cursor INTEGER DEFAULT 0,last_run TEXT,last_error TEXT,last_result_json TEXT,created_at TEXT);CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,title TEXT,company TEXT,url TEXT,normalized_url TEXT,status TEXT,notes TEXT,created_at TEXT,updated_at TEXT,attempts INTEGER DEFAULT 0,local_attempt_at TEXT,handoff_available INTEGER DEFAULT 0,challenge TEXT,job_metadata_json TEXT DEFAULT '{}',match_score INTEGER DEFAULT 0,discovery_priority INTEGER DEFAULT 5,metadata_attempt_at TEXT,UNIQUE(applicant_id,normalized_url));CREATE TABLE external_application_history(user_id TEXT,company_key TEXT,title_key TEXT);");
 const now=()=>new Date().toISOString(),key=v=>String(v).toLowerCase();db.function('history_company',key);db.function('history_title',key);
 db.prepare('INSERT INTO applicants VALUES(?,?,?,?,?,?)').run('p','u','Cloud Engineer','fixture@example.test','fixture.pdf',1);
 db.prepare('INSERT INTO searches(id,user_id,applicant_id,instruction,boards_json,auto_queue,auto_generated,enabled,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('s','u','p','Cloud Engineer; eligibility: worldwide sponsorship, remote from Canada, or B2B','["https://jobs.ashbyhq.com/example"]',1,0,1,now());
 const posting=(suffix,title,publishedAt)=>({title,location:'Worldwide remote',isRemote:true,descriptionPlain:'Work remotely from anywhere in the world.',publishedAt,jobUrl:'https://jobs.ashbyhq.com/example/12345678-1234-1234-1234-123456789ab'+suffix,compensation:{summaryComponents:[{compensationType:'Salary',currencyCode:'USD',interval:'1 YEAR',minValue:100000,maxValue:150000}]}});
 const old=posting('1','Cloud Engineer already attempted',now()),best=posting('2','Cloud Engineer best',now()),lower=posting('3','Cloud Engineer older','2020-01-01'),excluded={...posting('4','Cloud Engineer Canada',now()),location:'Toronto, Canada',descriptionPlain:'Permanent employment.'};
 db.prepare('INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,notes,created_at,updated_at,attempts,local_attempt_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('old','u','p',old.title,'example',old.jobUrl,old.jobUrl,'local_browser','Do not overwrite',now(),now(),2,'2026-01-01');
 const matchAssessment=()=>({score:95,strong:true,matched:true}),workEligibility=new Function(sources['work-eligibility.js'].replace('export function','function')+';return workEligibility;')();
 const intelligence=pureModule('job-intelligence.js',{matchAssessment,workEligibility});
 const fetch=async url=>({ok:true,headers:{get:()=>null},text:async()=>JSON.stringify(String(url).includes('/job-board/example')?{jobs:[old,best,lower,excluded]}:String(url).includes('arbeitnow')?{data:[],links:{}}:{jobs:[]})});
 const {priorApplication}=pureModule('application-dedup.js',{companyKey:key});
 const discovery=pureModule('discovery.js',{db,event:()=>{},now,normalizeURL:v=>v,randomUUID,companyKey:key,historyKey:key,matchAssessment,locationPriority:()=>5,workEligibility,...intelligence,priorApplication,pipelineEnabled:()=>false,fetch});
 const [one,two]=await Promise.all([discovery.runSearch('s','u'),discovery.runSearch('s','u')]);assert.equal(one,two);assert.equal(one.added,2);assert.equal(one.queued,2);
 const previous=db.prepare("SELECT * FROM jobs WHERE id='old'").get();assert.equal(previous.status,'local_browser');assert.equal(previous.attempts,2);assert.equal(previous.local_attempt_at,'2026-01-01');assert.equal(previous.notes,'Do not overwrite');assert(JSON.parse(previous.job_metadata_json).pay.length);
 const rows=db.prepare("SELECT title,status FROM jobs WHERE id!='old' ORDER BY title").all();assert.deepEqual(rows.map(r=>[r.title,r.status]),[[best.title,'queued'],[lower.title,'queued']]);
 assert(!db.prepare('SELECT 1 FROM jobs WHERE title=?').get(excluded.title));assert.equal(db.prepare("SELECT source_cursor FROM searches WHERE id='s'").get().source_cursor,4);db.close();
});

test('Gemini browser handoff uses public questions only, preserves user answers and never bypasses continuation checks',async()=>{
 const assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
 const googleCode=sources['google-research.js'].replace(/^import .+;\s*$/gm,'').replace(/\bexport\s+(?=(?:async\s+)?function|const)/g,'');
 const {canResearchQuestion,markResearchDraftUsed}=new Function(googleCode+';return {canResearchQuestion,markResearchDraftUsed};')();
 const source=sources['public-answer-fill.js'].replace(/^import .+;\s*$/gm,'').replace(/\bexport\s+(?=(?:async\s+)?function|const)/g,'');
 const publicFill=new Function('canResearchQuestion','researchForJob','markResearchDraftUsed','requestContinuation','researchConsentWithdrawn',source+';return {installPublicFill,fillPublicQuestions,publicFillStatus};')(canResearchQuestion,()=>{},()=>true,()=>{},()=>false);
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE applicants(id TEXT,user_id TEXT,name TEXT,consent INTEGER,google_research_consent INTEGER,ai_consent INTEGER,answers_json TEXT);CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,company TEXT,title TEXT,status TEXT,local_phase TEXT,local_attempt_at TEXT,handoff_available INTEGER,required_fields_json TEXT,answers_json TEXT,updated_at TEXT);CREATE TABLE events(job_id TEXT,at TEXT,type TEXT,message TEXT);");
 db.prepare('INSERT INTO applicants VALUES(?,?,?,?,?,?,?)').run('p','u','Tester',1,1,0,'{}');
 const q='What products does this company offer?',personal='Tell us about your experience',legal='Do you consent to a criminal background check?';
 db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('j','u','p','Example','Engineer','local_browser','blocked',null,0,JSON.stringify([q,personal,legal]),'{}',new Date().toISOString());
 publicFill.installPublicFill(db);let calls=0,continuations=0;
 let result=await publicFill.fillPublicQuestions(db,'j',{env:{GEMINI_API_KEY:'fixture'},research:async(_db,uid,id,question)=>{calls++;assert.equal(question,q);assert.equal(uid,'u');return {answer:'Public-page answer',citations:[{url:'https://example.test/job'}]};},continueJob:()=>{continuations++;throw Error('A declaration needs the user');}});
 assert.equal(calls,1);assert.equal(result.filled,1);assert.equal(continuations,1);
 assert.deepEqual(JSON.parse(db.prepare("SELECT answers_json FROM jobs WHERE id='j'").get().answers_json),{[q]:'Public-page answer'});
 assert.equal(db.prepare("SELECT local_phase FROM jobs WHERE id='j'").get().local_phase,'blocked');
 await publicFill.fillPublicQuestions(db,'j',{env:{GEMINI_API_KEY:'fixture'},research:async()=>{throw Error('Should not request a saved question');}});assert.equal(calls,1);
 db.prepare("UPDATE jobs SET answers_json='{}',local_attempt_at='attempted' WHERE id='j'").run();
 assert.equal((await publicFill.fillPublicQuestions(db,'j',{env:{GEMINI_API_KEY:'fixture'},research:async()=>{calls++;}})).filled,0);assert.equal(calls,1);
 db.prepare("UPDATE jobs SET local_attempt_at=NULL WHERE id='j'").run();db.exec('DELETE FROM public_fill_attempts');
 result=await publicFill.fillPublicQuestions(db,'j',{env:{GEMINI_API_KEY:'fixture'},research:async()=>{db.prepare("UPDATE jobs SET answers_json=? WHERE id='j'").run(JSON.stringify({[q]:'My own answer'}));return {answer:'Late draft'};}});
 assert.equal(result.filled,0);assert.equal(JSON.parse(db.prepare("SELECT answers_json FROM jobs WHERE id='j'").get().answers_json)[q],'My own answer');
 db.prepare("UPDATE jobs SET answers_json='{}' WHERE id='j'").run();db.exec('DELETE FROM public_fill_attempts');
 await publicFill.fillPublicQuestions(db,'j',{env:{GEMINI_API_KEY:'fixture'},research:async()=>{throw Error('Google research returned HTTP 429.');}});
 const status=publicFill.publicFillStatus(db,'u',{GEMINI_API_KEY:'secret-fixture'});assert(status.googleConfigured);assert.equal(status.attempts[0].message,'Google research returned HTTP 429.');assert(!JSON.stringify(status).includes('secret-fixture'));
 assert.equal(publicFill.publicFillStatus(db,'other',{}).attempts.length,0);
 let retries=0;await publicFill.fillPublicQuestions(db,'j',{env:{GEMINI_API_KEY:'fixture'},research:async()=>{retries++;}});assert.equal(retries,0,'provider errors back off for one hour');
 db.close();
});

test('recommendations include eligible related roles for review while automatic queue stays strong-only',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://example.com'}),w=dom.window;w.setInterval=()=>0;w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);
 const metadata={available:true,strong:false,matched:true,eligibility:{eligible:true},checkedAt:new Date().toISOString(),location:'London',reasons:['Related role match','Posting states visa sponsorship'],pay:[]};
 w.eval('renderNextMatch('+JSON.stringify([{id:'related',title:'Staff Infrastructure Engineer',company:'Example',url:'https://example.com/job',status:'saved',match_score:70,metadata}])+')');
 assert(w.document.querySelector('#next-match').textContent.includes('review the required seniority'));
 assert.equal(pureModule('job-intelligence.js').nextApplication([{id:'related',status:'saved',job_metadata_json:JSON.stringify(metadata)}]),null);
 w.close();
 const boardSource=sources['discovery.js'].slice(sources['discovery.js'].indexOf('async function listBoard'),sources['discovery.js'].indexOf('const defaultBoards'));
 const board=new Function('cachedJSON','readJSON',boardSource+';return listBoard;')(async()=>({jobs:[{title:'Private posting',isListed:false,jobUrl:'https://jobs.ashbyhq.com/example/12345678-1234-1234-1234-123456789abc'}]}),()=>{});
 assert.equal((await board('https://jobs.ashbyhq.com/example')).length,0);
 assert.equal((await board('https://jobs.ashbyhq.com/example',{includeUnlisted:true})).length,1,'manual tracked private postings are not mistaken for removed jobs');
});

test('normal dashboard refresh loads Gemini diagnostics without exposing credentials',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict'),dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://example.com'}),w=dom.window;
 w.sessionStorage.setItem('applypilot-token','fixture');w.setInterval=()=>0;const calls=[];
 w.fetch=async url=>({ok:true,json:async()=>{const p=String(url).replace('/api','');calls.push(p);if(p==='/jobs')return {jobs:[]};if(p==='/application-history')return {records:[]};if(p==='/ai-status')return {googleConfigured:true,personalDraftsConfigured:false,profiles:[{name:'Tester',googleConsent:true,hasBackground:false}],attempts:[{company:'Example',question:'What products does this company offer?',message:'Google research returned HTTP 429.'}]};if(p==='/searches')return {searches:[]};return {};}});
 w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);await new Promise(r=>setTimeout(r,100));
 assert(calls.includes('/ai-status'));const text=w.document.querySelector('#ai-status').textContent;
 assert(text.includes('Gemini key configured'));assert(text.includes('Professional background not yet saved'));assert(text.includes('HTTP 429'));assert(!text.includes('Bearer fixture'));w.close();
});

test('resume editor escapes content, restricts ownership, preserves prior file and rejects stale drafts',async()=>{
 const assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),{createHash,randomUUID}=require('node:crypto');
 const src=sources['resume-editor.js'].replace(/^import .+;\s*$/gm,'').replace(/\bexport\s+(?=(?:async\s+)?function|const)/g,'');
 const fail=()=>{throw Error('Unexpected filesystem access')};
 const editor=new Function('createHash','randomUUID','promisify','execFile','readFile','writeFile','mkdir','mkdtemp','rm','tmpdir','join','chromium',src+';return {resumeHTML,installResumeEditor,prepareResumeEdit,saveResumeEdit,previousResumePath};')(createHash,randomUUID,()=>fail,fail,fail,fail,fail,fail,fail,()=>'/tmp',require('node:path').join,{});
 const html=editor.resumeHTML('# Candidate\nSenior Platform Engineer\n## Experience\n- '+('<script>unsafe & bad</script> '.repeat(10)));
 assert(html.includes('&lt;script&gt;'));assert(!html.includes('<script>unsafe'));assert.throws(()=>editor.resumeHTML('short'),/200/);assert.throws(()=>editor.resumeHTML(('x'.repeat(201)+'\n---\n').repeat(4)),/three/);
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE applicants(id TEXT PRIMARY KEY,user_id TEXT,name TEXT,resume_path TEXT);CREATE TABLE jobs(id TEXT,status TEXT);INSERT INTO applicants VALUES(\'p\',\'u\',\'Candidate\',\'old.docx\');INSERT INTO jobs VALUES(\'j\',\'submitted\')');editor.installResumeEditor(db);
 const memory=new Map([['old.docx',Buffer.from('original')]]),read=async p=>memory.get(p),write=async(p,b)=>memory.set(p,b),makeDir=async()=>{};
 const render=async()=>({pdf:Buffer.from('%PDF-revised'),text:'Revised text',images:['page']});
 await assert.rejects(editor.prepareResumeEdit(db,'intruder','p','text',{render,read}),/Applicant/);
 const draft=await editor.prepareResumeEdit(db,'u','p','text',{render,read});
 await assert.rejects(editor.saveResumeEdit(db,'intruder','p',draft.draftId,'/data',{read,write,makeDir}),/expired/);
 const result=await editor.saveResumeEdit(db,'u','p',draft.draftId,'/data',{read,write,makeDir});
 assert(result.previousSaved);assert.equal(editor.previousResumePath(db,'u','p'),'old.docx');assert.equal(editor.previousResumePath(db,'intruder','p'),null);assert.equal(memory.get('old.docx').toString(),'original');assert.equal(memory.get(db.prepare('SELECT resume_path FROM applicants').get().resume_path).toString(),'%PDF-revised');assert.equal(db.prepare('SELECT status FROM jobs').get().status,'submitted');
 await assert.rejects(editor.saveResumeEdit(db,'u','p',draft.draftId,'/data',{read,write,makeDir}),/expired/);
 const stale=await editor.prepareResumeEdit(db,'u','p','text',{render,read});db.exec("UPDATE applicants SET resume_path='changed.pdf'");await assert.rejects(editor.saveResumeEdit(db,'u','p',stale.draftId,'/data',{read,write,makeDir}),/changed/);db.close();
});
test('needs-input numbering is stable, deduplicated, excludes completed jobs, and renders in extension popup',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const jobs=[{id:'two',title:'Platform',company:'B',status:'paused',created_at:'2026-02-01'},{id:'done',title:'Done',status:'submitted',local_phase:'blocked'},{id:'one',title:'SRE',company:'A',status:'local_browser',local_phase:'blocked',created_at:'2026-01-01'},{id:'queued',title:'Queued',status:'queued'}, {id:'one',status:'paused'}];
 const dom=new JSDOM(sources['extension/popup.html'],{runScripts:'outside-only'}),w=dom.window;
 w.chrome={runtime:{sendMessage:async()=>({ok:true,data:{jobs,state:{environment:'hosted',enabled:false,queue:[]}}})}};
 w.eval(sources['extension/policy.js']);assert.deepEqual(Array.from(w.ApplyPilotPolicy.attentionOrder(jobs),j=>j.id),['one','two']);
 w.eval(sources['extension/popup.js']);await new Promise(r=>setTimeout(r,10));
 assert.deepEqual(Array.from(w.document.querySelectorAll('.attention-position'),n=>n.textContent),['1/2 · Needs your input','2/2 · Needs your input']);assert(w.document.querySelector('#jobs').textContent.includes('2 applications need your input'));dom.window.close();
});
test('resume editor previews before save and invalidates edited drafts',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const dom=new JSDOM(sources['web/setup.html'],{runScripts:'outside-only',url:'https://app.test/setup'}),w=dom.window;
 w.HTMLElement.prototype.scrollIntoView=()=>{};const writes=[];
 w.fetch=async(url,opts={})=>{const data=opts.body?JSON.parse(opts.body):null;if(data)writes.push(data);
 const result=String(url).endsWith('/resume-edit')?(data.action==='preview'?{draftId:'draft',pages:['AA=='],name:'Resume.pdf'}:{ok:true,name:'Resume.pdf',previousSaved:true}):String(url).endsWith('/resume')?{text:'Old resume'}:{applicants:[{id:'p',name:'Candidate',email:'a@example.test',has_resume:true,answers:{}}]};
 return {ok:true,json:async()=>result};
 };
 w.sessionStorage.setItem('applypilot-token','fixture');w.eval(sources['web/setup.js']);await new Promise(r=>setTimeout(r,10));
 w.document.querySelector('#profiles').value='p';w.document.querySelector('#profiles').dispatchEvent(new w.Event('change'));w.document.querySelector('#current-resume .secondary').click();await new Promise(r=>setTimeout(r,10));
 const area=w.document.querySelector('#resume-editor-text');area.value='Revision';area.dispatchEvent(new w.Event('input'));assert(w.document.querySelector('#save-edited-resume').disabled);
 w.document.querySelector('#preview-edited-resume').click();await new Promise(r=>setTimeout(r,10));assert(!w.document.querySelector('#save-edited-resume').disabled);assert.equal(w.document.querySelectorAll('#resume-editor-pages img').length,1);
 area.value='Edited again';area.dispatchEvent(new w.Event('input'));assert(w.document.querySelector('#save-edited-resume').disabled);assert(!writes.some(x=>x.action==='save'));dom.window.close();
});

test('attention counters share operation evidence while linked employer tabs receive only their position',async()=>{
 const assert=require('node:assert/strict'),vm=require('node:vm');
 const state={automaticDefault:true,device:'fixture',records:{second:{id:'second',tabId:8,url:'https://jobs.lever.co/example/second'}},queue:[],enabled:false};
 const jobs=[{id:'first',status:'paused',created_at:'2026-01-01'},{id:'second',status:'local_browser',created_at:'2026-01-02'},{id:'done',status:'submitted',local_phase:'blocked'}];
 const noOp={addListener(){}},chrome={storage:{local:{get:async()=>state,set:async v=>Object.assign(state,v),setAccessLevel:async()=>{}}},tabs:{query:async()=>[{id:4}],onRemoved:noOp},scripting:{executeScript:async({args})=>[{result:{data:args[1]==='/jobs'?{jobs}:{applications:[{id:'second',stalled:true}]}}}]},runtime:{getURL:p=>'chrome-extension://fixture/'+p,onMessage:noOp,onStartup:noOp,onInstalled:noOp},alarms:{get:async()=>({}),onAlarm:noOp}};
 const c={chrome,URL,console,Date,crypto:require('node:crypto').webcrypto,importScripts(){}};
 vm.runInNewContext(sources['extension/policy.js'],c);vm.runInNewContext(sources['extension/background.js']+';globalThis.testHandle=handle;',c);
 const popup=await c.testHandle({action:'list'},{url:'chrome-extension://fixture/popup.html'});
 assert.equal(popup.jobs.find(j=>j.id==='second').evidence.stalled,true);
 const result=await c.testHandle({action:'attention-position'},{tab:{id:8},frameId:0,url:'https://jobs.lever.co/example/second'});
 assert.equal(result.position,2);assert.equal(result.total,2);assert.deepEqual(Object.keys(result).sort(),['position','total']);
 await assert.rejects(c.testHandle({action:'attention-position'},{tab:{id:9},frameId:0,url:'https://jobs.lever.co/example/unrelated'}),/not linked/);
 assert(sources['extension/content.js'].includes("send('attention-position')"));
 assert(!sources['extension/content.js'].includes("send('list')"));
 const {JSDOM}=require('jsdom'),dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://example.test'}),w=dom.window;
 w.setInterval=()=>0;w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);
 w.eval('renderBrowserReadiness([{execution_mode:"local"}])');assert(w.document.body.textContent.includes('0.6.4'));w.close();
});

test("Gemini live diagnostic is authenticated, scoped, rate limited and cannot submit",async()=>{
 const assert=require('node:assert/strict'),vm=require('node:vm'),context=vm.createContext({process,Date,Map,JSON,String,Error});
 const deps={'./google-research.js':{canResearchQuestion:()=>true,researchForJob:()=>{},markResearchDraftUsed:()=>{}},'./continuation-queue.js':{requestContinuation:()=>{throw Error('must not continue')}},'./research-consent.js':{researchConsentWithdrawn:()=>false}};
 const mod=new vm.SourceTextModule(sources['public-answer-fill.js'],{context});
 await mod.link(async spec=>{const values=deps[spec];return new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v)},{context});});await mod.evaluate();
 let queries=[],calls=0,now=100000,selected=true;
 const db={prepare(sql){queries.push(sql);return{get(uid){assert(sql.includes('j.user_id=?'));assert(sql.includes('p.google_research_consent=1'));assert.equal(uid,'diagnostic-user');return selected?{id:'job-1',company:'Example',title:'Engineer'}:undefined;}}}};
 const options={env:{GEMINI_API_KEY:'fixture-only',GEMINI_MODEL:'test-model'},clock:()=>now,research:async(d,uid,id,q,o)=>{calls++;assert.equal(d,db);assert.equal(uid,'diagnostic-user');assert.equal(id,'job-1');assert.equal(q,'What are the responsibilities of this role?');assert.equal(o.env.GEMINI_MODEL,'test-model');return{answer:'Maintain systems.',citations:[{url:'https://example.org/jobs/1',title:'Engineer'}]};}};
 await assert.rejects(mod.namespace.testPublicDrafting(db,'diagnostic-user',{...options,env:{}}),/no server key/);assert.equal(calls,0);
 const result=await mod.namespace.testPublicDrafting(db,'diagnostic-user',options);assert.equal(result.ok,true);assert.equal(result.model,'test-model');assert.equal(calls,1);assert(!JSON.stringify(result).includes('fixture-only'));
 await assert.rejects(mod.namespace.testPublicDrafting(db,'diagnostic-user',options),/one minute/);assert.equal(calls,1);
 now+=60001;selected=false;await assert.rejects(mod.namespace.testPublicDrafting(db,'diagnostic-user',options),/Enable Google/);
 selected=true;await assert.rejects(mod.namespace.testPublicDrafting(db,'diagnostic-user',{...options,research:async()=>({answer:null,reason:'No source context'})}),/No source context/);
 assert(queries.every(q=>q.startsWith('SELECT ')));
 const server=sources['server.js'];assert(server.indexOf("if(path==='/api/ai-test'")>server.indexOf("if(!uid)return send(res,401"));
});

test("Gemini diagnostic button sends POST and displays the verified response",async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://example.test'}),w=dom.window;
 w.setInterval=()=>0;w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);
 const calls=[];w.fetch=async(url,opts={})=>{calls.push({url,opts});return{ok:true,json:async()=>url.endsWith('/ai-test')?{ok:true,model:'verified-model',company:'Example',title:'Engineer',checkedAt:'2026-10-01T20:00:00Z',answer:'Maintain systems.',citations:[{title:'Job',url:'https://example.org/job'}]}:{googleConfigured:true,profiles:[],attempts:[]}};};
 await w.eval('updateAIStatus()');
 const button=[...w.document.querySelectorAll('#ai-status button')].find(b=>b.textContent==='Test Gemini on a public job page');assert(button);
 await button.onclick();assert.equal(calls.find(c=>c.url.endsWith('/ai-test')).opts.method,'POST');assert(w.document.querySelector('#ai-status').textContent.includes('Gemini test passed · verified-model'));assert(w.document.querySelector('#ai-status').textContent.includes('This test did not fill or submit an application.'));assert.equal(button.disabled,false);w.close();
});

test("Gemini duplicate retrieval records are accepted only for the same verified public page",async()=>{
 const assert=require('node:assert/strict');
 const source=sources['google-research.js'].replace(/^import .+;\s*$/gm,'').replace(/\bexport\s+(?=(?:async\s+)?function|const)/g,'');
 const {researchAnswer}=new Function('isIP','Buffer','AbortSignal',source+';return {researchAnswer};')(require('node:net').isIP,Buffer,AbortSignal);
 const url='https://boards.greenhouse.io/example/jobs/1234?gh_jid=1234',canonical='https://job-boards.greenhouse.io/example/jobs/1234';let answer='Maintain reliable infrastructure.',prefix='';
 let records=[{url,status:'success'},{url:canonical,status:'success'}],isError=false;
 const options={question:'What are the responsibilities of this role?',job:{url},env:{GEMINI_API_KEY:'fixture-only'},fetchImpl:async(endpoint,options)=>{
  const body=JSON.parse(options.body);assert.equal(body.model,'gemini-3.5-flash-lite');assert.equal(body.store,false);assert.deepEqual(body.tools,[{type:'url_context'}]);
  return{ok:true,json:async()=>({status:'completed',steps:[{type:'url_context_call',id:'call-1',arguments:{urls:[url]}},{type:'url_context_result',call_id:'call-1',is_error:isError,result:records},{type:'model_output',content:[{type:'text',text:prefix+answer,annotations:[{type:'url_citation',url,title:'Job',start_index:Buffer.byteLength(prefix),end_index:Buffer.byteLength(prefix+answer)}]}]}]})};
 }};
 const result=await researchAnswer(options);assert.equal(result.answer,answer);assert.equal(result.citations.length,1);
 prefix='This uncited introduction must not enter the form. ';assert.equal((await researchAnswer(options)).answer,answer);prefix='';
 records=[{url,status:'error'},{url:canonical,status:'success'}];assert.equal((await researchAnswer(options)).answer,answer);
 records=[{url,status:'error'}];await assert.rejects(researchAnswer(options),/all retrieval attempts failed/);
 records=[{url,status:'success'},{url:'https://other.example/jobs/1234',status:'success'}];await assert.rejects(researchAnswer(options),/different page/);
 records=[{url,status:'success'},{url,status:'unsafe'}];await assert.rejects(researchAnswer(options),/unsafe/);
 records=[];await assert.rejects(researchAnswer(options),/did not retrieve/);
 records=[{url,status:'success'}];isError=true;await assert.rejects(researchAnswer(options),/did not retrieve/);
});

test("expanded explicit work eligibility remains conservative",async()=>{
 const assert=require('node:assert/strict'),{workEligibility:f}=await import('data:text/javascript;base64,'+Buffer.from(sources['work-eligibility.js']).toString('base64'));
 for(const description of ['Visa sponsorship and relocation assistance for people moving to Sydney.','Visa Sponsorship & relocation support.','Visa sponsorship: Available'])assert.equal(f({location:'Sydney',description}).eligible,true,description);
 for(const description of ['Contract type: B2B','This role is offered on a B2B/contractor basis.'])assert.equal(f({location:'Remote International',description}).eligible,true,description);
 for(const description of ['B2B contract. US citizenship is required.','B2B contract. Must be based in Europe.','Visa Sponsorship Available: No','No visa sponsorship and relocation assistance.'])assert.equal(f({location:'Remote - US',description}).eligible,false,description);
 assert.equal(f({location:'Toronto',description:'Permanent employment. Visa sponsorship and relocation support.'}).eligible,false);
 assert.equal(f({location:'Canada',description:'B2B SaaS product company.'}).eligible,false);
});
test('repeat guards recognise board aliases and annotated titles without losing receipts',()=>{
 const assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(':memory:');
 const {sameApplication,installRepeatGuard,priorApplication}=pureModule('application-dedup.js',{companyKey:v=>String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'')});
 const original={company:'Thinking Machines Lab',title:'Infrastructure Engineer, Security — San Francisco; sponsorship',url:'https://jobs.ashbyhq.com/thinkingmachines/11111111-1111-1111-1111-111111111111'};
 const repost={company:'thinkingmachines',title:'Infrastructure Engineer, Security',url:'https://jobs.ashbyhq.com/thinkingmachines/22222222-2222-2222-2222-222222222222/application'};
 assert(sameApplication(original,repost));assert(!sameApplication(original,{...repost,title:'Site Reliability Engineer, Production'}));assert(!sameApplication(original,{...repost,company:'other',url:'https://jobs.ashbyhq.com/other/33333333-3333-3333-3333-333333333333'}));
 assert(sameApplication({...original,title:'old',url:repost.url.replace('/application','')},{...repost,title:'new'}));
 db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,title TEXT,company TEXT,url TEXT,status TEXT,local_attempt_at TEXT,attempts INTEGER DEFAULT 0,handoff_available INTEGER DEFAULT 0,created_at TEXT,updated_at TEXT,challenge TEXT,confirmation TEXT)");
 const add=(id,u,j,status)=>db.prepare('INSERT INTO jobs(id,user_id,title,company,url,status,created_at,confirmation) VALUES(?,?,?,?,?,?,?,?)').run(id,u,j.title,j.company,j.url,status,'2026-10-01','Receipt retained');
 add('receipt','u',original,'submitted');add('duplicate','u',repost,'saved');add('other-user','v',repost,'saved');
 installRepeatGuard(db);
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id='duplicate'").get().status,'duplicate');
 assert.equal(db.prepare("SELECT confirmation FROM jobs WHERE id='receipt'").get().confirmation,'Receipt retained');
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id='other-user'").get().status,'saved');
 assert.throws(()=>db.prepare("UPDATE jobs SET status='queued' WHERE id='duplicate'").run(),/repeat application blocked/);
 assert.throws(()=>db.prepare("UPDATE jobs SET local_attempt_at='now' WHERE id='duplicate'").run(),/repeat submission blocked/);
 add('new-duplicate','u',repost,'saved');assert.equal(db.prepare("SELECT status FROM jobs WHERE id='new-duplicate'").get().status,'duplicate');
 add('new-role','u',{...repost,title:'Site Reliability Engineer, Production'},'saved');assert.equal(priorApplication(db,'u',db.prepare("SELECT * FROM jobs WHERE id='new-role'").get()),null);
 db.prepare("UPDATE jobs SET status='queued' WHERE id='new-role'").run();db.close();
});

test('full found pipeline is ranked, scoped, durable, idempotent and protects prior work',()=>{
 const assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE applicants(id TEXT PRIMARY KEY,user_id TEXT,consent INTEGER,email TEXT,resume_path TEXT); CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,status TEXT,company TEXT,title TEXT,url TEXT,challenge TEXT,local_attempt_at TEXT,attempts INTEGER DEFAULT 0,handoff_available INTEGER DEFAULT 0,match_score INTEGER DEFAULT 0,created_at TEXT,updated_at TEXT,job_metadata_json TEXT DEFAULT '{}'); CREATE TABLE events(id INTEGER PRIMARY KEY,job_id TEXT,at TEXT,type TEXT,message TEXT); CREATE TABLE external_application_history(user_id TEXT,company_key TEXT,title_key TEXT); CREATE TABLE work_focus(user_id TEXT,enabled INTEGER,job_id TEXT);");
 const key=v=>String(v).toLowerCase().replace(/[^a-z0-9]/g,''),{priorApplication,installRepeatGuard}=pureModule('application-dedup.js',{companyKey:key});
 const pipeline=pureModule('application-pipeline.js',{priorApplication,companyKey:key,historyKey:key,supported:v=>v.startsWith('https://jobs.ashbyhq.com/'),metadataFor:j=>JSON.parse(j.job_metadata_json),researchConsentWithdrawn:()=>false});
 pipeline.installPipeline(db);installRepeatGuard(db);
 db.exec("INSERT INTO applicants VALUES('p','u',1,'fixture@example.test','fixture.pdf'),('q','other',1,'other@example.test','fixture.pdf'),('missing','u',0,'','');INSERT INTO work_focus VALUES('u',1,'top')");
 const add=(id,{user='u',profile='p',status='saved',score=1,attempt=null,attempts=0,handoff=0,challenge=null,meta={},title=id,url='https://jobs.ashbyhq.com/company/'+id}={})=>db.prepare("INSERT INTO jobs(id,user_id,applicant_id,status,company,title,url,match_score,local_attempt_at,attempts,handoff_available,challenge,job_metadata_json,created_at) VALUES(?,?,?,?,'Company',?,?,?,?,?,?,?,?,?)").run(id,user,profile,status,title,url,score,attempt,attempts,handoff,challenge,JSON.stringify(meta),'2026-10-01');
 add('top',{score:99});add('related',{score:30,meta:{strong:false,checkedAt:'2020-01-01'}});add('unscored');add('closed',{meta:{available:false}});add('unsupported',{url:'https://example.com/job'});add('attempted',{attempt:'2026-01-01'});add('worked',{attempts:1});add('held',{handoff:1});add('missing',{profile:'missing'});add('imported');db.exec("INSERT INTO external_application_history VALUES('u','company','imported')");add('outside',{user:'other',profile:'q'});add('done',{status:'submitted'});add('blocked',{status:'needs_review'});
 assert.equal(pipeline.pipelineEnabled(db,'u'),false);const outcome=pipeline.setPipeline(db,'u',true);
 assert.equal(outcome.result.queued,3);assert.equal(outcome.result.held,6);assert.equal(outcome.result.duplicates,1);
 assert.deepEqual(outcome.result.applications.filter(j=>j.status==='queued').map(j=>j.id),['top','related','unscored']);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE user_id='u' AND status='saved'").get().n,0);
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id='outside'").get().status,'saved');
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id='done'").get().status,'submitted');
 assert.equal(db.prepare("SELECT local_attempt_at FROM jobs WHERE id='attempted'").get().local_attempt_at,'2026-01-01');
 assert.equal(db.prepare("SELECT COUNT(*) n FROM work_focus").get().n,0);
 assert.equal(pipeline.queueFoundApplications(db,'u').queued,0);
 add('newlater');assert.equal(pipeline.queueFoundApplications(db,'u').queued,1);
 pipeline.setPipeline(db,'u',false);assert.equal(pipeline.pipelineEnabled(db,'u'),false);assert.equal(db.prepare("SELECT status FROM jobs WHERE id='top'").get().status,'queued');
 db.close();
});
test('completion methods require receipts and complete tracking; human help wins without recounting outcomes',async()=>{
 const assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
 const policy='data:text/javascript;base64,'+Buffer.from(sources['extension/policy.js']+'\nexport const receipt=globalThis.ApplyPilotPolicy.receipt;').toString('base64');
 const {operationSnapshot}=await import('data:text/javascript;base64,'+Buffer.from(sources['operation-evidence.js'].replace("'./local-policy.js'",JSON.stringify(policy))).toString('base64'));
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE jobs(id TEXT,user_id TEXT,company TEXT,title TEXT,url TEXT,status TEXT,confirmation TEXT,local_phase TEXT,local_attempt_at TEXT,updated_at TEXT); CREATE TABLE events(id INTEGER PRIMARY KEY,job_id TEXT,type TEXT,message TEXT); CREATE TABLE answer_history(job_id TEXT);');
 const add=(id,events,{status='submitted',confirmation='Thank you for applying',user='owner'}={})=>{db.prepare("INSERT INTO jobs(id,user_id,status,confirmation) VALUES(?,?,?,?)").run(id,user,status,confirmation);for(const [type,message=''] of events)db.prepare('INSERT INTO events(job_id,type,message) VALUES(?,?,?)').run(id,type,message);};
 add('auto',[['completion_tracking'],['automatic_submission'],['submitted']]);
 add('help',[['completion_tracking'],['answer_saved'],['automatic_submission'],['submitted']]);
 add('manual',[['manual_submission'],['submitted']]);
 add('recorded',[['manual_confirmation']]);
 add('old',[['submitted']]);
 add('untracked-auto',[['automatic_submission'],['submitted']]);
 add('review',[['completion_tracking'],['assistance_boundary'],['automatic_submission'],['submitted']]);
 add('placeholder',[['completion_tracking'],['automatic_submission'],['submitted']],{confirmation:'Placeholder: Thank you for applying'});
 add('attempt',[['completion_tracking'],['automatic_submission'],['submission_started']],{status:'local_browser',confirmation:null});
 add('other',[['completion_tracking'],['automatic_submission'],['submitted']],{user:'someone-else'});
 // A later edit or employer outcome cannot change historical completion attribution.
 db.exec("INSERT INTO events(job_id,type,message) VALUES('auto','answer_saved','After receipt'); UPDATE jobs SET status='interview' WHERE id='auto';");
 const r=operationSnapshot(db,'owner');assert.equal(r.totals.confirmed,7);assert.equal(r.totals.automatic,1);assert.equal(r.totals.assisted,3);assert.equal(r.totals.unknown,3);assert.equal(r.totals.confirmed,r.totals.automatic+r.totals.assisted+r.totals.unknown);
 assert.equal(r.applications.find(j=>j.id==='placeholder').completion,null);assert.equal(r.applications.find(j=>j.id==='attempt').completion,null);
 db.close();
});
test('dashboard shows completion groups, filters them and enables all-found queueing via an authenticated mutation',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://example.com'}),w=dom.window;w.setInterval=()=>0;w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);w.HTMLElement.prototype.scrollIntoView=()=>{};
 const jobs=[{id:'auto',company:'A',title:'Cloud Engineer'},{id:'help',company:'B',title:'SRE'},{id:'old',company:'C',title:'Platform Engineer'}],snapshot={totals:{confirmed:3,automatic:1,assisted:1,unknown:1},applications:[{id:'auto',completion:'automatic'},{id:'help',completion:'assisted'},{id:'old',completion:'unknown'}],checkedAt:new Date().toISOString()};
 w.eval('renderOperations('+JSON.stringify(snapshot)+',{events:[]},'+JSON.stringify(jobs)+')');
 assert.equal(w.document.querySelectorAll('#completion-breakdown [data-completion]').length,3);assert.equal(w.document.querySelectorAll('#completion-breakdown li').length,3);
 const cards=w.document.querySelector('#jobs');for(const j of snapshot.applications){const card=w.document.createElement('article');card.dataset.completion=j.completion;card.dataset.search=j.id;cards.append(card);}
 w.document.querySelector('[data-completion=assisted]').click();assert.deepEqual([...cards.children].map(c=>c.hidden),[true,false,true]);
 const calls=[];w.pipelineCalls=calls;w.eval("api=async(path,method,input)=>{pipelineCalls.push({path,method,input});return {result:{queued:7,held:1,duplicates:2}}};refresh=async()=>{};renderPipeline({enabled:false,found:10});");
 w.document.querySelector('#application-pipeline .primary').click();await new Promise(r=>setTimeout(r,10));
 assert.equal(calls[0].path,'/pipeline');assert.equal(calls[0].method,'PUT');assert.equal(calls[0].input.enabled,true);assert(w.document.querySelector('#notice').textContent.includes('7 queued'));
 w.close();
});

test('completion groups preserve a ranked browser pipeline including already queued jobs',async()=>{
 const assert=require('node:assert/strict'),vm=require('node:vm');
 const state={records:{},queue:['low'],enabled:true},opened=[];
 const jobs=[{id:'low',match_score:10,status:'queued',execution_mode:'local',url:'https://jobs.lever.co/x/low'},{id:'high',match_score:90,status:'queued',execution_mode:'local',url:'https://jobs.lever.co/x/high'}];
 const noop={addListener(){}},chrome={storage:{local:{get:async()=>state,set:async v=>Object.assign(state,v)}},tabs:{onRemoved:noop},runtime:{onMessage:noop,onStartup:noop,onInstalled:noop},alarms:{onAlarm:noop}};
 const context={chrome,URL,console,Date,importScripts(){},ApplyPilotPolicy:{supported:()=>true},fixtureJobs:jobs,opened};
 vm.runInNewContext(sources['extension/background.js']+';api=async()=>({jobs:fixtureJobs});openJob=async(id)=>opened.push(id);globalThis.testTick=tick;',context);
 await context.testTick();assert.deepEqual(opened,['high']);assert.deepEqual(Array.from(state.queue),['low']);
});

test('completion groups next application reflects the actual approved queue even without fresh discovery metadata',()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://example.com'}),w=dom.window;w.setInterval=()=>0;w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);
 const jobs=[{id:'saved',title:'High saved',company:'A',status:'saved',match_score:99,metadata:{available:true,strong:true,eligibility:{eligible:true},checkedAt:new Date().toISOString()}},{id:'queued',title:'Actual next queued',company:'B',status:'queued',match_score:70,url:'https://jobs.lever.co/b/123'},{id:'attempted',title:'Attempted',company:'C',status:'queued',match_score:100,local_attempt_at:'now'}];
 w.eval('renderNextMatch('+JSON.stringify(jobs)+')');const text=w.document.querySelector('#next-match').textContent;assert(text.includes('Actual next queued'));assert(text.includes('Queued for your application worker'));assert(!text.includes('High saved'));assert(!text.includes('Attempted'));w.close();
});
