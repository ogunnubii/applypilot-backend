// Fixture-only LinkedIn Easy Apply / Indeed Apply content-script checks.
// Every page is synthetic jsdom markup; no real site is contacted and no real
// application is sent.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const JOB='https://www.linkedin.com/jobs/view/4012345678/';

function linkedinPage({question='City',receipt='Your application was sent to Acme Cloud!',jobPage='',remote=true}={}){
 return `<main><div class="jobs-unified-top-card"><h1>Senior Site Reliability Engineer</h1>
 <div class="job-details-jobs-unified-top-card__company-name"><a>Acme Cloud</a></div>
 <span data-testid="job-location">Canada</span><span>${remote?'Remote':'Hybrid'}</span><span>2 days ago · 18 applicants</span><span>Actively recruiting</span>
 <button id="easy" aria-label="Easy Apply to Senior Site Reliability Engineer at Acme Cloud">Easy Apply</button></div>
 <div id="job-details">Remote within Canada. Engagement: B2B contract with an incorporated consultant.</div>
${jobPage}
</main>
 <script type="fixture">${JSON.stringify({question,receipt})}</script>`;
}
// Synthetic Easy Apply modal: contact step, one question step, review, receipt.
function installModal(w,{question,receipt},log){
 const d=w.document;
 d.getElementById('easy').addEventListener('click',()=>{
  const dialog=d.createElement('div');dialog.setAttribute('role','dialog');dialog.className='jobs-easy-apply-modal';
  dialog.innerHTML='<h2>Apply to Acme Cloud</h2><form id="step"><label>Phone number<input id="phone" required></label><button type="button" id="next">Next</button></form>';
  d.body.append(dialog);
  d.getElementById('next').onclick=()=>{log.push('next');d.getElementById('step').innerHTML='<label>'+question+'<input id="q" required></label><button type="button" id="review">Review</button>';
   d.getElementById('review').onclick=()=>{log.push('review');d.getElementById('step').innerHTML='<h3>Review your application</h3><p>Phone number</p><button type="button" id="submit">Submit application</button>';
    d.getElementById('submit').onclick=()=>{log.push('submit');dialog.innerHTML='<h2>Application sent</h2>\n<p>'+receipt+'</p>\n';};};};
 });
}
async function run({url=JOB,autonomous=true,posting={eligible:true},fixture={},markup,inspect=false}={}){
 const html=markup||linkedinPage(fixture);
 const dom=new JSDOM(html,{runScripts:'outside-only',url}),w=dom.window,messages=[],log=[];
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});w.HTMLElement.prototype.getClientRects=()=>[{}];
 const realInterval=w.setInterval.bind(w);w.setInterval=(fn,ms)=>realInterval(fn,ms===2500?40:ms);
 if(!w.crypto?.randomUUID)Object.defineProperty(w,'crypto',{value:require('node:crypto').webcrypto});
 let attempted=false;
 const packet={job:{id:'j',title:'Senior Site Reliability Engineer',company:'Acme Cloud',url:JOB,attempted:false},profile:{phone:'+1 416 555 0100',location:'Thornhill, Ontario, Canada'},answers:{},savedFactsAvailable:true,aiAssistance:false,autonomousSubmit:autonomous,prepareSteps:true,autofillOnly:!autonomous,nativeBoard:'linkedin'};
 w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(structuredClone(m));
  if(m.action==='packet')return {ok:true,data:packet};
  if(m.action==='state')return {ok:true,data:{automatic:true,attempted,autonomousSubmit:autonomous,prepareSteps:true,autofillOnly:!autonomous,refreshEnabled:true}};
  if(m.action==='listing-role')return {ok:true,data:{inspect}};
  if(m.action==='posting')return {ok:true,data:posting};
  if(m.action==='answer')return {ok:true,data:{answer:'',reason:'Save your answer to this question; LinkedIn and Indeed applications never use generated answers.'}};
  if(m.action==='attempt'){attempted=true;return {ok:true,data:{ok:true,permitted:true}};}
  return {ok:true,data:{}};}}};
 if(!markup)installModal(w,{question:'City',receipt:'Your application was sent to Acme Cloud!',...fixture},log);
 w.eval(read('extension/policy.js'));w.eval(read('extension/content.js'));
 return {w,messages,log,done:async(pred,ms=6000)=>{const end=Date.now()+ms;while(Date.now()<end&&!pred())await new Promise(r=>setTimeout(r,20));}};
}

test('LinkedIn Easy Apply: posting checked first, saved facts fill each step, one reserved Submit, employer-specific receipt',{timeout:15000},async()=>{
 const h=await run();
 try{
  await h.done(()=>h.messages.some(m=>m.action==='receipt'));
  const posting=h.messages.find(m=>m.action==='posting');
  assert.equal(posting.title,'Senior Site Reliability Engineer');assert.equal(posting.company,'Acme Cloud');assert.equal(posting.workplace,'remote');
  assert.equal(posting.nativeApply,true);assert.equal(posting.applicantsText,'18 applicants');assert.match(posting.postedText,/2 days ago/);assert.deepEqual(posting.signals,['Actively recruiting']);
  assert(h.messages.findIndex(m=>m.action==='posting')<h.messages.findIndex(m=>m.action==='step'),'posting check precedes opening the form');
  assert.deepEqual(h.log,['next','review','submit']);
  assert.equal(h.messages.filter(m=>m.action==='attempt').length,1);
  const attempt=h.messages.find(m=>m.action==='attempt');assert.equal(attempt.automatic,true);assert.equal(attempt.human,false);
  assert(h.messages.findIndex(m=>m.action==='attempt')<h.messages.findIndex(m=>m.action==='receipt'),'attempt reserved before the receipt');
  assert.equal(h.messages.find(m=>m.action==='receipt').receipt,'Your application was sent to Acme Cloud!');
  assert(!h.messages.some(m=>m.action==='answer'),'all answers came from saved facts');
 }finally{h.w.close();}
});

test('LinkedIn Easy Apply: an unknown required answer is a recorded blocker, never guessed, and Submit is not clicked',{timeout:15000},async()=>{
 const h=await run({fixture:{question:'How many years of production Kubernetes experience do you have?'}});
 try{
  await h.done(()=>h.messages.some(m=>m.action==='progress'&&m.blocked));
  const blocked=h.messages.findLast(m=>m.action==='progress'&&m.blocked);
  assert(blocked.fields.some(f=>/Kubernetes/.test(f)));assert.equal(h.w.document.getElementById('q').value,'');
  assert(!h.log.includes('submit'));assert(!h.messages.some(m=>m.action==='attempt'));
 }finally{h.w.close();}
});

test('LinkedIn: a confirmation naming another employer is not a receipt; the attempt stays uncertain and is never retried',{timeout:15000},async()=>{
 const h=await run({fixture:{receipt:'Your application was sent to Globex!'}});
 try{
  await h.done(()=>h.log.includes('submit'));await new Promise(r=>setTimeout(r,600));
  assert.equal(h.messages.filter(m=>m.action==='attempt').length,1);
  assert(!h.messages.some(m=>m.action==='receipt'));assert.equal(h.log.filter(x=>x==='submit').length,1);
 }finally{h.w.close();}
});

test('LinkedIn: without explicit automatic submission the form is prepared and left for the applicant',{timeout:15000},async()=>{
 const h=await run({autonomous:false});
 try{
  await h.done(()=>h.messages.some(m=>m.action==='progress'&&m.blocked));
  assert.deepEqual(h.log,['next','review']);assert(!h.messages.some(m=>m.action==='attempt'));
  const last=h.messages.findLast(m=>m.action==='progress'&&m.blocked);assert.equal(last.readyForSubmit,true,last.message);
 }finally{h.w.close();}
});

test('LinkedIn: an out-of-scope posting is blocked before Easy Apply opens',{timeout:15000},async()=>{
 const h=await run({posting:{eligible:false,blocker:'Not listed as a remote position.'},fixture:{}});
 try{
  await h.done(()=>h.messages.some(m=>m.action==='progress'&&m.blocked));
  assert.equal(h.messages.findLast(m=>m.action==='progress').message,'Not listed as a remote position.');
  assert.deepEqual(h.log,[]);assert(!h.w.document.querySelector('[role="dialog"]'));assert(!h.messages.some(m=>m.action==='step'));
 }finally{h.w.close();}
});

test('LinkedIn: an existing application and a board limit stop the job without opening a form',{timeout:15000},async()=>{
 const applied=await run({fixture:{jobPage:'<p>Applied 3 days ago</p>\n<p>See application</p>'}});
 try{
  await applied.done(()=>applied.messages.some(m=>m.action==='progress'&&m.blocked));
  assert.match(applied.messages.findLast(m=>m.action==='progress').message,/existing application/);
  assert(!applied.messages.some(m=>m.action==='posting'||m.action==='step'));
 }finally{applied.w.close();}
 const limited=await run({fixture:{jobPage:'<p>You’ve reached the Easy Apply application limit for today.</p>'}});
 try{
  await limited.done(()=>limited.messages.some(m=>m.action==='site-error'));
  const error=limited.messages.find(m=>m.action==='site-error');assert.equal(error.code,429);assert.equal(error.native,true);
  assert.deepEqual(limited.log,[]);
 }finally{limited.w.close();}
});

test('LinkedIn: an external “Apply” job is reported as not Easy Apply',{timeout:15000},async()=>{
 const markup=linkedinPage().replace('<button id="easy" aria-label="Easy Apply to Senior Site Reliability Engineer at Acme Cloud">Easy Apply</button>','<button id="easy" aria-label="Apply to Senior Site Reliability Engineer on company website">Apply</button>');
 const h=await run({markup,posting:{eligible:false,blocker:'This LinkedIn job applies on the employer’s site, not Easy Apply.'}});
 try{
  await h.done(()=>h.messages.some(m=>m.action==='posting'));
  const posting=h.messages.find(m=>m.action==='posting');assert.equal(posting.nativeApply,false);assert.equal(posting.external,true);
 }finally{h.w.close();}
});

test('Indeed Apply: a job-specific receipt is required on the continuation page',{timeout:15000},async()=>{
 const url='https://smartapply.indeed.com/beta/indeedapply/form/post-apply';
 for(const [body,expected] of [['<main><h1>Your application has been submitted!</h1><p>Senior Site Reliability Engineer</p><p>Acme Cloud</p></main>',true],['<main><h1>Your application has been submitted!</h1></main>',false]]){
  const dom=new JSDOM(body,{runScripts:'outside-only',url}),w=dom.window,messages=[];
  Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});w.HTMLElement.prototype.getClientRects=()=>[{}];w.setInterval=()=>0;
  w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);if(m.action==='packet')return {ok:true,data:{job:{id:'j',title:'Senior Site Reliability Engineer',company:'Acme Cloud',attempted:true},profile:{},answers:{},autonomousSubmit:true}};if(m.action==='state')return {ok:true,data:{attempted:true,automatic:false}};return {ok:true,data:{}};}}};
  try{w.eval(read('extension/policy.js'));w.eval(read('extension/content.js'));await new Promise(r=>setTimeout(r,300));
   assert.equal(messages.some(m=>m.action==='receipt'),expected,body);assert(!messages.some(m=>m.action==='attempt'));}
  finally{w.close();}
 }
});

test('read-only listing check: the inspection tab sends one snapshot and never fills, clicks, claims or submits',{timeout:15000},async()=>{
 const h=await run({inspect:true});
 try{
  await h.done(()=>h.messages.some(m=>m.action==='listing-check'));await new Promise(r=>setTimeout(r,300));
  const snap=h.messages.find(m=>m.action==='listing-check');
  assert.equal(snap.title,'Senior Site Reliability Engineer');assert.equal(snap.company,'Acme Cloud');assert.equal(snap.workplace,'remote');assert.equal(snap.nativeApply,true);assert.equal(snap.alreadyApplied,false);
  assert.deepEqual(h.messages.map(m=>m.action).filter(a=>!['listing-role','listing-check'].includes(a)),[],'no packet, state, posting, step or attempt');
  assert.deepEqual(h.log,[],'Easy Apply never clicked');assert.equal(h.w.document.querySelector('[role=dialog]'),null);
 }finally{h.w.close();}
});

test('read-only listing check: a board verification page reports the limit instead of a snapshot',{timeout:15000},async()=>{
 const h=await run({inspect:true,markup:'<main><h1>Let\'s do a quick security check</h1>\n<p>Verify you are human to continue.</p>\n<div class="g-recaptcha"></div></main>'});
 try{
  await h.done(()=>h.messages.some(m=>['listing-limit','listing-check'].includes(m.action)));
  assert.equal(h.messages.some(m=>m.action==='listing-check'),false);const lim=h.messages.find(m=>m.action==='listing-limit');assert(lim,'limit reported');
 }finally{h.w.close();}
});

test('a tab the helper did not open for a listing check runs the normal bound flow',{timeout:15000},async()=>{
 const h=await run();
 try{await h.done(()=>h.messages.some(m=>m.action==='posting'));assert(h.messages.some(m=>m.action==='packet'));assert(!h.messages.some(m=>m.action==='listing-check'));}finally{h.w.close();}
});
