// Optional real-browser QA. All requests are synthetic or aborted; never sends
// an application and never invokes a model, real employer, or production DB.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
(async()=>{
 const hosted=await import('../hosted-form.js');
 const {hostedFormState}=await import('../hosted-form-state.js');
 const {fillHostedText,typeHostedSearch}=await import('../hosted-input.js');
 const {pickResumeField}=await import('../form-policy.js');
 const {savedAnswer,savedOptionSelections,sameApplication}=await import('../local-policy.js');
 const worker=fs.readFileSync(path.join(__dirname,'../worker.js'),'utf8');
 const source=worker.slice(worker.indexOf('async function fieldDescriptor('),worker.indexOf('async function recordFormProgress('));
 const prepare=new Function(...Object.keys(hosted),'hostedFormState','fillHostedText','typeHostedSearch','pickResumeField','savedOptionSelections','sameApplication','automaticTextAnswer','prepareHostedDropdown','researchConsentWithdrawn','hasResearchDraftForQuestion','markResearchDraftUsed','fillHostedButtonGroups','event','db',source+';return prepareHostedFields;')(
  ...Object.values(hosted),hostedFormState,fillHostedText,typeHostedSearch,pickResumeField,savedOptionSelections,sameApplication,
  async({question,answers})=>({answer:savedAnswer(question,answers),source:'saved'}),async(_db,_j,p,d,opts,answers)=>hosted.hostedOptionChoice(d,opts,p,answers),()=>false,()=>false,()=>{},async()=>{},()=>{},null);
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'applypilot-hosted-qa-'));
 const resume=path.join(directory,'fixture-resume.pdf');fs.writeFileSync(resume,'%PDF-1.4\n% Synthetic test resume; no personal information.\n%%EOF\n');
 const browser=await chromium.launch({headless:true,...(process.env.TEST_BROWSER_PATH?{executablePath:process.env.TEST_BROWSER_PATH}:{})});
 try{
  const context=await browser.newContext();
  const jobUrl='https://boards.greenhouse.io/fixture/jobs/12345',frameUrl='https://boards.greenhouse.io/embed/job_app?for=fixture&token=12345';
  const html=`<form><fieldset><legend>Your name</legend><label for="first">First name</label><input id="first" required><label for="last">Last name</label><input id="last" required></fieldset>
   <label id="prefix" for="tools">Which tools</label><span id="suffix">have you used?</span><select id="tools" aria-labelledby="prefix suffix" multiple required><option value="git">Git</option><option value="sql">SQL</option></select>
   <label>Location<input id="city" role="combobox" aria-controls="cities" aria-expanded="false" required></label><div id="cities" role="listbox"></div>
   <label>Resume<input id="resume" type="file" required></label><div id="conditional"></div><button id="submit" type="button">Submit application</button></form>
   <script>window.submits=0;window.uploads=0;document.querySelector('#submit').onclick=()=>window.submits++;
    const first=document.querySelector('#first'),city=document.querySelector('#city'),list=document.querySelector('#cities');
    first.onchange=()=>{if(document.querySelector('#website'))return;setTimeout(()=>document.querySelector('#conditional').innerHTML='<label>Website<input id="website" type="url" required></label>',600);};
    const render=()=>{city.setAttribute('aria-expanded','true');clearTimeout(window.timer);window.timer=setTimeout(()=>{list.innerHTML='<div role="option">Toronto, Ontario, Canada</div>';list.firstChild.onclick=()=>{city.value='';city.setAttribute('aria-valuetext','Toronto, Ontario, Canada');city.setAttribute('aria-expanded','false');list.innerHTML='';};},500);};city.onclick=render;city.oninput=render;
    document.querySelector('#resume').onchange=()=>{uploads++;const progress=document.createElement('div');progress.setAttribute('role','progressbar');progress.textContent='Uploading';document.querySelector('form').append(progress);setTimeout(()=>progress.remove(),900);};
   </script>`;
  await context.route('**/*',route=>{
   const url=route.request().url();
   if(url===jobUrl)return route.fulfill({contentType:'text/html',body:'<div role="option">Unrelated parent option</div><iframe style="width:1000px;height:900px" src="'+frameUrl+'"></iframe>'});
   if(url===frameUrl)return route.fulfill({contentType:'text/html',body:html});
   return route.abort();
  });
  const page=await context.newPage();await page.goto(jobUrl);const frame=page.frames().find(f=>f.url()===frameUrl);assert(frame);
  const profile={name:'Fixture Applicant',location:'Toronto, Ontario, Canada',resume_path:resume,answers_json:JSON.stringify({'Which tools have you used?':'["Git","SQL"]',Website:'https://example.test/fixture'})};
  const result=await prepare(frame,profile,{id:'fixture',url:jobUrl,answers_json:'{}'},ms=>page.waitForTimeout(ms));
  assert.equal(await frame.locator('#first').inputValue(),'Fixture');assert.equal(await frame.locator('#last').inputValue(),'Applicant');
  assert.deepEqual(await frame.locator('#tools').evaluate(e=>[...e.selectedOptions].map(o=>o.value)),['git','sql']);
  assert.equal(await frame.locator('#website').inputValue(),'https://example.test/fixture');assert.equal(await frame.evaluate(()=>uploads),1);assert.equal(await frame.evaluate(()=>submits),0);
  assert.equal(result.check.pending,false);assert.deepEqual(result.check.missing,[]);assert.deepEqual(result.unknown,[]);
  // Outer-page challenges continue to block a correctly identified iframe.
  await page.locator('body').evaluate(e=>{const captcha=document.createElement('div');captcha.className='g-recaptcha';captcha.textContent='Synthetic human verification';e.prepend(captcha);});
  const blocked=await prepare(frame,profile,{id:'fixture',url:jobUrl},ms=>page.waitForTimeout(ms));assert.equal(blocked.check.captcha,true);assert.equal(await frame.evaluate(()=>submits),0);
  console.log('PASS: hosted iframe preparation, complete labels, multiselect, deferred location, conditional fields, upload completion and no-submit guards');
 }finally{await browser.close();fs.rmSync(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
