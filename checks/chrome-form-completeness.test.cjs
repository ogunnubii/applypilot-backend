const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Synthetic DOM fixtures only. No employer requests, real applications, or model calls.
async function fixture(html,{answers={},profile={},before=()=>{},resume,autofillOnly=false,savedFactsAvailable=false,prepareAnswer=()=>({answer:''})}={}){
 const dom=new JSDOM(html+'<button type="button" id="final-submit">Submit application</button>',{runScripts:'outside-only',url:'https://jobs.ashbyhq.com/fixture/role'}),w=dom.window;
 const messages=[],timers=[];let submits=0;
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 w.HTMLElement.prototype.getClientRects=function(){return this.isConnected&&!this.closest('[hidden]')&&this.type!=='hidden'&&this.style.display!=='none'?[{}]:[];};
 w.setInterval=(fn,ms)=>{timers.push({fn,ms});return timers.length;};w.clearInterval=()=>{};
 w.document.getElementById('final-submit').onclick=()=>submits++;
 w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(message){messages.push(message);if(message.action==='answer')return {ok:true,data:prepareAnswer(message,w)};return {ok:true,data:message.action==='packet'?{job:{title:'Synthetic form'},profile,answers,autofillOnly,prepareSteps:true,resume,savedFactsAvailable}:message.action==='state'?{automatic:true,attempted:false,autofillOnly,prepareSteps:true,refreshEnabled:true}:{}};}}};
 before(w);w.eval(read('extension/policy.js'));w.eval(read('extension/content.js'));
 for(let i=0;i<250&&!messages.some(m=>m.action==='progress'&&m.blocked);i++)await wait(20);
 const progress=messages.findLast(m=>m.action==='progress'&&m.blocked);
 if(!progress){w.close();throw Error('Synthetic preparation did not finish');}
 return {w,messages,progress,timers,close(){assert.equal(submits,0);assert(!messages.some(m=>['attempt','receipt'].includes(m.action)));w.close();}};
}

test('full aria-labelledby question and multiple explicit labels are retained',async()=>{
 const q='Which tools have you used in production?';
 const f=await fixture('<form><label for="tools" id="prefix">Which tools</label><span id="suffix">have you used in production?</span><input id="tools" aria-labelledby="prefix suffix" required><label for="name">First</label><label for="name">name</label><input id="name" required></form>',{answers:{[q]:'Terraform'},profile:{name:'Fixture Person'}});
 try{assert.equal(f.w.document.getElementById('tools').value,'Terraform');assert.equal(f.w.document.getElementById('name').value,'Fixture');assert.equal(f.progress.readyForSubmit,true);assert(f.messages.find(m=>m.action==='capture').fields.some(row=>row.question===q));}finally{f.close();}
 const unresolved=await fixture('<form><label for="tools" id="prefix">Which tools</label><span id="suffix">have you used in production?</span><input id="tools" aria-labelledby="prefix suffix" required></form>');
 try{assert.deepEqual(Array.from(unresolved.progress.fields),[q]);}finally{unresolved.close();}
});

test('Ashby label-only requirements count without inheriting the phone question into optional consent',async()=>{
 const f=await fixture('<form><div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title _required_abc">Phone number</label><input id="phone" type="tel"><div class="ashby-application-form-texting-consent-description"><label><input type="radio" name="consent">Yes, I consent to messages</label><label><input type="radio" name="consent">No, I do not consent</label></div></div><div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title _required_abc">Describe your verified experience</label><textarea></textarea></div></form>',{profile:{phone:'4165550132'}});
 try{assert.equal(f.w.document.getElementById('phone').value,'4165550132');assert.equal(f.w.document.querySelectorAll('[name="consent"]:checked').length,0);assert.deepEqual(Array.from(f.progress.fields),['Describe your verified experience']);assert.deepEqual({...f.progress.progress},{required:2,filled:1});assert.equal(f.progress.readyForSubmit,false);}finally{f.close();}
});

test('ARIA-required native radio groups remain separate by form and duplicate labels remain separate controls',async()=>{
 const f=await fixture('<form><fieldset aria-required="true"><legend>Available for weekday shifts?</legend><label><input type="radio" name="available" value="yes">Yes</label><label><input type="radio" name="available" id="weekday-no" value="no">No</label></fieldset><label>Supporting detail<input required value="My edit"></label><label>Supporting detail<input required></label></form><form><fieldset aria-required="true"><legend>Available for weekend shifts?</legend><label><input type="radio" name="available" value="yes">Yes</label><label><input type="radio" name="available" value="no">No</label></fieldset></form>',{answers:{'Available for weekday shifts?':'No'}});
 try{assert.equal(f.w.document.getElementById('weekday-no').checked,true);assert.deepEqual({...f.progress.progress},{required:4,filled:2});assert.deepEqual(Array.from(f.progress.fields),['Supporting detail','Available for weekend shifts?']);assert.equal(f.progress.readyForSubmit,false);}finally{f.close();}
});

test('uncommitted non-React search text is preserved but cannot claim readiness',async()=>{
 const f=await fixture('<form><label>Current location<input role="combobox" aria-expanded="false" value="Toron" required></label></form>',{profile:{location:'Toronto, Ontario, Canada'}});
 try{assert.equal(f.w.document.querySelector('input').value,'Toron');assert.equal(f.progress.readyForSubmit,false);assert.deepEqual(Array.from(f.progress.fields),['Current location']);assert.equal(f.progress.progress.filled,0);}finally{f.close();}
});

test('asynchronously populated location options commit the exact saved option and ignore another menu',async()=>{
 const f=await fixture('<form><label>Current location<input id="city" role="combobox" aria-controls="cities" aria-expanded="false" required></label><div role="listbox" id="cities"></div><div role="listbox"><div role="option" id="wrong">Toronto, Ontario, Canada</div></div></form>',{profile:{location:'Toronto, Ontario, Canada'},before(w){
  const input=w.document.getElementById('city'),list=w.document.getElementById('cities');let pending;
  w.document.getElementById('wrong').onclick=()=>assert.fail('Unrelated menu must not be used');
  input.onclick=()=>{input.setAttribute('aria-expanded','true');};
  input.oninput=()=>{clearTimeout(pending);pending=setTimeout(()=>{list.innerHTML='<div role="option">Toronto, Ontario, Canada</div>';list.firstChild.onclick=()=>{input.value=list.textContent;input.setAttribute('aria-valuetext',list.textContent);input.setAttribute('aria-expanded','false');list.innerHTML='';};},950);};
 }});
 try{assert.equal(f.progress.readyForSubmit,true);assert.equal(f.w.document.querySelector('input').value,'Toronto, Ontario, Canada');assert.equal(f.w.document.activeElement,f.w.document.body);}finally{f.close();}
});

test('native multi-select fills an exact approved set atomically, captures the whole set and preserves edits',async()=>{
 for(const [answer,existing,expected] of [['["Terraform","Kubernetes"]',false,['Terraform','Kubernetes']],['Terraform\nMissing option',false,[]],['["Terraform","Kubernetes"]',true,['Docker']]]){
  const f=await fixture('<form><label>Which tools?<select multiple required><option>Terraform</option><option>Kubernetes</option><option'+(existing?' selected':'')+'>Docker</option></select></label></form>',{answers:{'Which tools?':answer}});
  try{assert.deepEqual(Array.from(f.w.document.querySelector('select').selectedOptions,o=>o.textContent),expected);assert.equal(f.progress.readyForSubmit,!!expected.length);if(expected.length)assert.equal(f.messages.find(m=>m.action==='capture').fields[0].answer,JSON.stringify(expected));}finally{f.close();}
 }
});

test('native fills focus and blur to commit while rejected values stay unresolved',async()=>{
 for(const reject of [false,true]){
  const f=await fixture('<form><label>Email<input type="email" id="email" required></label></form>',{profile:{email:'fixture@example.test'},before(w){const input=w.document.getElementById('email');w.committed='';input.onblur=()=>{w.committed=input.value;if(reject)input.value='changed@example.test';};}});
  try{assert.equal(f.w.committed,'fixture@example.test');assert.equal(f.progress.readyForSubmit,!reject);if(reject)assert.deepEqual(Array.from(f.progress.fields),['Email']);}finally{f.close();}
 }
});

test('phone formatting preserves digits and ISO dates fill without inventing dates',async()=>{
 for(const start of ['2026-11-03','Immediately']){
  const f=await fixture('<form><label>Phone number<input type="tel" pattern="[0-9]{10}" required></label><label>Available start date<input type="date" required></label></form>',{profile:{phone:'(416) 555-0132'},answers:{'Available start date':start}});
  try{assert.equal(f.w.document.querySelector('[type="tel"]').value,'4165550132');assert.equal(f.w.document.querySelector('[type="date"]').value,start==='Immediately'?'':start);assert.equal(f.progress.readyForSubmit,start!=='Immediately');}finally{f.close();}
 }
});

test('optional invalid values, hidden resume requirements and pending uploads cannot appear ready',async()=>{
 for(const [html,question] of [['<label>Email<input type="email" value="invalid"></label>','Email'],['<div class="application-question"><label>Resume<input type="file" required style="display:none"></label><button type="button">Upload resume</button></div>','Resume']]){
  const f=await fixture('<form><label>Full name<input required value="Fixture Person"></label>'+html+'</form>');
  try{assert.equal(f.progress.readyForSubmit,false);assert.deepEqual(Array.from(f.progress.fields),[question]);}finally{f.close();}
 }
 const pending=await fixture('<form aria-busy="true"><label>Full name<input required value="Fixture Person"></label><div role="progressbar">Uploading resume</div></form>');
 try{assert.equal(pending.progress.readyForSubmit,false);assert.match(pending.progress.message,/processing.*upload/);}finally{pending.close();}
});

test('delayed conditional controls are rescanned and disabled fieldset requirements do not block',async()=>{
 const f=await fixture('<form><label>Email<input type="email" required></label><fieldset disabled><label>Inactive old step<input required></label></fieldset></form>',{profile:{email:'fixture@example.test',phone:'4165550132'},before(w){let added=false;w.document.querySelector('[type="email"]').onchange=()=>{if(added)return;added=true;setTimeout(()=>w.document.querySelector('form').insertAdjacentHTML('beforeend','<label>Phone number<input type="tel" required></label>'),300);};}});
 try{assert.equal(f.w.document.querySelector('[type="tel"]').value,'4165550132');assert.equal(f.progress.readyForSubmit,true);assert.deepEqual({...f.progress.progress},{required:2,filled:2});}finally{f.close();}
});

test('a form with no observable requirements does not claim ready to submit',async()=>{
 const f=await fixture('<form><label>Email<input value="fixture@example.test"></label></form>');
 try{assert.equal(f.progress.readyForSubmit,false);assert.doesNotMatch(f.progress.message,/Ready to submit/);}finally{f.close();}
});

test('custom multi-selects fail closed without clicking or treating the first chip as the complete set',async()=>{
 for(const mode of ['aria','chips','opened']){
  const f=await fixture('<form><label id="tools-label">Which tools?</label><div class="select__control">'+(mode==='chips'?'<div class="select__multi-value">Terraform</div>':'')+'<input aria-labelledby="tools-label" role="combobox" aria-required="true" aria-controls="tool-options" aria-expanded="false"'+(mode==='aria'?' aria-multiselectable="true"':'')+(mode==='chips'?' aria-valuetext="Terraform"':'')+'></div><div role="listbox" id="tool-options" hidden><div role="option">Terraform</div><div role="option">Kubernetes</div></div></form>',{answers:{'Which tools?':'Terraform'},before(w){const input=w.document.querySelector('input'),menu=w.document.getElementById('tool-options');w.document.querySelector('.select__control').onmousedown=()=>{input.setAttribute('aria-expanded','true');menu.hidden=false;menu.setAttribute('aria-multiselectable','true');};for(const option of menu.children)option.onclick=()=>assert.fail('Unsupported custom multiselect must not select a partial answer');}});
  try{assert.equal(f.progress.readyForSubmit,false);assert.deepEqual(Array.from(f.progress.fields),['Which tools?']);assert.equal(f.w.document.querySelector('input').value,'');}finally{f.close();}
 }
});

test('rejected partial native multi-selection remains missing after subsequent passes',async()=>{
 const f=await fixture('<form><label>Email<input required></label><label>Which tools?<select multiple required><option>Terraform</option><option>Kubernetes</option></select></label></form>',{profile:{email:'fixture@example.test'},answers:{'Which tools?':'["Terraform","Kubernetes"]'},before(w){w.document.querySelector('select').onchange=event=>{event.target.options[1].selected=false;};}});
 try{assert.equal(f.progress.readyForSubmit,false);assert.deepEqual(Array.from(f.progress.fields),['Which tools?']);assert.deepEqual({...f.progress.progress},{required:2,filled:1});}finally{f.close();}
});

test('a declaration in question help blocks direct saved-answer filling and capture',async()=>{
 const q='Describe your support experience';
 const f=await fixture('<form><label>'+q+'<textarea aria-describedby="declaration" required></textarea></label><span id="declaration">I certify this is accurate and complete.</span></form>',{answers:{[q]:'Verified experience supplied by the applicant.'}});
 try{assert.equal(f.w.document.querySelector('textarea').value,'');assert.equal(f.progress.readyForSubmit,false);assert.deepEqual(Array.from(f.progress.fields),[q]);assert(!f.messages.some(m=>m.action==='capture'||m.action==='answer'));}finally{f.close();}
});

test('programmatic focus and blur never autosave filled fields as human edits',async()=>{
 const f=await fixture('<form><label>Email<input type="email" required></label></form>',{profile:{email:'fixture@example.test'}});
 try{assert.equal(f.progress.readyForSubmit,true);assert(!f.messages.some(m=>['autosave','assistance'].includes(m.action)));}finally{f.close();}
});

test('duplicate question labels with different help cannot borrow one saved answer',async()=>{
 const q='Describe your experience';
 const f=await fixture('<form><label>'+q+'<textarea aria-describedby="kubernetes" required></textarea></label><p id="kubernetes">Explain your production Kubernetes deployment work.</p><label>'+q+'<textarea aria-describedby="databases" required></textarea></label><p id="databases">Explain your database upgrade work.</p></form>',{answers:{[q]:'My approved Kubernetes background.'}});
 try{assert.deepEqual(Array.from(f.w.document.querySelectorAll('textarea'),e=>e.value),['','']);assert.equal(f.progress.readyForSubmit,false);assert.match(f.progress.message,/production Kubernetes deployment work/);assert.match(f.progress.message,/database upgrade work/);assert(!f.messages.some(m=>['answer','capture'].includes(m.action)));assert.deepEqual({...f.progress.progress},{required:2,filled:0});}finally{f.close();}
});

test('generic detail labels with substantive help require the exact contextual answer',async()=>{
 const f=await fixture('<form><label>Additional details<textarea aria-describedby="context" required></textarea></label><p id="context">Describe your experience maintaining Kubernetes production clusters.</p></form>',{answers:{'Additional details':'Saved details from an unrelated application.'}});
 try{assert.equal(f.w.document.querySelector('textarea').value,'');assert.equal(f.progress.readyForSubmit,false);assert.match(f.progress.message,/Additional details.*maintaining Kubernetes production clusters/);assert(!f.messages.some(m=>['answer','capture'].includes(m.action)));}finally{f.close();}
});

test('unnamed required radios remain independent and native upload progress blocks readiness',async()=>{
 const f=await fixture('<form><label>First choice<input type="radio" aria-required="true" checked></label><label>Second choice<input type="radio" aria-required="true"></label></form>');
 try{assert.deepEqual({...f.progress.progress},{required:2,filled:1});assert.deepEqual(Array.from(f.progress.fields),['Second choice']);assert.equal(f.progress.readyForSubmit,false);}finally{f.close();}
 const pending=await fixture('<form><label>Email<input type="email" required value="fixture@example.test"></label><progress>Uploading resume</progress></form>');
 try{assert.equal(pending.progress.readyForSubmit,false);assert.match(pending.progress.message,/processing.*upload/);}finally{pending.close();}
 const finished=await fixture('<form><label>Email<input type="email" required value="fixture@example.test"></label><progress value="100" max="100">Upload complete</progress></form>');
 try{assert.equal(finished.progress.readyForSubmit,true);}finally{finished.close();}
});

test('an applicant edit while remote dropdown choices load is preserved',async()=>{
 const f=await fixture('<form><label>Current location<input id="location" role="combobox" aria-expanded="false" aria-controls="cities" required></label><div role="listbox" id="cities"></div></form>',{profile:{location:'Toronto, Ontario, Canada'},before(w){
  const input=w.document.getElementById('location'),list=w.document.getElementById('cities'),listen=w.document.addEventListener.bind(w.document);let humanChange;
  w.document.addEventListener=(type,fn,...args)=>{if(type==='input')humanChange=fn;return listen(type,fn,...args);};
  input.onclick=()=>input.setAttribute('aria-expanded','true');input.onkeydown=event=>{if(event.key==='Escape')input.setAttribute('aria-expanded','false');};
  input.oninput=()=>setTimeout(()=>{list.innerHTML='<div role="option">Toronto, Ontario, Canada</div>';list.firstChild.onclick=()=>assert.fail('An applicant edit must stop the pending selection');},900);
  setTimeout(()=>{input.value='Applicant-edited location';humanChange({target:input,isTrusted:true,type:'input'});},200);
 }});
 try{assert.equal(f.w.document.querySelector('input').value,'Applicant-edited location');assert.equal(f.progress.readyForSubmit,false);}finally{f.close();}
});

test('changed question help invalidates an in-flight prepared answer',async()=>{
 const f=await fixture('<form><label>Describe your support experience<textarea required aria-describedby="help"></textarea></label><p id="help">Include your Kubernetes deployment work.</p></form>',{savedFactsAvailable:true,prepareAnswer(message,w){assert.equal(message.fieldHelp,'Include your Kubernetes deployment work.');w.document.getElementById('help').textContent='Include your database upgrade work.';return {answer:'My approved Kubernetes deployment answer.'};}});
 try{assert.equal(f.w.document.querySelector('textarea').value,'');assert.equal(f.progress.readyForSubmit,false);assert.equal(f.messages.filter(m=>m.action==='answer').length,1);assert(!f.messages.some(m=>m.action==='capture'));}finally{f.close();}
});
