const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{JSDOM}=require('jsdom');
const read=p=>fs.readFileSync(p,'utf8'),tick=()=>new Promise(r=>setImmediate(r));
const id='11111111-1111-1111-1111-111111111111';
const ready=(extra={})=>({id,title:'Platform Engineer',company:'Fixture',url:'https://jobs.ashbyhq.com/fixture/role',status:'needs_review',challenge:'Ready to submit',handoff_available:1,required_fields_json:'[]',evidence:{filled:true},...extra});
function background({jobs=[ready()],records={},view={},probe={},tabs=[{id:5,windowId:1,url:'https://jobs.ashbyhq.com/fixture/role'}],execute=async()=>[{result:{opened:true}}]}={}){
 const calls=[],noop={addListener(){}},state={records,device:'fixture',automaticDefault:true};
 const chrome={runtime:{onMessage:noop,onStartup:noop,onInstalled:noop},alarms:{onAlarm:noop},storage:{local:{get:async()=>structuredClone(state)}},tabs:{onRemoved:noop,get:async key=>{const tab=tabs.find(t=>t.id===key);if(!tab)throw Error('Tab closed');return tab;},query:async()=>tabs,update:async(...args)=>{calls.push(['focus',...args]);}},windows:{update:async(...args)=>calls.push(['window',...args])},scripting:{executeScript:execute}};
 const ctx=vm.createContext({chrome,URL,Date,importScripts(){},setTimeout,clearTimeout});vm.runInContext(read('extension/policy.js')+read('extension/ready-forms.js')+read('extension/background.js')+';globalThis.list=readyJobs;globalThis.open=reviewPrepared;api=(...args)=>testApi(...args);probeForm=async()=>testProbe;responsiveDashboardId=9;',ctx);
 ctx.testProbe={started:true,stopped:true,readyForSubmit:true,jobId:id,url:jobs[0]?.url,...probe};
 ctx.testApi=async(path,method='GET',data)=>{calls.push([path,method,data]);if(path==='/jobs')return {jobs};if(path==='/operations')return {applications:jobs.filter(j=>j.evidence).map(j=>({id:j.id,...j.evidence}))};if(path.endsWith('/handoff/view'))return {frameId:'frame',expiresAt:Date.now()+3600000,...view};throw Error('Unexpected request '+path);};
 return {ctx,calls,state,jobs};
}
test('ready list excludes unfinished, missing, attempted, held and lost hosted forms',async()=>{
 const changes=[{status:'queued'},{status:'submitted'},{challenge:'Missing answers'},{handoff_available:0},{required_fields_json:'["Degree"]'},{required_fields_json:'broken'},{editing_questions:['Name']},{local_attempt_at:'today'},{confirmation:'receipt'},{manual_submit_clicks:1},{employer_hold:{}},{metadata:{available:false}},{evidence:{attempted:true}},{evidence:{awaiting:true}},{evidence:{completed:true}},{evidence:undefined}];
 const f=background({jobs:[ready(),...changes.map((change,n)=>ready({id:'other-'+n,...change}))]});
 assert.deepEqual(Array.from((await f.ctx.list()).jobs,j=>j.id),[id]);assert.equal(f.calls.filter(c=>c[0].endsWith('/handoff/view')).length,1);
 for(const view of [{submitted:true},{closed:true},{frameId:null},{expiresAt:Date.now()-1}])assert.equal((await background({view}).ctx.list()).jobs.length,0);
 const failed=background();failed.ctx.testApi=async p=>{if(p==='/jobs')return {jobs:[ready()]};if(p==='/operations')return {applications:[{id}]};throw Error('Worker unavailable');};assert.equal((await failed.ctx.list()).jobs.length,0);
});
test('local forms require a live identity-matched final step; open only focuses and never refills',async()=>{
 const job=ready({status:'local_browser',local_phase:'blocked',challenge:'Local browser',handoff_available:0}),record={id,url:job.url,tabId:5,phase:'prepared'};
 const options={jobs:[job],records:{[id]:record}};
 const f=background(options);assert.equal((await f.ctx.list()).jobs[0].ready_form.source,'local');await f.ctx.open(id);
 assert(f.calls.some(c=>c[0]==='focus'));assert(!f.calls.some(c=>c[1]==='POST'),'local review only reads the server and focuses an existing tab');
 for(const probe of [{readyForSubmit:false},{attempted:true},{busy:true},{started:false},{jobId:'another'},{url:'https://jobs.ashbyhq.com/fixture/other'}])assert.equal((await background({...options,probe}).ctx.list()).jobs.length,0);
 for(const patch of [{attempted:true},{pendingClicks:{one:{}}},{phase:'blocked'},{tabId:77}])assert.equal((await background({...options,records:{[id]:{...record,...patch}}}).ctx.list()).jobs.length,0);
 assert.equal((await background({...options,tabs:[{id:5,url:job.url},{id:6,url:job.url}]}).ctx.list()).jobs.length,0);
});
test('click-time recheck refuses an expired or already attempted application',async()=>{
 const f=background();assert.equal((await f.ctx.list()).jobs.length,1);f.jobs[0].evidence.attempted=true;
 await assert.rejects(f.ctx.open(id),/no longer ready/);assert(!f.calls.some(c=>c[0]==='focus'));
 await assert.rejects(f.ctx.open('../other'),/Choose a prepared/);
});
test('hosted ready action opens the deployed viewer directly without claim, restart, filling or Submit',async()=>{
 const dom=new JSDOM(read('assistant-page.html'),{url:'https://marvelous-vitality-production-c2d8.up.railway.app/assistant',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,requests=[];
 w.setInterval=()=>0;w.setTimeout=()=>0;w.fetch=async(url,opts={})=>{requests.push([String(url),opts.method]);return {ok:true,json:async()=>String(url).endsWith('/view')?{image:'AA==',frameId:'frame',expiresAt:Date.now()+3600000,host:'jobs.ashbyhq.com'}:{jobs:[]}};};
 w.eval(read('assistant-client.js'));
 const f=background({tabs:[{id:9,windowId:2,url:w.location.href}],execute:async({func,args,world})=>{assert.equal(world,'MAIN');return [{result:await w.eval('('+func.toString()+')('+JSON.stringify(args[0])+')')}];}});
 try{assert.equal((await f.ctx.open(id)).opened,true);assert(w.document.querySelector('#live-surface img').src);assert.equal(w.document.querySelector('.live-primary').hidden,true);assert(requests.some(c=>c[0].endsWith('/handoff/view')));assert(f.calls.some(c=>c[0].endsWith('/handoff/view')));assert(![...f.calls,...requests].some(c=>/local\/claim|handoff\/(open|resume|click|key|text|upload)|report-submitted/.test(c[0])));
  const other=ready({id:'22222222-2222-2222-2222-222222222222'});f.jobs.push(other);await assert.rejects(f.ctx.open(other.id),/Close the other live/);assert.equal(w.document.querySelectorAll('#live-browser').length,1);
 }finally{w.close();}
});
test('popup shows only live ready forms and its single job action never reports completion',async()=>{
 const dom=new JSDOM(read('extension/popup.html'),{runScripts:'outside-only'}),w=dom.window,calls=[];let resolveOpen;
 w.setInterval=()=>0;w.eval(read('extension/ready-forms.js'));
 const live=ready({ready_form:{source:'hosted',checked_at:Date.now(),expires_at:Date.now()+3600000}});
 w.chrome={runtime:{sendMessage:async message=>{calls.push(message);if(message.action==='list')return {ok:true,data:{state:{enabled:true},jobs:[live,live,ready({id:'queued',status:'queued'}),ready({id:'expired',ready_form:{source:'hosted',checked_at:Date.now(),expires_at:Date.now()-1}})]}};return new Promise(r=>resolveOpen=r);}}};
 try{w.eval(read('extension/popup.js'));await tick();assert.equal(w.document.querySelectorAll('article').length,1);const button=w.document.querySelector('article button');assert.equal(button.textContent,'Open filled form');assert.equal(w.document.querySelectorAll('article button').length,1);button.click();button.click();assert.equal(calls.filter(c=>c.action==='review-prepared').length,1);assert(button.disabled);
  resolveOpen({ok:true,data:{opened:true}});await tick();assert.match(w.document.querySelector('.job-action-status').textContent,/click the employer/);assert(!button.disabled);assert(!calls.some(c=>['open','mark-completed','start'].includes(c.action)));
 }finally{w.close();}
});
test('content readiness probe reads back required values without changing the employer form',()=>{
 const dom=new JSDOM('<form><label>Name<input required value="Fixture"></label><button type="button">Submit application</button></form>',{url:'https://jobs.ashbyhq.com/fixture/role',runScripts:'outside-only'}),w=dom.window;let receive;
 w.HTMLElement.prototype.getClientRects=()=>[{}];Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});w.chrome={runtime:{onMessage:{addListener(fn){receive=fn;}},sendMessage(){throw Error('Probe must not write');}}};
 w.eval(read('extension/policy.js'));w.eval(read('extension/content.js').replace(/begin\(\);\s*\}\)\(\);/,`packet={job:{id:'${id}'},answers:{},profile:{}};started=true;stopped=true;})();`));
 const probe=()=>{let result;receive({action:'preparation-status'},{},r=>result=r);return result;};
 try{assert.equal(probe().readyForSubmit,true);assert.equal(probe().jobId,id);w.document.querySelector('input').value='';assert.equal(probe().readyForSubmit,false);w.document.querySelector('input').value='Fixture';w.document.querySelector('button').textContent='Next';assert.equal(probe().readyForSubmit,false);assert.equal(w.document.querySelector('input').value,'Fixture');}finally{w.close();}
});
