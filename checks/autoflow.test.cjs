const {test}=require('node:test');
const fs=require('node:fs'),path=require('node:path');
const sources=Object.fromEntries(["language-policy.js","draft-provenance.js","answer-drafts.js","form-answer.js","paused-fact-fill.js","saved-answer-recovery.js","hosted-form.js","local-policy.js","automatic-answer.js","employer-limits.js","application-pipeline.js","application-dedup.js","assistant-page.html","assistant-client.js","extension/background.js","extension/content.js","extension/policy.js","work-eligibility.js","discovery.js","operation-evidence.js","continuation-queue.js","answer-library.js","worker.js","job-intelligence.js","matching.js","db.js","server.js","public-answer-fill.js","google-research.js","research-consent.js","resume-editor.js","web/setup.html","web/setup.js","extension/popup.js","extension/popup.html"].map(file=>[file,fs.readFileSync(path.join(__dirname,'..',file),'utf8')]));
test("routine preparation observes native submit clicks without blocking retries or recording failures",()=>(async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict'),{implForWrapper}=require('../node_modules/jsdom/lib/generated/idl/utils.js'),{fireAnEvent}=require('../node_modules/jsdom/lib/jsdom/living/helpers/events.js'),MouseEvent=require('../node_modules/jsdom/lib/generated/idl/MouseEvent.js');
 const wait=()=>new Promise(r=>setTimeout(r,250));
 async function scenario(extra='',{denied=false,initialAttempt=false,automatic=true,receipt=false,autofillOnly=false}={}){
  const dom=new JSDOM('<form><label>Full name<input required></label>'+extra+'<button type="button" id="submit">Submit application</button></form>',{runScripts:'outside-only',url:'https://jobs.ashbyhq.com/example/12345678-1234-1234-1234-123456789abc'}),w=dom.window;
  Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  w.HTMLElement.prototype.getClientRects=function(){return this.type==='hidden'||this.closest('[hidden]')?[]:[{}]};
  const messages=[],timers=[];let attempted=initialAttempt,clicks=0;
  w.setInterval=fn=>{timers.push(fn);return timers.length};w.clearInterval=()=>{};
  w.document.getElementById('submit').onclick=()=>{clicks++;if(receipt)w.document.querySelector('form').innerHTML='<p>Thank you for applying</p>';};
  w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);if(m.action==='packet')return {ok:true,data:{autofillOnly,job:{title:'Fixture',attempted},profile:{name:'Applicant'},answers:{},resume:{name:'resume.pdf',base64:''}}};if(m.action==='state')return {ok:true,data:{autofillOnly,attempted,automatic:automatic&&!attempted}};if(m.action==='attempt'){if(denied)return {ok:false,error:'transport uncertain'};attempted=true;}return {ok:true,data:{}};}}};
  w.eval(sources['extension/policy.js']);w.eval(sources['extension/content.js']);for(let n=0;n<80&&!messages.some(m=>m.action==='progress'&&m.blocked||m.action==='site-error')&&!initialAttempt;n++)await new Promise(r=>setTimeout(r,25));await wait();
  const trustedClick=async()=>{const button=w.document.getElementById('submit');if(button)fireAnEvent('click',implForWrapper(button),MouseEvent,{bubbles:true,cancelable:true,isTrusted:true});await wait();};
  const runTimers=async()=>{for(const fn of [...timers])await fn();await wait();};
  return {messages,w,get clicks(){return clicks;},trustedClick,runTimers,close:()=>w.close()};
 }
 let f=await scenario('',{receipt:true});assert.equal(f.clicks,0,'automation must leave final Submit untouched');assert(!f.messages.some(m=>m.action==='attempt'));assert(f.messages.some(m=>m.action==='progress'&&m.message.includes('Ready to submit')),JSON.stringify(f.messages));
 await f.trustedClick();assert.equal(f.clicks,1);assert.equal(f.messages.filter(m=>m.action==='attempt').length,1);await f.trustedClick();assert.equal(f.clicks,1,'the same trusted action is never replayed twice');await f.runTimers();assert(f.messages.some(m=>m.action==='receipt'));f.close();
 f=await scenario('',{denied:true});await f.trustedClick();assert.equal(f.clicks,1,'tracking failure must not cancel the native click');assert.equal(f.messages.filter(m=>m.action==='attempt').length,1);f.close();
 for(const denied of [false,true]){f=await scenario('',{autofillOnly:true,denied});await f.trustedClick();f.w.document.querySelector('input').value='';const before=f.messages.length;await f.runTimers();assert.equal(f.w.document.querySelector('input').value,'','post-submit reset must not trigger background refill');assert(!f.messages.slice(before).some(m=>m.action==='progress'&&m.fields?.length),'post-submit reset must not report missing answers');assert(f.w.document.body.textContent.includes('Awaiting employer confirmation'));assert(!f.w.document.body.textContent.includes('0 fields filled'));f.w.document.querySelector('input').value='Applicant';await f.trustedClick();assert.equal(f.clicks,2,'manual retry remains available');f.close();}
 f=await scenario('',{initialAttempt:true});await f.trustedClick();assert.equal(f.clicks,1,'the user can click again after a recorded attempt');await f.trustedClick();assert.equal(f.clicks,2);assert.equal(f.messages.filter(m=>m.action==='attempt').length,0,'invalid native form clicks are not submission attempts');f.close();
 for(const extra of ['<footer>By submitting you provide consent for a criminal record check.</footer>','<footer>Agreement to Arbitrate and privacy policy.</footer>']){f=await scenario(extra);assert(f.messages.some(m=>m.action==='progress'&&m.message.includes('Ready to submit')),'static footer boilerplate must not block routine preparation');f.close();}
 for(const extra of ['<label>Unknown fact<input required></label>','<div class="g-recaptcha"></div>','<input type="password">','<label><input type="checkbox" required>I certify these statements are accurate</label>','<label>Gender<select required><option value="">Choose</option></select></label>']){f=await scenario(extra);assert(!f.messages.some(m=>m.action==='progress'&&m.message.includes('Ready to submit')),extra);assert(!f.messages.some(m=>m.action==='attempt'));f.close();}
 return 'PASS extension: prepare-only final step, one durable trusted attempt, receipt confirmation, footer-safe checks, and required unknown/CAPTCHA/login/legal/demographic blocks';
})());
test("interview integration and deduplication",()=>(async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://marvelous-vitality-production-c2d8.up.railway.app/?view=settings'}),w=dom.window;
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
 const noOp={addListener(){}},chrome={storage:{local:{get:async()=>state,set:async v=>Object.assign(state,v)}},tabs:{get:async()=>{gets++;throw Error('missing tab');},query:async q=>{queries.push(q);return [{id:4}];},onRemoved:noOp},scripting:{executeScript:async({args})=>!args?[{result:{ready:true}}]:[{result:{data:args[1]==='/jobs'?{jobs:[]}:{ok:true}}}]},runtime:{onMessage:noOp,onStartup:noOp,onInstalled:noOp},alarms:{onAlarm:noOp}};
 const context={chrome,URL,console,Date,crypto:require('node:crypto').webcrypto,importScripts(){},ApplyPilotPolicy:{sameApplication:()=>false,supported:()=>true}};
 vm.runInNewContext(sources['extension/background.js']+';globalThis.testTick=tick;',Object.assign(context,{setTimeout,clearTimeout}));await context.testTick();
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

test('portal React Select is filled exactly while final Submit remains untouched',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 async function scenario({ambiguous=false,accepted=true,preselected=false,portal=true,extra=''}={}){
  const dom=new JSDOM('<form><label id="country-label">Country</label><div class="select__control"><div class="select__value-container"><input id="country" role="combobox" aria-labelledby="country-label" aria-required="true" aria-expanded="false"></div></div>'+extra+'<button type="button" id="submit">Submit application</button></form>',{runScripts:'outside-only',url:'https://job-boards.greenhouse.io/example/jobs/42'}),w=dom.window;
  Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  w.HTMLElement.prototype.getClientRects=function(){return this.isConnected&&!this.closest('[hidden]')?[{}]:[];};
  w.setInterval=()=>0;w.clearInterval=()=>{};const messages=[];let attempts=0,clicks=0;
  const input=w.document.querySelector('input'),container=input.parentElement;
  const select=()=>{const selected=w.document.createElement('div');selected.className='select__single-value';selected.textContent='Canada';container.prepend(selected);input.value='';input.setAttribute('aria-expanded','false');w.document.getElementById('country-options')?.remove();};
  if(preselected)select();
  input.onclick=()=>{if(w.document.getElementById('country-options'))return;const list=w.document.createElement('div');list.id='country-options';list.setAttribute('role','listbox');for(let i=0;i<(ambiguous?2:1);i++){const option=w.document.createElement('div');option.setAttribute('role','option');option.textContent='Canada +1';option.onclick=()=>{if(accepted)select();else {input.value='Canada';list.remove();}};list.append(option);}w.document.body.append(list);if(!portal)input.setAttribute('aria-controls',list.id);input.setAttribute('aria-expanded','true');};
  w.document.getElementById('submit').onclick=()=>{assert(attempts===1);clicks++;};
  w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);if(m.action==='packet')return {ok:true,data:{job:{title:'Fixture'},profile:{location:'Toronto, Ontario, Canada'},answers:{},resume:{name:'resume.pdf',base64:''}}};if(m.action==='state')return {ok:true,data:{automatic:true,attempted:!!attempts}};if(m.action==='attempt')attempts++;return {ok:true,data:{}};}}};
  w.eval(sources['extension/policy.js']);w.eval(sources['extension/content.js']);await new Promise(r=>setTimeout(r,1150));
  const result={attempts,clicks,messages,ready:messages.some(m=>m.action==='progress'&&m.message.includes('Ready to submit'))};w.close();return result;
 }
 const success=await scenario();assert.equal(success.clicks,0);assert.equal(success.attempts,0);assert(success.ready,JSON.stringify(success.messages));assert(success.messages.some(m=>m.action==='capture'&&m.fields.some(f=>f.question==='Country'&&f.answer==='Canada')));
 assert((await scenario({preselected:true})).ready);assert((await scenario({portal:false})).ready);
 for(const opts of [{ambiguous:true},{accepted:false},{extra:'<label>Unknown employer question<input required></label>'}])assert.equal((await scenario(opts)).ready,false);
 assert((await scenario({extra:'<p>Agreement to Arbitrate: please read the arbitration agreement.</p>'})).ready,'static legal copy is not an interactive question');
 assert((await scenario({extra:'<div role="checkbox" aria-label="Join product newsletter" aria-checked="false"></div>'})).ready,'an unresolved optional custom control does not block');
 assert.equal((await scenario({extra:'<div role="checkbox" aria-label="I accept the terms" aria-required="true" aria-checked="false"></div>'})).ready,false);
});
test('exact saved answers fill required ARIA radio and checkbox controls using accessible descriptions',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const html='<form><div role="radiogroup" aria-labelledby="arrangement-label" aria-required="true"><span id="arrangement-label">Preferred work arrangement</span><div role="radio" aria-label="Remote" aria-checked="false">Remote</div><div role="radio" aria-label="Hybrid" aria-checked="false">Hybrid</div></div><span id="updates-help">Receive product updates</span><div role="checkbox" aria-describedby="updates-help" aria-required="true" aria-checked="false"></div><button type="button">Submit application</button></form>';
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://jobs.ashbyhq.com/example/12345678-1234-1234-1234-123456789abc'}),w=dom.window,messages=[];
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});w.HTMLElement.prototype.getClientRects=function(){return this.isConnected?[{}]:[];};w.setInterval=()=>0;w.clearInterval=()=>{};
 for(const control of w.document.querySelectorAll('[role="radio"]'))control.onclick=()=>{for(const other of control.parentElement.querySelectorAll('[role="radio"]'))other.setAttribute('aria-checked',String(other===control));};
 w.document.querySelector('[role="checkbox"]').onclick=function(){this.setAttribute('aria-checked','true');};
 w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);if(m.action==='packet')return {ok:true,data:{job:{title:'Fixture'},profile:{},answers:{'Preferred work arrangement':'Remote','Receive product updates':'Yes'},resume:{name:'resume.pdf',base64:''}}};if(m.action==='state')return {ok:true,data:{automatic:true,attempted:false}};return {ok:true,data:{}};}}};
 w.eval(sources['extension/policy.js']);w.eval(sources['extension/content.js']);await new Promise(r=>setTimeout(r,250));
 assert.equal(w.document.querySelector('[role="radio"][aria-label="Remote"]').getAttribute('aria-checked'),'true');assert.equal(w.document.querySelector('[role="checkbox"]').getAttribute('aria-checked'),'true');
 assert(messages.some(m=>m.action==='capture'&&m.fields.some(f=>f.question==='Preferred work arrangement'&&f.answer==='Remote')&&m.fields.some(f=>f.question==='Receive product updates'&&f.answer==='Yes')));assert(messages.some(m=>m.action==='progress'&&m.message.includes('Ready to submit')));assert(!messages.some(m=>m.action==='attempt'));w.close();
});
test('extension application identity collapses localized ATS aliases',()=>{
 const assert=require('node:assert/strict'),vm=require('node:vm'),ctx={URL};vm.runInNewContext(sources['extension/policy.js'],Object.assign(ctx,{setTimeout,clearTimeout}));const same=ctx.ApplyPilotPolicy.sameApplication;
 assert(same('https://job-boards.greenhouse.io/acme/jobs/42?lang=fr&gh_src=mail','https://boards.greenhouse.io/acme/jobs/42?locale=en'));
 assert(same('https://acme.wd5.myworkdayjobs.com/fr-CA/Careers/job/Toronto/Engineer_R123?source=LinkedIn','https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Toronto/Engineer_R123'));
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
 const snapshot=operationSnapshot(db,'owner');assert.deepEqual(snapshot.totals,{completed:1,confirmed:1,worked:4,awaiting:1,active:1,stalled:0,blocked:2,unverifiedOutcome:1,automatic:0,assisted:0,unknown:1});
 assert.equal(operationSnapshot(db,'another-user').applications.length,0);
 db.prepare("UPDATE jobs SET status='offer' WHERE id='receipt'").run();assert.equal(operationSnapshot(db,'owner').totals.confirmed,1);db.close();
});
test('local missing answers are saved without queuing a new attempt',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://marvelous-vitality-production-c2d8.up.railway.app/'}),w=dom.window,requests=[];
 w.setInterval=()=>0;w.fetch=async(url,opts)=>{requests.push([url,opts?.method]);return {ok:true,json:async()=>({})};};w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);
 const job={id:'local',applicant_id:'p',company:'Example',title:'Engineer',status:'local_browser',local_phase:'blocked',challenge:'Local browser',required_fields_json:'["Preferred name","Required field","AI Policy for Application"]',answers_json:'{}'};
 w.renderMissingAnswers([job]);const section=w.document.querySelector('#missing-answers'),form=section.querySelector('form'),input=form.querySelector('textarea');assert(!section.hidden);assert.equal(form.querySelectorAll('textarea').length,1);assert.equal(section.querySelector('details').open,false);input.value='Applicant';
 w.eval('refresh=async()=>{}');input.dispatchEvent(new w.Event("input",{bubbles:true}));input.dispatchEvent(new w.Event("blur"));await new Promise(r=>setTimeout(r,20));assert(requests.some(([url,method])=>url.endsWith('/answers')&&method==='PUT'));assert(!requests.some(([url])=>url.endsWith('/continue')));
 section.dataset.dirty='false';w.renderMissingAnswers([{...job,local_attempt_at:'2026-10-01'}]);assert.equal(section.querySelector('form'),null,'attempted application must not re-enter the answer/resume flow');w.close();
});

test('dashboard resume rejects attempted applications and other origins',async()=>{
 const assert=require('node:assert/strict'),vm=require('node:vm');
 const state={automaticDefault:true,device:'00000000-0000-0000-0000-000000000001',enabled:true,records:{j:{id:'j',attempted:true,phase:'blocked'}},queue:[]};
 const noop={addListener(){}},chrome={storage:{local:{get:async()=>state,set:async v=>Object.assign(state,v),setAccessLevel:async()=>{}}},runtime:{onMessage:noop,onStartup:noop,onInstalled:noop},alarms:{get:async()=>({}),onAlarm:noop},tabs:{onRemoved:noop}};
 const context={chrome,URL,console,Date,crypto:require('node:crypto').webcrypto,importScripts(){},ApplyPilotPolicy:{}};
 vm.runInNewContext(sources['extension/background.js']+';globalThis.testHandle=handle;',Object.assign(context,{setTimeout,clearTimeout}));
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

test('autosave sends per-question updates; server owns continuation and attempted forms stay protected',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 async function scenario(questions,attempted=false){
  const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://marvelous-vitality-production-c2d8.up.railway.app/'}),w=dom.window,requests=[];
  w.setInterval=()=>0;w.fetch=async(url,opts)=>{requests.push([url,opts?.method,opts?.body]);return {ok:true,json:async()=>({state:'queued'})};};
  w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);w.eval('refresh=async()=>{}');
  w.renderMissingAnswers([{id:'j',applicant_id:'p',company:'Fixture',title:'Engineer',status:'local_browser',local_phase:'blocked',required_fields_json:JSON.stringify(questions),answers_json:'{}',local_attempt_at:attempted?'today':null}]);
  const section=w.document.querySelector('#missing-answers'),form=section.querySelector('form');
  if(form){form.querySelector('textarea').value='Applicant';const input=form.querySelector("textarea");input.dispatchEvent(new w.Event("input",{bubbles:true}));input.dispatchEvent(new w.Event("blur"));await new Promise(r=>setTimeout(r,20));}
  const result={requests,hidden:!section.querySelector('form')};w.close();return result;
 }
 let r=await scenario(['Preferred name']);assert(r.requests.some(([url,method,payload])=>url.endsWith('/answers')&&method==='PUT'&&JSON.parse(payload).autosave));assert(!r.requests.some(([url])=>url.endsWith('/continue')||url.endsWith('/attempt')));
 for(const questions of [['Preferred name','Unknown fact'],['Preferred name','AI policy']]){r=await scenario(questions);assert(!r.requests.some(([url])=>url.endsWith('/continuation')));}
 assert((await scenario(['Preferred name'],true)).hidden);
});

test('dashboard only retries an explicit busy refusal and honours a paused helper',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://marvelous-vitality-production-c2d8.up.railway.app/'}),w=dom.window,requests=[];
 w.setInterval=()=>0;w.fetch=async(url,opts)=>{requests.push([String(url),opts?.body&&JSON.parse(opts.body)]);return {ok:true,json:async()=>String(url).endsWith('/claim')?{request:{jobId:'j',claimId:'lease'}}:{requests:[]}};};
 w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']+';window.configureContinuationTest=(enabled,handler)=>{nextContinuationCheck=0;browserHelperStatus={enabled,version:"0.6.25",checkedAt:Date.now()};resumeLocalApplication=handler;};');
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
 const form=w.document.querySelector('#missing-answers form');await new Promise(r=>setTimeout(r,25));
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
 const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://marvelous-vitality-production-c2d8.up.railway.app/?view=settings'}),w=dom.window;
 w.setInterval=()=>0;w.fetch=async url=>({ok:true,json:async()=>{const p=String(url).replace('/api','');if(p==='/jobs')return {jobs};if(p==='/application-history')return {records:[]};if(p==='/status')return {workerOnline:true};if(p==='/operations')return {totals:{stalled:1,confirmed:1},applications:jobs.map(j=>({id:j.id,...applicationEvidence(j)})),checkedAt:new Date().toISOString()};return {requests:[],searches:[],events:[]};}});
 w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);await w.refresh(true);
 assert.equal(w.document.querySelector('#applying-count').textContent,'0');assert(w.document.querySelector('#job-stale').textContent.includes('Browser check needed'));
 w.HTMLElement.prototype.scrollIntoView=function(){};[...w.document.querySelectorAll('#operations button')].find(b=>b.textContent.includes('Receipts recorded')).click();assert(!w.document.querySelector('#job-receipt').hidden);assert(w.document.querySelector('#job-placeholder').hidden);
 [...w.document.querySelectorAll('#operations button')].find(b=>b.textContent.includes('Browser check needed')).click();assert(!w.document.querySelector('#job-stale').hidden);assert(w.document.querySelector('#job-receipt').hidden);
 [...w.document.querySelectorAll('#operations button')].find(b=>b.textContent.includes('Needs a step')).click();assert(w.document.querySelector('#job-stale').hidden,'stalled forms have a separate metric');
 w.close();
});

test('employer error pages are classified without mistaking job descriptions for errors',async()=>{
 const assert=require('node:assert/strict'),vm=require('node:vm'),ctx={URL};vm.runInNewContext(sources['extension/policy.js'],Object.assign(ctx,{setTimeout,clearTimeout}));
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
  const noop={addListener(){}},chrome={storage:{local:{get:async()=>state,set:async v=>Object.assign(state,v),setAccessLevel:async()=>{}}},runtime:{onMessage:noop,onStartup:noop,onInstalled:noop,getURL:p=>'chrome-extension://fixture/'+p},alarms:{get:async()=>({}),onAlarm:noop},tabs:{get:async()=>({id:3,url}),update:async(id,options)=>{updates.push({id,...options});},query:async()=>[{id:1}],onRemoved:noop},scripting:{executeScript:async({args})=>{if(!args)return [{result:{ready:true}}];requests.push(args);return [{result:{data:args[1]==='/jobs'?{jobs:[]}:args[1].endsWith('/packet')?{job:{attempted:!!state.serverAttempted}}:{ok:true}}}];}}};
  const ctx={chrome,URL,console,Date:Clock,crypto:require('node:crypto').webcrypto,importScripts(){}};
  vm.runInNewContext(sources['extension/policy.js'],Object.assign(ctx,{setTimeout,clearTimeout}));vm.runInNewContext(sources['extension/background.js']+';globalThis.testHandle=handle;globalThis.testTick=tick;globalThis.testEligible=eligible;',Object.assign(ctx,{setTimeout,clearTimeout}));
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
 const assert=require('node:assert/strict'),vm=require('node:vm'),ctx={URL};vm.runInNewContext(sources['extension/policy.js'],Object.assign(ctx,{setTimeout,clearTimeout}));
 let status='running',challenge=null,closed=false,gotoCount=0;const events=[];
 const db={prepare(sql){return {get(){if(sql.includes('FROM applicants'))return {id:'p',user_id:'u',consent:1,email:'applicant@example.test',resume_path:'fixture.pdf',answers_json:'{}'};return {status,challenge};},run(...values){if(sql.startsWith('UPDATE jobs SET status=')){status=values[0];challenge=values[1];}}};}};
 const page={setDefaultTimeout(){},goto:async()=>{gotoCount++;return {status:()=>503};},waitForTimeout:async()=>{},locator(selector){if(selector==='body')return {innerText:async()=>'Error 503\nService Unavailable'};if(selector==='form,input:visible,textarea:visible,select:visible')return {count:async()=>0};throw Error('Must not inspect/fill an error page: '+selector);},isClosed:()=>false};
 const context={newPage:async()=>page,close:async()=>{closed=true;}};const browser={newContext:async()=>context};
 const code=sources['worker.js'].replace(/import\s+[^;]+;/g,'').replace(/main\(\)\.catch[\s\S]*$/,'');
 const run=new Function('db','event','now','installLibrary','installDrafts','installResearch','reusableAnswers','researchConsentWithdrawn','hostAllowed','employerPageIssue','employerHold',code+';return run;')(db,(id,type,message)=>events.push({type,message}),()=>new Date().toISOString(),()=>{},()=>{},()=>{},()=>({}),()=>false,()=>true,ctx.ApplyPilotPolicy.employerPageIssue,()=>null);
 await run({id:'j',user_id:'u',applicant_id:'p',url:'https://job-boards.greenhouse.io/example/jobs/42'},browser);
 assert.equal(gotoCount,1);assert.equal(status,'needs_review');assert.equal(challenge,'Employer site unavailable');assert(closed);
 assert(events.some(e=>e.message.includes('HTTP 503')));assert(!events.some(e=>['filled','submitted'].includes(e.type)));
});

function pureModule(file,bindings={}){
 if(file!=='employer-limits.js')bindings={supportIntent:()=>false,populateBatch:()=>null,inActiveBatch:()=>true,applicationDiversityHistory:()=>[],diversifyApplications:jobs=>jobs,spreadDiscoveryBoards:boards=>boards,worldwideTechIntent:value=>/^Worldwide technology roles:/i.test(value),employerHold:()=>null,excludesFrench:()=>false,frenchApplication:()=>false,archiveFrench:()=>[],...bindings};
 const code=sources[file].replace(/^import .+;\s*$/gm,'').replace(/\bexport\s+(?=(?:async\s+)?function|const|let|class)/g,'');
 return new Function(...Object.keys(bindings),code+';return {employerKey:typeof employerKey==="function"?employerKey:null,applicationLimit:typeof applicationLimit==="function"?applicationLimit:null,installEmployerLimits:typeof installEmployerLimits==="function"?installEmployerLimits:null,employerHold:typeof employerHold==="function"?employerHold:null,recordEmployerLimit:typeof recordEmployerLimit==="function"?recordEmployerLimit:null,employerLimits:typeof employerLimits==="function"?employerLimits:null,installPipeline:typeof installPipeline==="function"?installPipeline:null,pipelineEnabled:typeof pipelineEnabled==="function"?pipelineEnabled:null,queueFoundApplications:typeof queueFoundApplications==="function"?queueFoundApplications:null,setPipeline:typeof setPipeline==="function"?setPipeline:null,pipelineStatus:typeof pipelineStatus==="function"?pipelineStatus:null,sameApplication:typeof sameApplication==="function"?sameApplication:null,priorApplication:typeof priorApplication==="function"?priorApplication:null,installRepeatGuard:typeof installRepeatGuard==="function"?installRepeatGuard:null,compensation:typeof compensation==="function"?compensation:null,jobIntelligence:typeof jobIntelligence==="function"?jobIntelligence:null,nextApplication:typeof nextApplication==="function"?nextApplication:null,nextApplicationEligible:typeof nextApplicationEligible==="function"?nextApplicationEligible:null,sourceBatch:typeof sourceBatch==="function"?sourceBatch:null,cachedJSON:typeof cachedJSON==="function"?cachedJSON:null,runSearch:typeof runSearch==="function"?runSearch:null};')(...Object.values(bindings));
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
test('large employer feeds are accepted while oversized decoded streams are cancelled',async()=>{
 const assert=require('node:assert/strict');
 const payload=JSON.stringify({jobs:[{description:'x'.repeat(9000000)}]});
 const large=pureModule('discovery.js',{fetch:async()=>new Response(payload)});
 assert.equal((await large.cachedJSON('https://board.example/large')).jobs[0].description.length,9000000);
 let cancelled=false;
 const over=pureModule('discovery.js',{fetch:async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(13000000));},cancel(){cancelled=true;}}))});
 await assert.rejects(over.cachedJSON('https://board.example/oversized'),/too large/);assert.equal(cancelled,true);
 let read=false,cancelledHeader=false;
 const declared=pureModule('discovery.js',{fetch:async()=>({ok:true,headers:{get:()=> '24000001'},body:{cancel:async()=>{cancelledHeader=true;}},text:async()=>{read=true;return '{}';}})});
 await assert.rejects(declared.cachedJSON('https://board.example/declared'),/too large/);assert.equal(read,false);assert.equal(cancelledHeader,true);
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
 assert.equal(w.document.querySelector('#next-match').parentElement.id,'workspace-tools-body');
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
 db.exec('ALTER TABLE applicants ADD COLUMN gemini_facts_consent INTEGER NOT NULL DEFAULT 0');
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
 assert.deepEqual(Array.from(w.document.querySelectorAll('.attention-position'),n=>n.textContent),['1/3','2/3','3/3']);assert(w.document.querySelector('#numbers').textContent.includes('2Need your input'));assert(!w.document.querySelector('#jobs').textContent.includes('Done'));dom.window.close();
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
 const noOp={addListener(){}},chrome={storage:{local:{get:async()=>state,set:async v=>Object.assign(state,v),setAccessLevel:async()=>{}}},tabs:{query:async()=>[{id:4}],onRemoved:noOp},scripting:{executeScript:async({args})=>!args?[{result:{ready:true}}]:[{result:{data:args[1]==='/jobs'?{jobs}:{applications:[{id:'second',stalled:true}]}}}]},runtime:{getURL:p=>'chrome-extension://fixture/'+p,onMessage:noOp,onStartup:noOp,onInstalled:noOp},alarms:{get:async()=>({}),onAlarm:noOp}};
 const c={chrome,URL,console,Date,crypto:require('node:crypto').webcrypto,importScripts(){}};
 vm.runInNewContext(sources['extension/policy.js'],Object.assign(c,{setTimeout,clearTimeout}));vm.runInNewContext(sources['extension/background.js']+';globalThis.testHandle=handle;',Object.assign(c,{setTimeout,clearTimeout}));
 const popup=await c.testHandle({action:'list'},{url:'chrome-extension://fixture/popup.html'});
 assert.equal(popup.jobs.find(j=>j.id==='second').evidence.stalled,true);
 const result=await c.testHandle({action:'attention-position'},{tab:{id:8},frameId:0,url:'https://jobs.lever.co/example/second'});
 assert.equal(result.position,2);assert.equal(result.total,2);assert.deepEqual(Object.keys(result).sort(),['position','total']);
 await assert.rejects(c.testHandle({action:'attention-position'},{tab:{id:9},frameId:0,url:'https://jobs.lever.co/example/unrelated'}),/not linked/);
 assert(sources['extension/content.js'].includes("send('attention-position')"));
 assert(!sources['extension/content.js'].includes("send('list')"));
 const {JSDOM}=require('jsdom'),dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://example.test'}),w=dom.window;
 w.setInterval=()=>0;w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);
 w.eval('renderBrowserReadiness([{execution_mode:"local"}])');assert(w.document.body.textContent.includes('0.6.25'));w.close();
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
 assert.equal(db.prepare("SELECT COUNT(*) n FROM work_focus").get().n,1);
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
 const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://example.com?view=settings'}),w=dom.window;w.setInterval=()=>0;w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);w.HTMLElement.prototype.scrollIntoView=()=>{};
 const jobs=[{id:'auto',company:'A',title:'Cloud Engineer'},{id:'help',company:'B',title:'SRE'},{id:'old',company:'C',title:'Platform Engineer'}],snapshot={totals:{confirmed:3,automatic:1,assisted:1,unknown:1},applications:[{id:'auto',completion:'automatic'},{id:'help',completion:'assisted'},{id:'old',completion:'unknown'}],checkedAt:new Date().toISOString()};
 w.eval('renderOperations('+JSON.stringify(snapshot)+',{events:[]},'+JSON.stringify(jobs)+')');
 assert.equal(w.document.querySelectorAll('#completion-breakdown [data-completion]').length,3);assert.equal(w.document.querySelectorAll('#completion-breakdown li').length,3);
 const cards=w.document.querySelector('#jobs');for(const j of snapshot.applications){const card=w.document.createElement('article');card.dataset.completion=j.completion;card.dataset.search=j.id;cards.append(card);}
 w.document.querySelector('#completion-breakdown [data-completion=assisted]').click();assert.deepEqual([...cards.children].map(c=>c.hidden),[true,false,true]);
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
 vm.runInNewContext(sources['extension/background.js']+';api=async()=>({jobs:fixtureJobs});openJob=async(id)=>opened.push(id);globalThis.testTick=tick;',Object.assign(context,{setTimeout,clearTimeout}));
 await context.testTick();assert.deepEqual(opened,['high']);assert.deepEqual(Array.from(state.queue),['low']);
});

test('completion groups next application reflects the actual approved queue even without fresh discovery metadata',()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://example.com'}),w=dom.window;w.setInterval=()=>0;w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);
 const jobs=[{id:'saved',title:'High saved',company:'A',status:'saved',match_score:99,metadata:{available:true,strong:true,eligibility:{eligible:true},checkedAt:new Date().toISOString()}},{id:'queued',title:'Actual next queued',company:'B',status:'queued',match_score:70,url:'https://jobs.lever.co/b/123'},{id:'attempted',title:'Attempted',company:'C',status:'queued',match_score:100,local_attempt_at:'now'}];
 w.eval('renderNextMatch('+JSON.stringify(jobs)+')');const text=w.document.querySelector('#next-match').textContent;assert(text.includes('Actual next queued'));assert(text.includes('Queued for your application worker'));assert(!text.includes('High saved'));assert(!text.includes('Attempted'));w.close();
});

const ashbyLimitMessage="We couldn't submit your application. Thank you for considering Ashby! You have reached your application limit. To ensure the best possible candidate experience in light of high application volumes we want to ensure candidates apply to roles that are the best fit for them. To ensure that we limit applications to a total of 3 over the span of 60 days.";
test('employer limit recognizes the refusal and scopes Ashby by employer board, not ATS host',()=>{
 const assert=require('node:assert/strict'),{applicationLimit,employerKey}=pureModule('employer-limits.js');
 const limit=applicationLimit(ashbyLimitMessage);assert.equal(limit.count,3);assert.equal(limit.days,60);
 assert.equal(applicationLimit('We limit applications to 3 over 60 days. Join our team.'),null);
 assert.equal(applicationLimit('Your application was successfully submitted.'),null);
 assert.equal(employerKey({company:'Ashby',url:'https://jobs.ashbyhq.com/ashby/a/application'}),employerKey({company:'ashby',url:'https://jobs.ashbyhq.com/ashby/b'}));
 assert.notEqual(employerKey({company:'Ashby',url:'https://jobs.ashbyhq.com/ashby/a'}),employerKey({company:'Other',url:'https://jobs.ashbyhq.com/other/a'}));
});
test('employer hold blocks only the affected applicant and employer while preserving receipts and attempts',()=>{
 const assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(':memory:'),m=pureModule('employer-limits.js');
 db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,company TEXT,title TEXT,url TEXT,status TEXT,local_phase TEXT,challenge TEXT,local_attempt_at TEXT,confirmation TEXT,updated_at TEXT);CREATE TABLE events(id INTEGER PRIMARY KEY,job_id TEXT,at TEXT,type TEXT,message TEXT)");
 m.installEmployerLimits(db);
 const add=(id,{user='u',applicant='p',board='ashby',status='saved',attempt=null,receipt=null}={})=>db.prepare('INSERT INTO jobs(id,user_id,applicant_id,company,title,url,status,local_phase,local_attempt_at,confirmation) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,user,applicant,board,'Engineer','https://jobs.ashbyhq.com/'+board+'/'+id,status,'ready',attempt,receipt);
 add('failed',{status:'local_browser',attempt:'earlier'});add('queued',{status:'queued'});add('receipt',{status:'submitted',receipt:'Thank you for applying'});add('other-employer',{board:'baseten'});add('other-user',{user:'v'});add('other-applicant',{applicant:'q'});
 const at='2099-01-01T00:00:00.000Z',result=m.recordEmployerLimit(db,'u','failed',ashbyLimitMessage,{at});assert.equal(result.held,2);assert.equal(result.holdUntil,'2099-03-02T00:00:00.000Z');
 const row=id=>db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
 assert.equal(row('failed').local_attempt_at,'earlier');assert.equal(row('failed').local_phase,'blocked');assert.equal(row('receipt').status,'submitted');assert.equal(row('receipt').confirmation,'Thank you for applying');
 assert.equal(row('queued').status,'needs_review');for(const id of ['other-employer','other-user','other-applicant']){assert.equal(row(id).status,'saved');db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(id);}
 assert.throws(()=>db.prepare("UPDATE jobs SET status='queued' WHERE id='queued'").run(),/Employer application limit/);
 add('future');assert(m.employerHold(db,row('future'),at));assert.throws(()=>db.prepare("UPDATE jobs SET status='queued' WHERE id='future'").run(),/Employer application limit/);
 const repeat=m.recordEmployerLimit(db,'u','failed',ashbyLimitMessage,{at:'2099-01-02T00:00:00.000Z'});assert.equal(repeat.holdUntil,result.holdUntil);
 assert.equal(m.employerHold(db,row('failed'),'2099-03-03T00:00:00.000Z'),null);
 assert.throws(()=>m.recordEmployerLimit(db,'v','failed',ashbyLimitMessage),/not found/);
 assert.throws(()=>m.recordEmployerLimit(db,'u','failed','ordinary job description'),/Paste the employer/);
 db.close();
});
test('dashboard reports an employer limit using the selected owned job and labels the conservative date',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict'),dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://example.com'}),w=dom.window;w.setInterval=()=>0;w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);
 w.fixtureMessage=ashbyLimitMessage;w.calls=[];w.eval("api=async(path,method,data)=>{calls.push({path,method,data});return {company:'Ashby',held:3}};refresh=async()=>{};renderEmployerLimits({limits:[{company:'Ashby',message:'Employer limit reached',hold_until:'2099-03-02T00:00:00Z'}]},[{id:'ashby-job',company:'Ashby',title:'Engineer',status:'local_browser'}])");
 assert(w.document.querySelector('#employer-limits').textContent.includes('exact reset date is not known'));
 const form=w.document.querySelector('#employer-limits form');form.querySelector('select').value='ashby-job';form.querySelector('textarea').value=ashbyLimitMessage;await form.onsubmit({preventDefault(){}});
 assert.equal(w.calls[0].path,'/employer-limits');assert.equal(w.calls[0].method,'POST');assert.equal(w.calls[0].data.jobId,'ashby-job');assert.equal(w.calls[0].data.message,ashbyLimitMessage);assert(w.document.querySelector('#notice').textContent.includes('3 pending applications paused'));w.close();
});
test('an employer limit refusal is never counted as a receipt even with thank-you wording',async()=>{
 const assert=require('node:assert/strict');
 const policy='data:text/javascript;base64,'+Buffer.from(sources['extension/policy.js']+'\nexport const receipt=globalThis.ApplyPilotPolicy.receipt;').toString('base64');
 const {applicationEvidence}=await import('data:text/javascript;base64,'+Buffer.from(sources['operation-evidence.js'].replace("'./local-policy.js'",JSON.stringify(policy))).toString('base64'));
 const evidence=applicationEvidence({status:'local_browser',receipt_event:1,local_attempt_at:'earlier',confirmation:'Thank you for your application. '+ashbyLimitMessage});assert.equal(evidence.confirmed,false);assert.equal(evidence.completion,null);assert.equal(evidence.awaiting,true);
});
test('hosted worker records an explicit employer application limit without filling or reporting success',async()=>{
 const assert=require('node:assert/strict');let status='running',challenge=null,closed=false,recorded=0;const events=[],m=pureModule('employer-limits.js');
 const db={prepare(sql){return {get(){if(sql.includes('FROM applicants'))return {id:'p',user_id:'u',consent:1,email:'applicant@example.test',resume_path:'fixture.pdf',answers_json:'{}'};return {status,challenge};},run(...values){if(sql.startsWith('UPDATE jobs SET status=')){status=values[0];challenge=values[1];}}};}};
 const page={setDefaultTimeout(){},goto:async()=>({status:()=>200}),waitForTimeout:async()=>{},locator(selector){if(selector==='body')return {innerText:async()=>ashbyLimitMessage};if(selector==='form,input:visible,textarea:visible,select:visible')return {count:async()=>0};throw Error('Limit page must not be filled: '+selector);},isClosed:()=>false};
 const context={newPage:async()=>page,close:async()=>{closed=true;}},browser={newContext:async()=>context};
 const code=sources['worker.js'].replace(/import\s+[^;]+;/g,'').replace(/main\(\)\.catch[\s\S]*$/,'');
 const run=new Function('db','event','now','installLibrary','installDrafts','installResearch','reusableAnswers','researchConsentWithdrawn','hostAllowed','employerPageIssue','employerHold','applicationLimit','recordEmployerLimit',code+';return run;')(db,(id,type,message)=>events.push({type,message}),()=>new Date().toISOString(),()=>{},()=>{},()=>{},()=>({}),()=>false,()=>true,()=>null,()=>null,m.applicationLimit,()=>{recorded++;});
 await run({id:'j',user_id:'u',applicant_id:'p',url:'https://jobs.ashbyhq.com/ashby/j'},browser);
 assert.equal(recorded,1);assert.equal(status,'needs_review');assert.equal(challenge,'Employer application limit');assert(closed);assert(!events.some(e=>['filled','submitted','submission_started'].includes(e.type)));
});

test('common profile prompt wording resolves exact approved facts without widening question scope',()=>{
 const vm=require('node:vm'),assert=require('node:assert/strict'),c={};vm.runInNewContext(sources['extension/policy.js'],Object.assign(c,{setTimeout,clearTimeout}));const p=c.ApplyPilotPolicy;
 for(const q of ['Please provide a link to your LinkedIn profile','What is your LinkedIn profile URL?','Please enter your LinkedIn URL','Share your GitHub profile']){
  assert.equal(p.knownAnswer(q,{}, {'LinkedIn Profile':'https://linkedin.com/in/example','GitHub':'https://github.com/example'}),q.includes('GitHub')?'https://github.com/example':'https://linkedin.com/in/example');
 }
 assert.equal(p.knownAnswer('What is your current city?',{location:'Toronto, Ontario, Canada'},{}),'Toronto');
 for(const q of ['Please provide your manager LinkedIn profile','Please provide a link to your employer LinkedIn profile','Why is your LinkedIn profile relevant?','What is your desired salary?','Please provide your work authorization','Please share your GitHub project experience']){
  assert.equal(p.fieldKind(q),undefined,q);
 }
 assert.equal(p.knownAnswer('Please provide a link to your LinkedIn profile',{}, {'LinkedIn':'one','LinkedIn Profile':'two'}),null);
});

test('conditional required controls settle and fill before the helper pauses; final Submit remains manual',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 const dom=new JSDOM('<form><label>Country<select required><option value="">Choose</option><option>Canada</option></select></label><button id="send" type="button">Submit application</button></form>',{runScripts:'outside-only',url:'https://jobs.ashbyhq.com/example/conditional'}),w=dom.window;
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});w.HTMLElement.prototype.getClientRects=function(){return this.isConnected?[{}]:[]};
 w.setInterval=()=>0;w.clearInterval=()=>{};let clicks=0;const messages=[];
 w.document.querySelector('#send').onclick=()=>clicks++;
 w.document.querySelector('select').onchange=()=>{w.setTimeout(()=>{const label=w.document.createElement('label');label.textContent='What is your current city?';const input=w.document.createElement('input');input.required=true;label.append(input);w.document.querySelector('form').prepend(label);},60)};
 w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);return {ok:true,data:m.action==='packet'?{job:{title:'Fixture'},profile:{location:'Toronto, Ontario, Canada'},answers:{},resume:{base64:''}}:m.action==='state'?{automatic:true,attempted:false}:{}};}}};
 w.eval(sources['extension/policy.js']);w.eval(sources['extension/content.js']);await new Promise(r=>setTimeout(r,750));
 assert.equal(w.document.querySelector('input').value,'Toronto');assert.equal(clicks,0);assert(!messages.some(m=>m.action==='attempt'));
 assert(messages.some(m=>m.action==='progress'&&/Ready to submit/.test(m.message)));w.close();
});

test('saved-answer recovery reuses approved facts, resumes once, and isolates attempts, consent, holds and incomplete forms',async()=>{
 const vm=require('node:vm'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(':memory:');
 const context=vm.createContext({process,Date,JSON,String,Set,Object,Error,console,URL});const modules={};
 const stubValues={
  './answer-library.js':{reusableAnswers:(_db,p)=>JSON.parse(p.answers_json||'{}'),canReuse:q=>!/(?:salary|authorization|why)/i.test(q)},
  './employer-limits.js':{employerHold:()=>null},'./company-application-policy.js':{companyApplicationPolicy:()=>({allowed:true})},
  './research-consent.js':{researchConsentWithdrawn:()=>false},
  './continuation-queue.js':{requestContinuation:()=>{throw Error('inject continuation')}}
 };
 const load=async spec=>{
  if(modules[spec])return modules[spec];
  if(stubValues[spec]){const v=stubValues[spec];return modules[spec]=new vm.SyntheticModule(Object.keys(v),function(){for(const [k,x]of Object.entries(v))this.setExport(k,x)},{context});}
  return modules[spec]=new vm.SourceTextModule(sources[spec.replace(/^\.\//,'')],{context});
 };
 const mod=await load('./saved-answer-recovery.js');await mod.link(load);await mod.evaluate();const {installSavedRecovery,recoverSavedAnswers,savedRecoveryStatus}=mod.namespace;
 db.exec("CREATE TABLE applicants(id TEXT,user_id TEXT,consent INTEGER,email TEXT,resume_path TEXT,name TEXT,location TEXT,answers_json TEXT);CREATE TABLE pipeline_preferences(user_id TEXT,auto_queue_found INTEGER);CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,status TEXT,local_phase TEXT,local_attempt_at TEXT,handoff_available INTEGER,challenge TEXT,required_fields_json TEXT,answers_json TEXT,updated_at TEXT,company TEXT,title TEXT);CREATE TABLE events(id INTEGER PRIMARY KEY,job_id TEXT,at TEXT,type TEXT,message TEXT);CREATE TABLE continuation_requests(job_id TEXT,state TEXT);INSERT INTO pipeline_preferences VALUES('u',1),('other',1),('off',0);");
 const facts=JSON.stringify({'LinkedIn Profile':'https://linkedin.com/in/example'});
 for(const [id,u,consent,a] of [['p','u',1,facts],['q','other',1,JSON.stringify({'LinkedIn Profile':'https://linkedin.com/in/other'})],['no','u',0,facts],['off','off',1,facts],['conflict','u',1,JSON.stringify({'LinkedIn':'one','LinkedIn profile':'two'})]])db.prepare("INSERT INTO applicants VALUES(?,?,?,'email','resume','Example','Toronto, Ontario, Canada',?)").run(id,u,consent,a);
 const question='Please provide a link to your LinkedIn profile';const add=(id,{u='u',p='p',attempt=null,status='local_browser',challenge=null,questions=[question],answers={},handoff=0}={})=>db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?, ?,?,?,?,'Company','Role')").run(id,u,p,status,'blocked',attempt,handoff,challenge,JSON.stringify(questions),JSON.stringify(answers),'2026-10-01');
 add('ready');add('partial',{questions:[question,'What products have you worked on?']});add('attempted',{attempt:'y'});add('event');db.exec("INSERT INTO events(job_id,at,type,message) VALUES('event','t','submission_started','attempt')");
 add('other',{u:'other',p:'q'});add('noconsent',{p:'no'});add('off',{u:'off',p:'off'});add('held');add('readySubmit',{challenge:'Ready to submit'});add('sensitive',{challenge:'Sensitive action'});add('captcha',{challenge:'CAPTCHA'});add('done',{status:'submitted'});add('conflict',{p:'conflict'});add('existing',{answers:{[question]:'https://linkedin.com/in/edited'}});add('handoff',{handoff:1});add('inflight');db.exec("INSERT INTO continuation_requests VALUES('inflight','dispatching')");
 installSavedRecovery(db);const calls=[],options={userId:'u',check:(_db,j)=>j.id==='held'?'hold':'',continueJob(db,u,id,check){
  const j=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);assert.equal(check(j),'');const a=JSON.parse(j.answers_json);if(JSON.parse(j.required_fields_json).some(q=>!a[q]))throw Error('partial');calls.push(id);db.prepare('INSERT INTO continuation_requests VALUES(?,?)').run(id,'queued');return {state:'queued'};
 }};
 const r=recoverSavedAnswers(db,options);assert.equal(r.filled,2);assert.equal(r.queued,1);assert.deepEqual(calls,['ready']);
 assert.equal(recoverSavedAnswers(db,options).filled,0);assert.equal(calls.length,1);
 for(const id of ['attempted','event','other','noconsent','held','off','readySubmit','sensitive','captcha','done','conflict','handoff','inflight'])assert.equal(db.prepare('SELECT answers_json FROM jobs WHERE id=?').get(id).answers_json,'{}',id);
 assert.equal(JSON.parse(db.prepare("SELECT answers_json FROM jobs WHERE id='existing'").get().answers_json)[question],'https://linkedin.com/in/edited');
 assert.equal(savedRecoveryStatus(db,'u').filled,2);assert.equal(savedRecoveryStatus(db,'other').filled,0);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type='submitted'").get().n,0);db.close();
});

test('preparation stages expose actionable counts without treating ready forms as receipts',()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict'),dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://example.test?view=settings'}),w=dom.window;
 w.setInterval=()=>0;w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);
 const jobs=[
  {id:'ready',company:'A',title:'Role',status:'local_browser',local_phase:'blocked',last_message:'Ready to submit — all supported fields are filled.',required_fields_json:'[]'},
  {id:'questions',company:'B',title:'Role',status:'local_browser',local_phase:'blocked',required_fields_json:'["LinkedIn"]'},
  {id:'captcha',status:'local_browser',local_phase:'blocked',last_message:'CAPTCHA requires you',required_fields_json:'["Name"]'},
  {id:'held',status:'needs_review',employer_hold:{message:'Limit'}},
  {id:'unknown',status:'needs_review'},
  {id:'awaiting',status:'local_browser',local_attempt_at:'y',last_message:'Ready to submit'},
  {id:'done',status:'submitted',evidence:{confirmed:true}},
  {id:'interview',status:'interview'},
  {id:'active',status:'queued'},
 ];
 w.fixtureJobs=jobs;assert.equal(w.eval('preparationStage(fixtureJobs[0])'),'ready');assert.equal(w.eval('preparationStage(fixtureJobs[5])'),'awaiting');assert.equal(w.eval('preparationStage(fixtureJobs[6])'),null);
 const board=w.eval('renderPreparationSummary(fixtureJobs.concat(fixtureJobs[0]))');w.document.querySelector('#workspace').prepend(board);
 for(const stage of ['ready','answers','employer','held','review'])assert.equal(board.querySelector('[data-preparation='+stage+'] strong').textContent,'1');
 assert(board.textContent.includes('Only employer receipts count'));
 for(const j of jobs){const c=w.document.createElement('article');c.className='job';c.dataset.state=j.status;c.dataset.search='';w.fixtureJob=j;c.dataset.preparation=w.eval('preparationStage(fixtureJob)')||'';w.document.querySelector('#jobs').append(c);}
 board.querySelector('[data-preparation=ready]').click();assert.equal([...w.document.querySelector('#jobs').children].filter(e=>!e.hidden).length,1);
 assert.equal(w.document.querySelector('#jobs').firstChild.hidden,false);
 w.close();
});

test('focused homepage shows pending jobs, keeps attempts separate and exposes unanswered forms without settings clutter',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict'),dom=new JSDOM(sources['assistant-page.html'],{runScripts:'outside-only',url:'https://example.test'}),w=dom.window;
 const job=(id,extra={})=>({id,applicant_id:'p',company:'Example '+id,title:'Platform Engineer '+id,execution_mode:'local',status:'needs_review',required_fields_json:'[]',url:'https://example.test/jobs/'+id,...extra});
 const jobs=[job('question',{challenge:'Missing answers',required_fields_json:'["Describe your experience"]'}),job('ready',{challenge:'Ready to submit',handoff_available:1}),job('attempt',{challenge:'Unconfirmed submission'}),job('done',{status:'submitted'}),job('queued',{status:'queued'}),job('local',{status:'local_browser',local_phase:'blocked',last_message:'Ready to submit — all fields filled.'})];
 const operations={totals:{confirmed:1,worked:3,awaiting:1},applications:[{id:'done',confirmed:true,worked:true},{id:'attempt',awaiting:true,attempted:true,worked:true}],checkedAt:new Date().toISOString()};
 w.setInterval=()=>0;w.HTMLElement.prototype.scrollIntoView=()=>{};const calls=[];
 w.fetch=async(url,options={})=>{calls.push([String(url),options.method]);const p=new URL(url,'https://example.test').pathname;
 const data=p==='/api/jobs'?{jobs}:p==='/api/operations'?operations:p==='/api/status'?{workerOnline:true}:p==='/api/application-history'?{records:[{id:'ext',company:'Elsewhere',title:'SRE',status:'interview'}]}:p==='/api/continuations'?{requests:[]}:p==='/api/pipeline'?{enabled:true,found:0}:p==='/api/employer-limits'?{limits:[]}:p==='/api/searches'?{searches:[]}:p==='/api/work-focus'?{enabled:false}:p==='/api/activity'?{events:[]}:{};return {ok:true,json:async()=>data};};
 w.eval(sources['extension/policy.js']);w.eval(sources['assistant-client.js']);await w.refresh(true);await new Promise(r=>setTimeout(r,30));
 const $=s=>w.document.querySelector(s),visible=()=>[...$('#jobs').children].filter(c=>!c.hidden).map(c=>c.id);
 assert.deepEqual(visible().sort(),['job-local','job-question','job-ready']);
 assert.equal($('#jobs').firstElementChild.id,'external-ext');assert.equal($('#job-ready').hidden,false);
 assert.equal($('#home-summary [data-home-filter="pending"] strong').textContent,'3');
 assert.equal(w.getComputedStyle($('#job-search')).display,'none');assert.equal(w.getComputedStyle($('.tabs')).display,'none');
 assert.equal($('#home-summary [data-home-filter="prep-ready"] strong').textContent,'2');
 assert.equal($('#home-summary [data-home-filter="receipt"] strong').textContent,'1');
 assert.equal($('#home-summary [data-home-filter="awaiting"] strong').textContent,'1');
 assert.equal($('#home-summary [data-home-filter="interview"] strong').textContent,'1');
 assert.equal($('#workspace-tools').open,false);assert.equal($('#interview-panel').open,false);
 for(const id of ['operations','next-match','application-pipeline','employer-limits','browser-readiness','discovery-status','blocker-notifications'])assert.equal($('#'+id).parentElement.id,'workspace-tools-body',id);
 assert.equal($('#career-overview').parentElement.id,'interview-panel-body');assert.equal($('#ai-status').parentElement.id,'ai-status-slot');assert.equal($('#ai-status .ai-details').open,false);
 assert.equal($('#missing-answers').querySelector('form').closest('details'),null,'unanswered form must be immediately visible');
 const input=$('#missing-answers textarea');input.value='My unfinished answer';input.dispatchEvent(new w.Event('input',{bubbles:true}));
 await w.refresh();assert.equal($('#missing-answers textarea'),input);assert.equal(input.value,'My unfinished answer');
 $('#home-summary [data-home-filter="awaiting"]').click();assert(!visible().includes('job-attempt'),'receipt counts do not expose finished work on the focused homepage');
 $('#home-summary [data-home-filter="prep-ready"]').click();assert.deepEqual(visible().sort(),['job-local','job-ready']);
 $('#home-summary [data-home-filter="receipt"]').click();assert(!visible().includes('job-done'));assert.equal(w.document.body.dataset.view,'focus');assert.equal(w.getComputedStyle($('#workspace-tools')).display,'none');assert.equal(w.getComputedStyle($('#ai-status-slot')).display,'none');
 $('a[data-open-panel="interview-panel"]').click();assert.equal($('#interview-panel').open,true);
 assert(!calls.some(([url,method])=>method&&method!=='GET'),'refresh and filters must not change applications or open handoffs');
 assert.equal(w.pendingSubmission(job('stale-ready',{challenge:'Ready to submit',local_attempt_at:'2026-10-01'})),false);
 assert.equal(w.pendingSubmission(job('in-progress',{challenge:'Submission in progress'})),false);
 w.renderHomeSummary(null,jobs,[]);assert.equal($('#home-summary [data-home-filter="receipt"] strong').textContent,'—','unavailable totals are not zero');
 w.close();
});

test('Gemini accepts cited newline-separated claims and retries incomplete citations once without accepting uncited text',async()=>{
 const assert=require('node:assert/strict'),source=sources['google-research.js'].replace(/^import .+;\s*$/gm,'').replace(/\bexport\s+(?=(?:async\s+)?function|const)/g,'');
 const {researchAnswer}=new Function('isIP','Buffer','AbortSignal',source+';return {researchAnswer};')(require('node:net').isIP,Buffer,AbortSignal);
 const url='https://job-boards.greenhouse.io/example/jobs/1234';let calls=0,mode='lines';
 const claims=['Maintain infrastructure','Investigate production incidents'],intro='Uncited heading\n',ending='\nUnsupported closing sentence.';
 const options={question:'What are the responsibilities of this role?',job:{url},env:{GEMINI_API_KEY:'fixture-only'},fetchImpl:async(endpoint,request)=>{
  calls++;const body=JSON.parse(request.body),input=JSON.parse(body.input);assert.equal(input.publicJobUrl,url);assert.equal(body.store,false);assert.deepEqual(body.tools,[{type:'url_context'}]);
  if(mode==='http')return {ok:false,status:429};
  const text=mode==='lines'?intro+claims.join('\n')+ending:'Maintain reliable infrastructure.';
  const annotations=mode==='lines'?claims.map((claim,i)=>({type:'url_citation',url,start_index:Buffer.byteLength(intro+(i?claims[0]+'\n':'')),end_index:Buffer.byteLength(intro+(i?claims[0]+'\n':'')+claim)})):mode==='retry'&&calls===2?[{type:'url_citation',url,start_index:0,end_index:Buffer.byteLength(text)}]:[];
  if(calls===2)assert(input.task.includes('one short, complete factual sentence'));
  return{ok:true,json:async()=>({status:'completed',steps:[{type:'url_context_call',id:'one',arguments:{urls:[url]}},{type:'url_context_result',call_id:'one',result:[{url,status:'success'}]},{type:'model_output',content:[{type:'text',text,annotations}]}]})};
 }};
 let result=await researchAnswer(options);assert.equal(result.answer,claims.join('\n'));assert.equal(calls,1);assert(!result.answer.includes('Uncited'));assert(!result.answer.includes('Unsupported'));
 calls=0;mode='retry';result=await researchAnswer(options);assert.equal(result.answer,'Maintain reliable infrastructure.');assert.equal(calls,2);
 calls=0;mode='uncited';await assert.rejects(researchAnswer(options),/No answer was filled/);assert.equal(calls,2);
 calls=0;mode='http';await assert.rejects(researchAnswer(options),/quota limit/);assert.equal(calls,1);
});

function factModule(bindings={}){
 const code=sources['answer-drafts.js'].replace(/^import .+;\s*$/gm,'').replace(/\bexport\s+(?=(?:async\s+)?function|const)/g,'');
 const deps={canCapture:q=>typeof q==='string'&&q.length<=240&&!/\b(?:consent|agree|signature|captcha|password)\b/i.test(q),canReuse:q=>!/\b(?:why|salary|visa|authorization|availability)\b/i.test(q),reusableAnswers:(_db,p)=>JSON.parse(p.answers_json||'{}'),installFactDrafts:()=>{},resumeText:async()=>'',extname:()=>'.pdf',...bindings};
 return new Function(...Object.keys(deps),code+';return {draftAnswer,geminiFactAnswer,canDraftProfessional,professionalFacts,draftForJob};')(...Object.values(deps));
}
test('Gemini professional answers require separate consent, exact supporting quotes and private-fact minimization',async()=>{
 const assert=require('node:assert/strict'),{geminiFactAnswer}=factModule();let sent,calls=0,output={answer:'I build Kubernetes platforms.',reason:'',evidence:[{id:'1',quote:'I build Kubernetes platforms.'}]};
 const opts={question:'Describe your technical experience',profile:{gemini_facts_consent:1},job:{title:'Platform Engineer',company:'Example'},answers:{'Professional background':'I build Kubernetes platforms. Contact private@example.com https://secret.example/profile','Email':'private@example.com','Phone':'555-555-5555','Work authorization':'private status'},env:{GEMINI_API_KEY:'test-key'},fetchImpl:async(url,request)=>{calls++;assert(url.endsWith('/interactions'));sent=JSON.parse(request.body);return {ok:true,json:async()=>({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify(output)}]}]})};}};
 await assert.rejects(geminiFactAnswer({...opts,profile:{google_research_consent:1}}),/Enable Gemini/);assert.equal(calls,0);
 const result=await geminiFactAnswer(opts);assert.equal(result.answer,output.answer);assert.equal(result.provider,'gemini');assert.deepEqual(result.sources,['Professional background']);
 assert.equal(sent.store,false);assert.equal(sent.tools,undefined);assert.equal(sent.response_format.mime_type,'application/json');
 assert(!sent.input.includes('private@example'));assert(!sent.input.includes('555-555'));assert(!sent.input.includes('secret.example'));assert(!sent.input.includes('private status'));
 output.evidence=[{id:'1',quote:'Invented production leadership'}];await assert.rejects(geminiFactAnswer(opts),/support/);
 output.evidence=[];await assert.rejects(geminiFactAnswer(opts),/support/);
 output={answer:'',reason:'A specific incident is not in the saved facts.',evidence:[]};assert.equal((await geminiFactAnswer(opts)).answer,'');
 const n=calls;for(const question of ['What salary do you want?','Are you authorized to work?','When are you available?','Solve this coding assessment','Do you agree to the terms?'])assert.equal((await geminiFactAnswer({...opts,question})).answer,'');assert.equal(calls,n);
 assert.equal((await geminiFactAnswer({...opts,fetchImpl:async()=>({ok:false,status:429})}).catch(e=>e.message)).includes('429'),true);
});
test('Gemini uses saved resume professional content and respects exact choice and number formats',async()=>{
 const assert=require('node:assert/strict'),{draftAnswer,geminiFactAnswer}=factModule({resumeText:async()=> 'Private Person\nPrivate City\nemail: hidden@example.com\nBuilt reliable Kubernetes platforms.\nManaged incident response.'});
 let sent;const base={question:'Describe your technical experience',profile:{gemini_facts_consent:1,resume_path:'resume.pdf',name:'Private Person',location:'Private City'},job:{title:'Engineer',company:'Example'},answers:{},env:{GEMINI_API_KEY:'test-key'},fetchImpl:async(_url,r)=>{sent=JSON.parse(r.body);return{ok:true,json:async()=>({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify({answer:'I built reliable Kubernetes platforms.',reason:'',evidence:[{id:'1',quote:'Built reliable Kubernetes platforms.'}]})}]}]})};}};
 assert((await draftAnswer(base)).answer.includes('Kubernetes'));assert(sent.input.includes('Managed incident response'));for(const privateText of ['Private Person','Private City','hidden@example.com'])assert(!sent.input.includes(privateText));
 const fetchImpl=async(_url,r)=>({ok:true,json:async()=>({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify({answer:'Not one of the options',reason:'',evidence:[{id:'1',quote:'I build Kubernetes platforms.'}]})}]}]})});
 const result=await geminiFactAnswer({...base,profile:{gemini_facts_consent:1},answers:{Skills:'I build Kubernetes platforms.'},choices:['Yes','No'],fetchImpl});assert.equal(result.answer,'');assert(result.reason.includes('field format'));
 assert.equal((await geminiFactAnswer({...base,answers:{Skills:'I build Kubernetes platforms.'},answerFormat:'number',fetchImpl})).answer,'');
});
test('application AI preparation preserves concurrent edits, owner changes, consent and prior attempts',async()=>{
 const assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE applicants(id TEXT,user_id TEXT,consent INTEGER,gemini_facts_consent INTEGER,ai_consent INTEGER,google_research_consent INTEGER);CREATE TABLE jobs(id TEXT,user_id TEXT,applicant_id TEXT,status TEXT,local_owner TEXT,local_attempt_at TEXT,handoff_available INTEGER,url TEXT,answers_json TEXT,updated_at TEXT);CREATE TABLE events(job_id TEXT,type TEXT);INSERT INTO applicants VALUES('p','u',1,1,0,1);INSERT INTO jobs VALUES('j','u','p','local_browser','device',NULL,0,'https://example.test/job','{}','now');");
 const src=sources['form-answer.js'].replace(/^import .+;\s*$/gm,'').replace(/\bexport\s+(?=(?:async\s+)?function|const)/g,'');
 const {prepareFormAnswer}=new Function('canResearchQuestion','researchForJob','markResearchDraftUsed','canDraftProfessional','draftForJob','researchConsentWithdrawn',src+';return {prepareFormAnswer};')(()=>false,()=>{throw Error('wrong provider')},()=>{},()=>true,()=>{},()=>false);
 const q='Describe your technical experience',good={answer:'I build Kubernetes platforms.',provider:'gemini',sources:['Skills']};
 await assert.rejects(prepareFormAnswer(db,'other','j',q),/cannot be prepared/);
 await assert.rejects(prepareFormAnswer(db,'u','j',q,{check:()=> 'Employer hold'}),/Employer hold/);
 let result=await prepareFormAnswer(db,'u','j',q,{expectedOwner:'device',draft:async()=>{db.prepare("UPDATE jobs SET answers_json=? WHERE id='j'").run(JSON.stringify({[q]:'My own edit',other:'Preserve me'}));return good;}});assert.equal(result.answer,'My own edit');
 db.exec("UPDATE jobs SET answers_json='{}'");
 for(const mutation of ["UPDATE jobs SET local_attempt_at='attempt'","UPDATE jobs SET local_owner='other'","UPDATE applicants SET gemini_facts_consent=0"]){
  await assert.rejects(prepareFormAnswer(db,'u','j',q,{expectedOwner:'device',draft:async()=>{db.exec(mutation);return good;}}),/changed/);
  assert.equal(db.prepare('SELECT answers_json FROM jobs').get().answers_json,'{}');db.exec("UPDATE jobs SET local_attempt_at=NULL,local_owner='device';UPDATE applicants SET gemini_facts_consent=1");
 }
 result=await prepareFormAnswer(db,'u','j',q,{draft:async()=>good});assert.equal(result.answer,good.answer);assert.equal(db.prepare('SELECT status FROM jobs').get().status,'local_browser');assert.equal(db.prepare('SELECT local_attempt_at FROM jobs').get().local_attempt_at,null);
 db.exec("UPDATE jobs SET answers_json='{}';INSERT INTO events VALUES('j','submission_started')");await assert.rejects(prepareFormAnswer(db,'u','j',q,{draft:async()=>{throw Error('must not call')}}),/cannot be prepared/);db.close();
});
test('AI-filled browser fields reach manual Submit without overwriting user input or recording an attempt',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
 async function scenario(edit=false){
  const dom=new JSDOM('<form><label>Describe your technical skills<textarea required></textarea></label><button type="button" id="submit">Submit application</button></form>',{runScripts:'outside-only',url:'https://jobs.ashbyhq.com/example/12345678-1234-1234-1234-123456789abc'}),w=dom.window,messages=[];
  Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent}});w.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}]};w.setInterval=()=>0;w.clearInterval=()=>{};
  let clicks=0;w.document.querySelector('#submit').onclick=()=>clicks++;
  w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);if(m.action==='packet')return {ok:true,data:{job:{title:'Engineer'},profile:{},answers:{},aiAssistance:true}};if(m.action==='state')return{ok:true,data:{attempted:false,automatic:true}};if(m.action==='answer'){if(edit)w.document.querySelector('textarea').value='User typed while Gemini was working';return{ok:true,data:{answer:'I build Kubernetes platforms.',source:'approved_facts'}};}return{ok:true,data:{}};}}};
  w.eval(sources['extension/policy.js']);w.eval(sources['extension/content.js']);
  for(let i=0;i<100&&!messages.some(m=>m.action==='progress'&&m.blocked);i++)await new Promise(r=>setTimeout(r,25));
  assert.equal(w.document.querySelector('textarea').value,edit?'User typed while Gemini was working':'I build Kubernetes platforms.');
  assert(messages.some(m=>m.action==='progress'&&m.message.includes('Ready to submit')));assert.equal(clicks,0);assert(!messages.some(m=>m.action==='attempt'));assert.equal(messages.filter(m=>m.action==='answer').length,1);w.close();
 }
 await scenario();await scenario(true);
});
test('Gemini failures leave unanswered employer questions visible without generating a submission',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict'),dom=new JSDOM('<form><label>Describe your technical skills<textarea required></textarea></label><button>Submit application</button></form>',{runScripts:'outside-only',url:'https://jobs.ashbyhq.com/example/12345678-1234-1234-1234-123456789abc'}),w=dom.window,messages=[];
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent}});w.HTMLElement.prototype.getClientRects=()=>[{}];w.setInterval=()=>0;w.clearInterval=()=>{};
 w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);if(m.action==='packet')return {ok:true,data:{job:{title:'Engineer'},profile:{},answers:{},aiAssistance:true}};if(m.action==='state')return{ok:true,data:{attempted:false,automatic:true}};if(m.action==='answer')return{ok:false,error:'Gemini returned HTTP 429'};return{ok:true,data:{}};}}};
 w.eval(sources['extension/policy.js']);w.eval(sources['extension/content.js']);for(let i=0;i<80&&!messages.some(m=>m.action==='progress'&&m.blocked);i++)await new Promise(r=>setTimeout(r,25));
 assert.equal(w.document.querySelector('textarea').value,'');assert(messages.some(m=>m.action==='progress'&&m.fields.includes('Describe your technical skills')&&m.message.includes('429')));assert(!messages.some(m=>m.action==='attempt'));w.close();
});
test('professional AI drafts remain application-only and withdrawal blocks later preparation',()=>{
 const assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY)');db.exec("INSERT INTO jobs VALUES('j')");
 const src=sources['draft-provenance.js'].replace(/\bexport\s+(?=(?:async\s+)?function|const)/g,'');
 const p=new Function(src+';return {installFactDrafts,hasFactDraft,factDraftProvider,factDraftConsentWithdrawn};')();p.installFactDrafts(db);
 db.prepare('INSERT INTO fact_drafts VALUES(?,?,?,?,?,?)').run('j','Technical skills','Kubernetes','gemini','["Skills"]','now');
 assert(p.hasFactDraft(db,'j','Technical skills'));assert.equal(p.factDraftProvider(db,'j','Technical skills','Kubernetes'),'gemini');assert(p.factDraftConsentWithdrawn(db,'j',{google_research_consent:1,ai_consent:1}));assert(!p.factDraftConsentWithdrawn(db,'j',{gemini_facts_consent:1}));
 assert(sources['answer-library.js'].includes('!hasFactDraft(db,j.id'));assert(sources['server.js'].includes('!hasFactDraft(db,j.id,q.trim())'));db.close();
});

test('paused professional recovery respects holds, attempts, separate consent and retry cooldowns',async()=>{
 const assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE applicants(id TEXT,user_id TEXT,consent INTEGER,gemini_facts_consent INTEGER,ai_consent INTEGER);CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,status TEXT,local_phase TEXT,local_attempt_at TEXT,handoff_available INTEGER,required_fields_json TEXT,answers_json TEXT,updated_at TEXT);CREATE TABLE work_focus(user_id TEXT,enabled INTEGER,job_id TEXT);CREATE TABLE public_fill_attempts(job_id TEXT,question TEXT,attempted_at TEXT,state TEXT,message TEXT,PRIMARY KEY(job_id,question));INSERT INTO applicants VALUES('p','u',1,1,0),('off','u',1,0,0);");
 const q='Describe your technical skills';
 for(const [id,p,attempt] of [['ready','p',null],['held','p',null],['attempted','p','attempt'],['off','off',null]])db.prepare("INSERT INTO jobs VALUES(?,?,?,'local_browser','blocked',?,0,?,'{}','now')").run(id,'u',p,attempt,JSON.stringify([q]));
 const src=sources['paused-fact-fill.js'].replace(/^import .+;\s*$/gm,'').replace(/\bexport\s+(?=(?:async\s+)?function|const)/g,'');let calls=[],continuations=[];
 const {fillPendingFactQuestions}=new Function('canDraftProfessional','prepareFormAnswer','requestContinuation','employerHold','companyApplicationPolicy','researchConsentWithdrawn',src+';return {fillPendingFactQuestions};')(()=>true,()=>{},(_db,_u,id)=>continuations.push(id),(_db,j)=>j.id==='held'?{message:'Hold'}:null,()=>({allowed:true,message:'This message must not block when allowed'}),()=>false);
 const opts={env:{GEMINI_API_KEY:'test'},prepare:async(_db,_u,id,question,{check})=>{calls.push(id);assert.equal(check(db.prepare('SELECT * FROM jobs WHERE id=?').get(id)),'');db.prepare('UPDATE jobs SET answers_json=? WHERE id=?').run(JSON.stringify({[question]:'Supported professional answer'}),id);return{answer:'Supported professional answer'};}};
 await fillPendingFactQuestions(db,opts);assert.deepEqual(calls,['ready']);assert.deepEqual(continuations,['ready']);await fillPendingFactQuestions(db,opts);assert.equal(calls.length,1);
 db.exec("UPDATE jobs SET answers_json='{}' WHERE id='ready'");await fillPendingFactQuestions(db,opts);assert.equal(calls.length,1,'same question has a retry cooldown');
 for(const id of ['held','attempted','off'])assert.equal(db.prepare('SELECT answers_json FROM jobs WHERE id=?').get(id).answers_json,'{}');db.close();
});
test('Gemini exact option answers fill native select and radio fields without clicking Submit',async()=>{
 const {JSDOM}=require('jsdom'),assert=require('node:assert/strict'),dom=new JSDOM('<form><label>Which technical skill do you use?<select required><option disabled selected value="">Select</option><option>Kubernetes</option><option>Java</option></select></label><fieldset><legend>Do you have Kubernetes experience?</legend><label><input type="radio" name="experience" required value="yes">Yes</label><label><input type="radio" name="experience" required value="no">No</label></fieldset><button type="button">Submit application</button></form>',{runScripts:'outside-only',url:'https://jobs.ashbyhq.com/example/12345678-1234-1234-1234-123456789abc'}),w=dom.window,messages=[];
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent}});w.HTMLElement.prototype.getClientRects=()=>[{}];w.setInterval=()=>0;w.clearInterval=()=>{};
 w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);if(m.action==='packet')return{ok:true,data:{job:{title:'Engineer'},profile:{},answers:{},aiAssistance:true}};if(m.action==='state')return{ok:true,data:{attempted:false,automatic:true}};if(m.action==='answer'){const choice=m.question.startsWith('Which')?'Kubernetes':'Yes';assert(m.choices.includes(choice));return{ok:true,data:{answer:choice}};}return{ok:true,data:{}};}}};
 w.eval(sources['extension/policy.js']);w.eval(sources['extension/content.js']);for(let i=0;i<100&&!messages.some(m=>m.action==='progress'&&m.blocked);i++)await new Promise(r=>setTimeout(r,25));
 assert.equal(w.document.querySelector('select').value,'Kubernetes');assert(w.document.querySelector('input[value="yes"]').checked);assert(!w.document.querySelector('input[value="no"]').checked);assert(messages.some(m=>m.action==='progress'&&m.message.includes('Ready to submit')));assert(!messages.some(m=>m.action==='attempt'));w.close();
});
