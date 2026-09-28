const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const settle=()=>new Promise(r=>setTimeout(r,25));
async function fixture(html,{automatic=true,answers={},initialAttempt=false,before=()=>{}}={}){
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://jobs.ashbyhq.com/example/job-123'}),w=dom.window;
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 w.HTMLElement.prototype.getClientRects=function(){return this.type==='hidden'||this.hidden||this.style.display==='none'?[]:[{}];};
 let attempted=initialAttempt,auto=automatic;const messages=[],timers=[];
 const packet={job:{title:'Fixture role',attempted:initialAttempt},profile:{name:'Fixture Applicant',email:'fixture@example.test',phone:'123',location:'Fixture city'},answers,resume:{name:'resume.pdf',base64:''},automatic};
 w.setInterval=fn=>{timers.push(fn);return timers.length;};w.clearInterval=()=>{};
 w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);if(m.action==='packet')return {ok:true,data:packet};if(m.action==='state')return {ok:true,data:{attempted,automatic:auto&&!attempted}};if(m.action==='attempt'){assert(!attempted,'attempt must not repeat');attempted=true;}if(m.action==='progress'&&m.blocked)auto=false;return {ok:true,data:{}};}}};
 before(w);
 w.eval(fs.readFileSync(path.join(root,'extension/policy.js'),'utf8'));w.eval(fs.readFileSync(path.join(root,'extension/content.js'),'utf8'));await settle();
 return {w,messages,timers,close:()=>w.close(),tick:async()=>{for(const fn of [...timers])await fn();await settle();}};
}
test('Unknown required facts block, while exact saved facts fill and existing edits survive',async()=>{
 const f=await fixture('<form><label>Full name<input id="name" required></label><label>Phone<input id="phone" value="user edit"></label><label>Work authorization<select id="auth" required><option value="">Choose</option><option value="no">No</option></select></label><label>Degree<input id="degree" required></label><button>Submit application</button></form>',{answers:{'Work authorization':'No'}});
 try{assert.equal(f.w.document.querySelector('#name').value,'Fixture Applicant');assert.equal(f.w.document.querySelector('#phone').value,'user edit');assert.equal(f.w.document.querySelector('#auth').value,'no');assert.equal(f.w.document.querySelector('#degree').value,'');assert(f.messages.some(m=>m.action==='progress'&&m.blocked&&m.fields.includes('Degree')));assert(!f.messages.some(m=>m.action==='attempt'));}finally{f.close();}
});
test('Routine two-step form persists intent before one submit and verifies a new receipt',async()=>{
 const f=await fixture('<form><label>Full name<input required></label><button type="button" id="next">Next</button></form>',{automatic:false});
 // Start a fresh fixture with handlers installed before the agent begins.
 f.close();
 const html='<form id="application"><label>Full name<input required></label><button type="button" id="next">Next</button></form>';
 const g=await fixture(html);
 try{
  // First click was deliberately inert; simulate the resulting next page.
  assert(g.messages.some(m=>m.action==='step'));
  g.w.document.querySelector('form').innerHTML='<label>Email<input required type="email"></label><button type="button" id="submit">Submit application</button>';
  let clicks=0;g.w.document.querySelector('#submit').onclick=()=>{assert(g.messages.some(m=>m.action==='attempt'));clicks++;g.w.document.querySelector('form').innerHTML='<p>Your application has been received</p>';};
  await g.tick();assert.equal(clicks,1);await g.tick();assert(g.messages.some(m=>m.action==='receipt'));await g.tick();assert.equal(clicks,1);
 }finally{g.close();}
});
test('CAPTCHA, MFA, legal text, payments and custom controls require human interaction',async()=>{
 for(const extra of ['<div class="g-recaptcha"></div>','<input autocomplete="one-time-code">','<p>By submitting, I certify that these statements are true.</p>','<label>Credit card number<input></label>','<div role="combobox" aria-required="true"></div>']){
  const f=await fixture('<form><label>Full name<input required></label>'+extra+'<button>Submit application</button></form>');
  try{assert(f.messages.some(m=>m.action==='progress'&&m.blocked),extra);assert(!f.messages.some(m=>m.action==='attempt'),extra);}finally{f.close();}
 }
});
test('Existing receipts do not submit; restart after intent never clicks Submit again',async()=>{
 for(const initialAttempt of [false,true]){
  const f=await fixture('<form><label>Full name<input required></label><button>Submit application</button></form><p>Thank you for applying</p>',{initialAttempt});
  try{await f.tick();assert(!f.messages.some(m=>m.action==='attempt'));assert.equal(f.messages.some(m=>m.action==='receipt'),initialAttempt);}finally{f.close();}
 }
});
test('Radio answers are scoped by form and never use unmatched verifiable facts',async()=>{
 const f=await fixture('<form><fieldset><legend>Work authorized?</legend><label>Yes<input type="radio" name="auth" value="yes"></label><label>No<input type="radio" id="no" name="auth" value="no" required></label></fieldset><label>Employer name<input id="employer" required></label><button>Submit application</button></form>',{answers:{'Work authorized?':'No'}});
 try{assert.equal(f.w.document.querySelector('#no').checked,true);assert.equal(f.w.document.querySelector('#employer').value,'');assert(!f.messages.some(m=>m.action==='attempt'));}finally{f.close();}
});

test('Common field variants reuse verified answers without conflating residence and authorization',async()=>{
 const f=await fixture('<form><label>Your email address<input id="email"></label><label>Contact phone number<input id="phone"></label><label>City of residence<input id="city"></label><label>Country<select id="country"><option disabled selected>Select country</option><option>Canada</option></select></label><label>University name<input id="school"></label><label>Are you legally authorized to work in the USA?<input id="auth" required></label><label>Would you like to join our community?<input id="community" type="checkbox"></label></form>',{answers:{City:'Toronto','Country of residence':'Canada',School:'Verified University','Are you legally authorized to work in Canada?':'Yes','Would you like to join our community?':'Yes'}});
 try{for(const [id,value]of Object.entries({email:'fixture@example.test',phone:'123',city:'Toronto',country:'Canada',school:'Verified University',auth:''}))assert.equal(f.w.document.getElementById(id).value,value,id);assert(f.w.document.getElementById('community').checked);assert(!f.messages.some(m=>m.action==='attempt'));}finally{f.close();}
});
test('Known custom dropdown is selected while unrelated unknown fields remain blocked',async()=>{
 const f=await fixture('<form><label>Country<input role="combobox" aria-controls="countries" aria-required="true" id="country"></label><div role="listbox" id="countries"><div role="option">Canada</div><div role="option">United States</div></div><label>Phone number<input id="phone"></label><label>Passport country<input required id="passport"></label></form>',{answers:{'Country of residence':'Canada'},before:w=>{w.document.querySelector('[role=option]').onclick=()=>{w.document.getElementById('country').value='Canada';w.document.getElementById('countries').hidden=true;};}});
 try{await new Promise(r=>setTimeout(r,500));assert.equal(f.w.document.getElementById('country').value,'Canada');assert.equal(f.w.document.getElementById('phone').value,'123');assert.equal(f.w.document.getElementById('passport').value,'');assert(f.messages.some(m=>m.action==='progress'&&m.fields.includes('Passport country')));}finally{f.close();}
});
test('Conflicting aliases do not guess and authorization does not transfer between countries',async()=>{
 const f=await fixture('<form><label>City of residence<input id="city" required></label><label>Do you require sponsorship?<input id="visa" required></label></form>',{answers:{City:'Toronto','Current city':'Ottawa','Are you authorized to work?':'Yes'}});
 try{assert.equal(f.w.document.getElementById('city').value,'');assert.equal(f.w.document.getElementById('visa').value,'');assert(!f.messages.some(m=>m.action==='attempt'));}finally{f.close();}
});
