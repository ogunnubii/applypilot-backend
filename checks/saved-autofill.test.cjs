const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const wait=ms=>new Promise(r=>setTimeout(r,ms));

test('visible field labels win over generic metadata and genuine saved conflicts remain blank',async()=>{
 const {JSDOM}=require('jsdom');
 const dom=new JSDOM('<form><label>First name<input id="name" required></label><label>Last name<input name="name" id="last" required></label><label>City<input id="city" required></label><label>Email<input id="email" required></label><label>First and last name<input id="combined-name" required></label><button type="button">Submit application</button></form>',{runScripts:'outside-only',url:'https://jobs.lever.co/example/test'}),w=dom.window;
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});w.HTMLElement.prototype.getClientRects=function(){return [{}]};w.setInterval=()=>0;
 let listener,linked=false,attempted=false,clicks=0;const messages=[];
 w.document.querySelector('button').onclick=()=>clicks++;
 w.chrome={runtime:{onMessage:{addListener(fn){listener=fn;}},async sendMessage(m){messages.push(m);if(!linked)return {ok:false,error:'Not linked yet'};return {ok:true,data:m.action==='packet'?{job:{title:'Fixture',attempted},profile:{name:'Test Applicant',email:'test@example.test'},answers:{City:'Toronto','Current city':'Ottawa'}}:m.action==='state'?{attempted,automatic:true}:{}};}}};
 w.eval(read('extension/policy.js'));w.eval(read('extension/content.js'));await wait(30);
 assert.equal(w.document.querySelector('#name').value,'');linked=true;
 await new Promise(resolve=>listener({action:'fill'},{},resolve));
 assert.equal(w.document.querySelector('#name').value,'Test');assert.equal(w.document.querySelector('#last').value,'Applicant');assert.equal(w.document.querySelector('#email').value,'test@example.test');assert.equal(w.document.querySelector('#city').value,'');
 assert.equal(w.document.querySelector('#combined-name').value,'Test Applicant');
 assert.equal(clicks,0);assert(!messages.some(m=>m.action==='attempt'));
 // A newly observed server attempt must prevent even a refill, not just Submit.
 w.document.querySelector('#email').value='';attempted=true;
 await new Promise(resolve=>listener({action:'fill'},{},resolve));assert.equal(w.document.querySelector('#email').value,'');w.close();
});

test('unapproved captured answers cannot suppress approved profile answers',async()=>{
 const {reusableAnswers}=await import('../answer-library.js');
 const rows=[{question:'City',answer:'Ottawa',reusable:0,confirmed:0,reuse_reviewed:0},{question:'Current city',answer:'Montreal',reusable:0,confirmed:1,reuse_reviewed:1}];
 const db={prepare:()=>({all:()=>rows})},p={id:'p',user_id:'u',answers_json:JSON.stringify({City:'Toronto'})};
 assert.equal(reusableAnswers(db,p).City,'Toronto');
 rows.push({question:'Current city',answer:'Vancouver',reusable:1,confirmed:0,reuse_reviewed:1});
 assert.equal(reusableAnswers(db,p).City,undefined,'approved conflicting facts must still require review');
});

test('focus-existing releases the message queue so the form can fetch its saved answers',async()=>{
 let listener,packetReceived=false;
 const state={records:{j:{id:'j',tabId:2,url:'https://jobs.lever.co/example/test',auto:false,phase:'blocked'}},automaticDefault:true,device:'fixture'};
 const noOp={addListener(){}},chrome={storage:{local:{get:async()=>state,set:async v=>Object.assign(state,v),setAccessLevel:async()=>{}}},
 tabs:{get:async()=>({id:2,windowId:1,url:state.records.j.url}),update:async()=>{},query:async()=>[{id:1}],onRemoved:noOp,
 sendMessage:()=>new Promise(resolve=>listener({action:'packet'},{tab:{id:2},frameId:0,url:state.records.j.url},r=>{packetReceived=r.ok;resolve(r);}))},windows:{update:async()=>{}},
 scripting:{executeScript:async()=>[{result:{data:{job:{id:'j'},answers:{City:'Toronto'}}}}]},
 runtime:{onMessage:{addListener(fn){listener=fn;}},onStartup:noOp,onInstalled:noOp,getURL:s=>'chrome-extension://fixture/'+s},alarms:{get:async()=>true,onAlarm:noOp}};
 const context={chrome,URL,Date,crypto:require('node:crypto').webcrypto,importScripts(){},ApplyPilotPolicy:{sameApplication:(a,b)=>a===b}};
 vm.runInNewContext(read('extension/background.js'),context);
 const result=await Promise.race([new Promise(resolve=>listener({action:'focus-existing',id:'j'},{tab:{id:1},frameId:0,url:'https://marvelous-vitality-production-c2d8.up.railway.app/'},resolve)),wait(1000).then(()=>({timeout:true}))]);
 assert.equal(result.timeout,undefined,'focus must not wait on its own serialized packet request');assert(result.ok);
 await wait(30);assert(packetReceived,'the content script received the saved-answer packet');
});

test('a delayed employer form is filled after loading and still waits for manual Submit',async()=>{
 const {JSDOM}=require('jsdom'),dom=new JSDOM('<main>Loading application…</main>',{runScripts:'outside-only',url:'https://jobs.lever.co/example/test'}),w=dom.window;
 const messages=[],timers=[];Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});w.HTMLElement.prototype.getClientRects=function(){return [{}]};w.setInterval=fn=>{timers.push(fn);return timers.length;};w.clearInterval=()=>{};
 w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);return {ok:true,data:m.action==='packet'?{job:{title:'Fixture'},profile:{email:'test@example.test'},answers:{}}:m.action==='state'?{automatic:true,attempted:false}:{}};}}};
 w.eval(read('extension/policy.js'));w.eval(read('extension/content.js'));await wait(30);
 assert(!messages.some(m=>m.action==='progress'&&m.blocked),'loading page must not be marked blocked immediately');
 w.document.querySelector('main').innerHTML='<form><label>Email<input required type="email"></label><button type="button">Submit application</button></form>';let clicks=0;w.document.querySelector('button').onclick=()=>clicks++;
 for(const fn of [...timers])await fn();
 assert.equal(w.document.querySelector('input').value,'test@example.test');assert.equal(clicks,0);assert(messages.some(m=>m.action==='progress'&&/Ready to submit/.test(m.message)));w.close();
});

test('combined name prompts use approved name facts without matching another person',()=>{
 const context={};vm.runInNewContext(read('extension/policy.js'),context);const policy=context.ApplyPilotPolicy;
 for(const q of ['First and last name','Your first & last name','Please enter your first and last name'])assert.equal(policy.knownAnswer(q,{name:'Test Applicant'},{}),'Test Applicant');
 assert.equal(policy.knownAnswer('First and last name',{name:'Test Applicant'},{'Full name':'Approved Applicant'}),'Approved Applicant');
 assert.equal(policy.knownAnswer('First and last name',{name:'Test Applicant'},{'Full name':'One Applicant','Your name':'Other Applicant'}),null);
 for(const q of ['First name','Last name'])assert.notEqual(policy.fieldKind(q),'name');
 for(const q of ['Manager first and last name','Referral first and last name','Electronic signature: first and last name'])assert.equal(policy.knownAnswer(q,{name:'Test Applicant'},{}),null);
});

test('paused forms sync partial saved answers, preserve edits, respect stop and never navigate',async()=>{
 const {JSDOM}=require('jsdom'),dom=new JSDOM('<form><label>Favorite tool<textarea required></textarea></label><label>Another question<input required></label><button type="button">Continue</button></form>',{runScripts:'outside-only',url:'https://jobs.lever.co/example/test'}),w=dom.window;
 const timers=[];let answers={},attempted=false,enabled=true,clicks=0;
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});w.HTMLElement.prototype.getClientRects=function(){return [{}]};w.setInterval=(fn,ms)=>{timers.push({fn,ms});return timers.length};w.clearInterval=()=>{};w.document.querySelector('button').onclick=()=>clicks++;
 w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){return {ok:true,data:m.action==='packet'?{job:{title:'Fixture',attempted},profile:{},answers:{...answers}}:m.action==='state'?{automatic:true,refreshEnabled:enabled,attempted}:{}};}}};
 w.eval(read('extension/policy.js'));w.eval(read('extension/content.js'));await wait(40);
 const sync=timers.find(t=>t.ms===30000).fn;
 answers={'Favorite tool':'Terraform'};await sync();assert.equal(w.document.querySelector('textarea').value,'Terraform');assert.equal(w.document.querySelector('input').value,'');assert.equal(clicks,0);
 w.document.querySelector('textarea').value='My edited answer';answers={'Favorite tool':'Kubernetes','Another question':'Saved answer'};await sync();assert.equal(w.document.querySelector('textarea').value,'My edited answer');assert.equal(w.document.querySelector('input').value,'Saved answer');assert.equal(clicks,0);
 w.document.querySelector('input').value='';enabled=false;answers['Another question']='Changed';await sync();assert.equal(w.document.querySelector('input').value,'');
 enabled=true;attempted=true;await sync();assert.equal(w.document.querySelector('input').value,'');assert.equal(clicks,0);w.close();
});
