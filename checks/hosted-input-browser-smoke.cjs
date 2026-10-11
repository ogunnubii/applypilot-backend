// Synthetic hosted-worker fixture only. Every request is intercepted; this
// never opens an employer form or sends a real application.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

(async()=>{
 const {fillHostedText,typeHostedSearch}=await import('../hosted-input.js');
 const {hostedFieldAnswer,hostedOptionChoice,protectedHostedQuestion,scopedHostedComboboxOptions}=await import('../hosted-form.js');
 const {submitHostedApplication}=await import('../hosted-submission.js');
 const {hostedFormState}=await import('../hosted-form-state.js');
 const worker=fs.readFileSync(path.join(__dirname,'../worker.js'),'utf8');
 const fillSource=worker.slice(worker.indexOf('async function fieldDescriptor('),worker.indexOf('function authorizeResearchFill('));
 const fill=new Function('hostedFieldAnswer','fillHostedText','hostedFormState',fillSource+';return fill;')(hostedFieldAnswer,fillHostedText,hostedFormState);
 const reviewSource=worker.slice(worker.indexOf('async function review(page)'),worker.indexOf('\nasync function custom(page'));
 const review=new Function('hostedFormState',reviewSource+';return review;')(hostedFormState);
 const browser=await chromium.launch({headless:true,...(process.env.TEST_BROWSER_PATH?{executablePath:process.env.TEST_BROWSER_PATH}:{})});
 try{
  const context=await browser.newContext();
  const fixtureUrl='https://jobs.lever.co/hosted-fixture/role-123';
  const html=`<form><label>Full name<input id="name" required></label><label>Email address<input id="email" type="email" required></label><label>Phone number<input id="phone" type="tel" required></label><label>Current location<input id="location" required></label><button type="button" id="submit">Submit application</button></form><script>
   window.model={};window.events=[];window.clicks=0;
   for(const [id,commit] of [['name','keyup'],['email','keyup'],['phone','change'],['location','blur']]){
    const field=document.getElementById(id);
    for(const type of ['keydown','input','keyup','change','blur'])field.addEventListener(type,event=>{events.push({id,type,trusted:event.isTrusted});if(type===commit)model[id]=field.value;});
   }
   document.querySelector('#submit').onclick=()=>{window.clicks++;if(!window.reserved)throw Error('Missing durable intent');if([...document.querySelectorAll('input')].some(field=>model[field.id]!==field.value||!field.value))throw Error('Employer model is empty');document.body.innerHTML='<p>Your application has been received</p>';};
  </script>`;
  await context.route('**/*',route=>route.request().url()===fixtureUrl?route.fulfill({contentType:'text/html',body:html}):route.abort());
  const page=await context.newPage();
  await page.goto(fixtureUrl);
  const values={name:'Fixture Applicant',email:'fixture@example.test',phone:'+1 (416) 555-0132',location:'12 Example Street'};
  for(const [id,value] of Object.entries(values))await page.locator('#'+id).fill(value);
  await page.locator('#location').blur();
  assert.equal((await review(page)).missing.length,0,'old DOM-only review sees valid visible values');
  assert.equal(await page.evaluate(()=>model.email),undefined,'old fill never commits the keyboard-driven employer model');
  await page.goto(fixtureUrl);
  assert.equal(await fill(page,{...values,answers_json:'{}'}),4,'real worker contact loop uses the helper');
  assert.deepEqual(await page.evaluate(()=>model),values);
  assert.equal((await review(page)).missing.length,0);
  assert.equal(await page.evaluate(()=>document.activeElement===document.body),true);
  assert.equal(await page.evaluate(()=>events.every(event=>event.trusted)),true,'all keyboard/input/change/blur events are browser-generated');
  assert.equal(await page.evaluate(()=>events.filter(event=>event.id==='email'&&event.type==='keyup').length>1),true);
  let reservations=0;
  const submission={page,job:{url:fixtureUrl},submit:page.locator('#submit'),review,reserve:()=>{reservations++;},wait:()=>page.waitForTimeout(10),recordLimit:()=>{throw Error('Unexpected limit');}};
  await page.locator('#email').evaluate(e=>e.setAttribute('aria-invalid','true'));
  assert.equal((await submitHostedApplication(submission)).challenge,'Final form review');assert.equal(reservations,0);
  await page.locator('#email').evaluate(e=>e.setAttribute('aria-invalid','false'));
  await page.locator('#submit').evaluate(e=>{e.disabled=true;});
  assert.equal((await submitHostedApplication(submission)).challenge,'Final form review');assert.equal(reservations,0);
  await page.locator('#submit').evaluate(e=>{e.disabled=false;});
  await page.evaluate(()=>{window.reserved=true;});
  assert.equal((await submitHostedApplication(submission)).status,'submitted');
  assert.equal(reservations,1);assert.equal(await page.evaluate(()=>clicks),1);
  assert.equal((await submitHostedApplication(submission)).challenge,'Existing receipt');assert.equal(reservations,1);

  await page.setContent('<label>Answer<textarea id="answer"></textarea></label><label>Truncated<input id="truncated" maxlength="5"></label><label>Controlled<input id="controlled"></label><input id="existing" value="Applicant edit">');
  await page.evaluate(()=>{
   const field=document.querySelector('#controlled'),native=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');let tracked='';window.controlledState='';
   Object.defineProperty(field,'value',{get(){return native.get.call(this);},set(value){tracked=String(value);native.set.call(this,value);}});
   field.addEventListener('input',()=>{if(field.value!==tracked){tracked=field.value;window.controlledState=field.value;}});
  });
  const paragraph='First line.\nSecond line: Élodie 王.';
  await fillHostedText(page.locator('#answer'),paragraph);assert.equal(await page.locator('#answer').inputValue(),paragraph);
  await fillHostedText(page.locator('#controlled'),'Élodie 王');assert.equal(await page.evaluate(()=>controlledState),'Élodie 王');
  assert.equal(await fillHostedText(page.locator('#existing'),'Replacement'),false);assert.equal(await page.locator('#existing').inputValue(),'Applicant edit');
  await assert.rejects(fillHostedText(page.locator('#truncated'),'Full answer'),{code:'HOSTED_INPUT_NOT_RETAINED'});
  // Exercise the real worker custom-control loop against an async remote-style
  // picker. A stale option must not make it stop before the matching city arrives.
  const customSource=worker.slice(worker.indexOf('async function customControls('),worker.indexOf('\nasync function recordFormProgress('));
  const customControls=new Function('fieldDescriptor','hostedFieldAnswer','protectedHostedQuestion','typeHostedSearch','scopedHostedComboboxOptions','prepareHostedDropdown','authorizeResearchFill','fillHostedButtonGroups','db',customSource+';return customControls;')(
   locator=>locator.evaluate(hostedFormState),hostedFieldAnswer,protectedHostedQuestion,typeHostedSearch,scopedHostedComboboxOptions,
   async(_db,_job,p,d,opts,answers)=>hostedOptionChoice(d,opts,p,answers),()=>true,async()=>{},null);
  for(const mode of ['fresh','resume','edited','ambiguous']){
   await page.setContent('<label>Location<input id="location" role="combobox" aria-controls="cities" aria-expanded="false" required></label><div role="listbox" id="cities"></div><button id="never-submit">Submit</button>');
   await page.evaluate(mode=>{
    window.selections=0;window.submits=0;
    const city=document.querySelector('#location'),list=document.querySelector('#cities'),answer='Toronto, Ontario, Canada';
    document.querySelector('#never-submit').onclick=()=>window.submits++;
    if(mode!=='fresh'){city.value=mode==='edited'?'Applicant edit':answer;city.dataset.applypilotUncommittedSearch='true';}
    const render=()=>{
     city.setAttribute('aria-expanded','true');list.innerHTML='<div role="option">Toronto, Ohio, United States</div>';
     clearTimeout(window.pickerTimer);window.pickerTimer=setTimeout(()=>{
      list.innerHTML='<div role="option">'+answer+'</div>'+(mode==='ambiguous'?'<div role="option">'+answer+'</div>':'');
      for(const option of list.children)option.onclick=()=>{window.selections++;city.value=option.textContent;city.setAttribute('aria-expanded','false');list.innerHTML='';};
     },900);
    };
    city.onclick=render;city.oninput=render;
   },mode);
   const p={location:'Toronto, Ontario, Canada',answers_json:'{}'};
   await customControls(page,p,{});
   assert.equal(await page.evaluate(()=>selections),['fresh','resume'].includes(mode)?1:0,mode);
   assert.equal(await page.evaluate(()=>submits),0,mode);
   if(['fresh','resume'].includes(mode)){
    assert.equal(await page.locator('#location').inputValue(),p.location);
    assert.equal(await page.locator('#location').getAttribute('data-applypilot-uncommitted-search'),null);
    assert.equal((await review(page)).missing.length,0);
   }else assert.equal((await review(page)).missing.length,1,mode);
   if(mode==='edited')assert.equal(await page.locator('#location').inputValue(),'Applicant edit');
  }
  // Optional texting opt-in inside a required phone wrapper must neither be
  // answered by the worker nor block an otherwise ready automatic submission.
  await page.setContent('<div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title _required_fixture">Phone Number</label><input type="tel" id="phone" required><div class="ashby-application-form-texting-consent-description"><label><input type="radio" name="communicationConsent">Yes - I consent to text messages</label><label><input type="radio" name="communicationConsent">No - I do not consent</label></div></div><button id="final">Submit application</button>');
  await fill(page,{phone:'4165550132',answers_json:'{}'});
  assert.equal((await review(page)).missing.length,0);
  assert.equal((await review(page)).required,1);
  assert.equal(await page.locator('[name="communicationConsent"]:checked').count(),0);
  await page.locator('#final').evaluate(e=>{e.onclick=()=>{window.clicks++;document.body.innerHTML='<p>Your application has been received</p>';};});
  assert.equal((await submitHostedApplication({...submission,submit:page.locator('#final')})).status,'submitted');
  assert.equal(reservations,2,'one reservation for each distinct synthetic form');
  console.log('PASS: hosted input commits, async location, optional consent isolation, and one-click receipt guards verified');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
