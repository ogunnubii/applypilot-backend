const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const source=name=>fs.readFileSync(require('node:path').join(__dirname,'..','extension',name),'utf8');
async function fixture(html){
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://jobs.ashbyhq.com/example/12345678-1234-1234-1234-123456789abc'}),w=dom.window,messages=[],timers=[];
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
test('autofill waits at Next, and refresh only marks a populated final form ready',async()=>{
 const f=await fixture('<form><label>Full name<input required></label><button type="button" id="next">Next</button></form>');let advances=0;f.w.document.querySelector('#next').onclick=()=>advances++;
 await f.start();assert.equal(f.w.document.querySelector('input').value,'Test Applicant');assert.equal(advances,0);assert(!f.messages.some(m=>m.message?.startsWith('Ready to submit')));
 f.w.document.querySelector('form').innerHTML='<label>Full name<input required></label><button type="button">Submit application</button>';await f.tick();assert.equal(f.w.document.querySelector('input').value,'Test Applicant');assert(f.messages.some(m=>m.message?.startsWith('Ready to submit')));assert(!f.messages.some(m=>m.action==='attempt'));f.close();
});
