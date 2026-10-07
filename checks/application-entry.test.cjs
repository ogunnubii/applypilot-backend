const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const source=name=>fs.readFileSync(require('node:path').join(__dirname,'..','extension',name),'utf8');
async function fixture(html,url='https://jobs.ashbyhq.com/example/12345678-1234-1234-1234-123456789abc'){
 const dom=new JSDOM(html,{runScripts:'outside-only',url}),w=dom.window,messages=[],timers=[];
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 w.HTMLElement.prototype.getClientRects=function(){return this.isConnected&&!this.closest('[hidden]')&&this.type!=='hidden'?[{}]:[];};
 w.setInterval=fn=>{timers.push(fn);return timers.length;};w.clearInterval=()=>{};
 w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);return {ok:true,data:m.action==='packet'?{job:{title:'Platform Engineer'},autofillOnly:true,profile:{name:'Test Applicant'},answers:{}}:m.action==='state'?{automatic:true,autofillOnly:true,refreshEnabled:true,attempted:false}:{}};}}};
 const wait=()=>new Promise(r=>setTimeout(r,400));
 const start=async()=>{w.eval(source('policy.js'));w.eval(source('content.js'));await wait();};
 const tick=async()=>{for(const fn of [...timers])await fn();await wait();};
 return {w,messages,start,tick,close:()=>w.close()};
}
test('Ashby overview opens Application once then fills the real form without Submit',async()=>{
 const f=await fixture('<button role="tab" id="job-application-form" aria-selected="false">Application</button><button id="apply">Apply for this Job</button><main id="form-slot"></main>');
 let opens=0,submits=0;
 f.w.document.querySelector('#job-application-form').onclick=function(){opens++;this.setAttribute('aria-selected','true');f.w.document.querySelector('#form-slot').innerHTML='<form><label>Full name<input required></label><button type="button" id="submit">Submit application</button></form>';f.w.document.querySelector('#submit').onclick=()=>submits++;};
 f.w.document.querySelector('#apply').onclick=()=>{throw Error('duplicate entry must not be clicked');};
 await f.start();assert.equal(opens,1);assert(!f.messages.some(m=>m.message?.startsWith('Ready to submit')));
 await f.tick();assert.equal(f.w.document.querySelector('input').value,'Test Applicant');assert.equal(opens,1);assert.equal(submits,0);assert(f.messages.some(m=>m.action==='form-opened'));assert(f.messages.some(m=>m.message?.startsWith('Ready to submit')));f.close();
});
test('an empty overview cannot become ready during paused refresh',async()=>{
 const f=await fixture('<h1>Job description</h1>');await f.start();await f.tick();assert(!f.messages.some(m=>m.message?.startsWith('Ready to submit')));assert(!f.messages.some(m=>m.action==='form-opened'));f.close();
});

test('iitjobs repeated Apply buttons open Quick Apply once and fill only its drawer, leaving Submit untouched',async()=>{
 const f=await fixture('<label>Email alerts<input id="alerts" type="email"></label><button id="top">Apply Now</button><button id="bottom">Apply Now</button><main id="slot"></main>','https://www.iitjobs.com/job/cloud-engineer-123');let opens=0,submits=0;
 f.w.document.querySelector('#top').onclick=()=>{opens++;f.w.document.querySelector('#slot').innerHTML='<div class="MuiDrawer-paper"><h5>Quick Apply</h5><label>Full name<input id="app-name" required></label><button id="submit">Submit application</button></div>';f.w.document.querySelector('#submit').onclick=()=>submits++;};
 f.w.document.querySelector('#bottom').onclick=()=>{throw Error('duplicate entry');};
 await f.start();await f.tick();assert.equal(opens,1);assert.equal(f.w.document.querySelector('#app-name').value,'Test Applicant');assert.equal(f.w.document.querySelector('#alerts').value,'');assert.equal(submits,0);assert(f.messages.some(m=>m.action==='step'&&m.entry===true));assert(f.messages.some(m=>m.message?.startsWith('Ready to submit')));f.close();
});

test('Randstad fills its application rather than job alerts and leaves passwords and declarations for the applicant',async()=>{
 const f=await fixture('<form id="jobAlertsForm"><label>Full name<input id="alert-name"></label><button>Submit</button></form><button id="apply">apply</button><form id="applicationForm"></form>','https://www.randstad.ca/jobs/cloud-engineer_toronto_12345/');let opens=0;
 f.w.document.querySelector('#apply').onclick=()=>{opens++;f.w.document.querySelector('#applicationForm').innerHTML='<label>Full name<input id="name" required></label><label>Password<input id="password" type="password" required></label><label>I accept the terms<input type="checkbox" required></label><button id="submit">submit your application</button>';};
 await f.start();await f.tick();assert.equal(opens,1);assert.equal(f.w.document.querySelector('#name').value,'Test Applicant');assert.equal(f.w.document.querySelector('#alert-name').value,'');assert.equal(f.w.document.querySelector('#password').value,'');assert.equal(f.w.document.querySelector('[type=checkbox]').checked,false);assert(!f.messages.some(m=>m.action==='attempt'));assert(!f.messages.some(m=>m.message?.startsWith('Ready to submit')));f.close();
});

test('custom job identities ignore www and page steps but never authorize unrelated jobs or sign-in pages',async()=>{
 const f=await fixture('');await f.start();const p=f.w.ApplyPilotPolicy;
 assert(p.sameApplication('https://www.iitjobs.com/job/cloud-123/','https://iitjobs.com/job/cloud-123'));
 assert(!p.sameApplication('https://iitjobs.com/job/cloud-123','https://iitjobs.com/job/cloud-124'));
 assert(!p.supported('https://iitjobs.com/login'));assert(!p.supported('https://evil.iitjobs.com/job/cloud-123'));assert(!p.supported('https://apply.tri-global.com/job/role'));
 assert(p.sameApplication('https://careers-kinaxis.icims.com/jobs/35190/technical-account-manager/job','https://careers-kinaxis.icims.com/jobs/35190/login?mode=apply'));
 assert(!p.sameApplication('https://careers-kinaxis.icims.com/jobs/35190/role/job','https://careers-kinaxis.icims.com/jobs/35191/role/job'));f.close();
});
test('autofill waits at Next, and refresh only marks a populated final form ready',async()=>{
 const f=await fixture('<form><label>Full name<input required></label><button type="button" id="next">Next</button></form>');let advances=0;f.w.document.querySelector('#next').onclick=()=>advances++;
 await f.start();assert.equal(f.w.document.querySelector('input').value,'Test Applicant');assert.equal(advances,0);assert(!f.messages.some(m=>m.message?.startsWith('Ready to submit')));
 f.w.document.querySelector('form').innerHTML='<label>Full name<input required></label><button type="button">Submit application</button>';await f.tick();assert.equal(f.w.document.querySelector('input').value,'Test Applicant');assert(f.messages.some(m=>m.message?.startsWith('Ready to submit')));assert(!f.messages.some(m=>m.action==='attempt'));f.close();
});
