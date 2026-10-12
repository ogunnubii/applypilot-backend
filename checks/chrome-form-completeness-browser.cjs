// Real Chromium, synthetic intercepted pages only. Never contacts an employer,
// requests a paid model answer, clicks Submit, or changes account settings.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const content=name=>fs.readFileSync(path.join(__dirname,'../extension',name),'utf8');
const fixtureUrl='https://job-boards.greenhouse.io/fixture/jobs/form-check';
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.TEST_BROWSER_PATH?{executablePath:process.env.TEST_BROWSER_PATH}:{})});
 try{
  const context=await browser.newContext();let html='';
  await context.route('**/*',route=>route.request().url()===fixtureUrl?route.fulfill({contentType:'text/html',body:html}):route.abort());
  const page=await context.newPage();
  await page.addInitScript(()=>{
   window.messages=[];window.submits=0;window.model={};
   window.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);return {ok:true,data:m.action==='packet'?{job:{title:'Synthetic application'},profile:{name:'Fixture Applicant',email:'fixture@example.test',phone:'(416) 555-0132',location:'Toronto, Ontario, Canada'},answers:{'Which tools have you used in production?':'["Terraform","Kubernetes"]','Available start date':'2026-11-03'},resume:{name:'resume.pdf',base64:btoa('%PDF-1.4 synthetic fixture')},autofillOnly:true,prepareSteps:true,autonomousSubmit:false}:m.action==='state'?{automatic:true,autofillOnly:true,prepareSteps:true,refreshEnabled:true,attempted:false,autonomousSubmit:false}:{}};}}};
  });
  async function prepare(body){
   html=body;await page.goto(fixtureUrl);for(const name of ['policy.js','content.js'])await page.addScriptTag({content:content(name)});
   await page.waitForFunction(()=>messages.some(m=>m.action==='progress'&&m.blocked),{},{timeout:12000});
   const state=await page.evaluate(()=>({progress:messages.findLast(m=>m.action==='progress'&&m.blocked),messages,submits,model}));
   assert.equal(state.submits,0);assert(!state.messages.some(m=>['attempt','receipt','answer','autosave','assistance'].includes(m.action)));return state;
  }
  let result=await prepare(`<form id="application">
   <div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title _required_fixture">Full name</label><input id="name"></div>
   <label>Email<input id="email" type="email" required></label>
   <label>Phone number<input id="phone" type="tel" pattern="[0-9]{10}" required></label>
   <label>Available start date<input id="date" type="date" required></label>
   <label for="tools" id="prefix">Which tools</label><span id="suffix">have you used in production?</span><select id="tools" multiple required aria-labelledby="prefix suffix"><option>Terraform</option><option>Kubernetes</option><option>Docker</option></select>
   <div class="application-question"><label for="resume">Resume</label><input id="resume" type="file" required hidden accept=".pdf"><button type="button">Upload resume</button></div>
   <button type="button" id="submit">Submit application</button></form><script>
   document.querySelector('#submit').onclick=()=>submits++;
   for(const id of ['name','email','phone','date'])document.getElementById(id).onblur=event=>{model[id]=event.target.value;};
   document.getElementById('tools').onchange=event=>{model.tools=[...event.target.selectedOptions].map(option=>option.textContent);};
   document.getElementById('resume').onchange=event=>{const form=event.target.form;form.setAttribute('aria-busy','true');setTimeout(()=>{model.resume=event.target.files[0].name;form.removeAttribute('aria-busy');},300);};
  </script>`);
  assert.equal(result.progress.readyForSubmit,true);assert.deepEqual(result.progress.progress,{required:6,filled:6});
  assert.deepEqual(result.model,{name:'Fixture Applicant',email:'fixture@example.test',phone:'4165550132',date:'2026-11-03',tools:['Terraform','Kubernetes'],resume:'resume.pdf'});
  assert.equal(await page.evaluate(()=>document.querySelector('#resume').files[0].size),26);
  assert.equal(await page.evaluate(()=>document.activeElement===document.body),true);

  result=await prepare(`<form><label>Current location<input id="location" role="combobox" required aria-expanded="false" aria-controls="options"></label><div id="options" role="listbox"></div><button type="button" id="submit">Submit application</button></form><script>
   const field=document.querySelector('#location'),list=document.querySelector('#options');let timer;
   document.querySelector('#submit').onclick=()=>submits++;
   field.onclick=()=>field.setAttribute('aria-expanded','true');
   field.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{list.innerHTML='<div role="option">Toronto, Ontario, Canada</div>';list.firstChild.onclick=()=>{field.value=list.textContent;field.setAttribute('aria-valuetext',list.textContent);field.setAttribute('aria-expanded','false');model.location=list.textContent;list.innerHTML='';};},950);};
  </script>`);
  assert.equal(result.progress.readyForSubmit,true);assert.equal(result.model.location,'Toronto, Ontario, Canada');

  result=await prepare(`<form aria-busy="true"><label>Email<input type="email" value="fixture@example.test" required></label><div class="application-question"><label>Resume<input type="file" id="resume" required hidden></label><div role="progressbar">Uploading</div></div><button type="button" id="submit">Submit application</button></form><script>document.querySelector('#submit').onclick=()=>submits++;</script>`);
  assert.equal(result.progress.readyForSubmit,false);assert.match(result.progress.message,/processing.*upload/);

  result=await prepare(`<form><label>Current location<input role="combobox" value="Toron" aria-expanded="false" required></label><button type="button" id="submit">Submit application</button></form><script>document.querySelector('#submit').onclick=()=>submits++;</script>`);
  assert.equal(result.progress.readyForSubmit,false);assert.deepEqual(result.progress.fields,['Current location']);
  assert.equal(await page.locator('input').inputValue(),'Toron');
  console.log('PASS: real Chromium committed contact/date/multiselect/resume, delayed location, blocked pending upload and uncommitted search; no Submit, model calls or false human-answer autosave');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
