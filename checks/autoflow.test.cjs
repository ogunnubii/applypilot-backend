const {test}=require('node:test');
const fs=require('node:fs'),path=require('node:path');
const sources=Object.fromEntries(["assistant-page.html","assistant-client.js","extension/background.js","extension/content.js","extension/policy.js","work-eligibility.js","discovery.js","operation-evidence.js"].map(file=>[file,fs.readFileSync(path.join(__dirname,'..',file),'utf8')]));
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
 for(const extra of ['<label>Unknown fact<input required></label>','<div class="g-recaptcha"></div>','<input type="password">','<p>By submitting, I certify that these statements are true.</p>']){f=await scenario(extra);assert.equal(f.clicks,0);assert(!f.messages.some(m=>m.action==='attempt'));f.close();}
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
 w.eval(sources['assistant-client.js']);await new Promise(r=>setTimeout(r,100));
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
const jobs=await listBoard('https://job-boards.greenhouse.io/example');assert(!urls[0].includes('content=true'));assert.equal(jobs[0].descriptionURL,'https://boards-api.greenhouse.io/v1/boards/example/jobs/42');
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
 const snapshot=operationSnapshot(db,'owner');assert.deepEqual(snapshot.totals,{confirmed:1,worked:4,awaiting:1,active:1,blocked:2,unverifiedOutcome:1});
 assert.equal(operationSnapshot(db,'another-user').applications.length,0);
 db.prepare("UPDATE jobs SET status='offer' WHERE id='receipt'").run();assert.equal(operationSnapshot(db,'owner').totals.confirmed,1);db.close();
});
test('local missing answers are saved without queuing a new attempt',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://marvelous-vitality-production-c2d8.up.railway.app/'}),w=dom.window,requests=[];
 w.setInterval=()=>0;w.fetch=async(url,opts)=>{requests.push([url,opts?.method]);return {ok:true,json:async()=>({})};};w.eval(sources['assistant-client.js']);
 const job={id:'local',applicant_id:'p',company:'Example',title:'Engineer',status:'local_browser',local_phase:'blocked',challenge:'Local browser',required_fields_json:'["Preferred name"]',answers_json:'{}'};
 w.renderMissingAnswers([job]);const section=w.document.querySelector('#missing-answers'),form=section.querySelector('form'),input=form.querySelector('textarea');assert(!section.hidden);input.value='Applicant';
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
