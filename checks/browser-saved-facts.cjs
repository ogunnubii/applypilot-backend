// Isolated Chromium fixture: every network request is fulfilled locally.
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.TEST_BROWSER_PATH?{executablePath:process.env.TEST_BROWSER_PATH}:{})});
 try{
  const context=await browser.newContext();
  await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<form><label>Can you please share a link to your LinkedIn Profile?<input required id="linkedin"></label><label>When can you start a new role?<input required id="start"></label><div class="application-question"><div class="application-label">Are you legally authorized to work in the country you are applying for?<span>✱</span></div><div class="application-field"><label><input type="radio" name="auth" value="yes" required>yes</label><label><input type="radio" name="auth" value="no" required>no</label></div></div><button type="button" id="submit">Submit application</button></form>`}));
  const page=await context.newPage();
  await page.addInitScript(()=>{
   window.messages=[];window.submitClicks=0;
   window.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){
    window.messages.push(m);
    if(m.action==='packet')return {ok:true,data:{job:{title:'Synthetic Canadian role'},profile:{},answers:{LinkedIn:'https://www.linkedin.com/in/fixture'},savedFactsAvailable:true,aiAssistance:false,automatic:true,autofillOnly:true,prepareSteps:true,autonomousSubmit:false}};
    if(m.action==='state')return {ok:true,data:{attempted:false,automatic:true,autofillOnly:true,prepareSteps:true,autonomousSubmit:false}};
    if(m.action==='answer')return {ok:true,data:{answer:m.question.startsWith('Are you legally authorized')?'yes':m.question==='When can you start a new role?'?'Immediately':''}};
    return {ok:true,data:{}};
   }}};
   document.addEventListener('click',e=>{if(e.target.id==='submit')window.submitClicks++;},true);
  });
  await page.goto('https://jobs.lever.co/fixture/123/apply');
  for(const file of ['policy.js','content.js'])await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../extension',file),'utf8')});
  await page.waitForFunction(()=>window.messages.some(m=>m.action==='progress'&&m.readyForSubmit),{},{timeout:15000});
  assert.equal(await page.locator('#linkedin').inputValue(),'https://www.linkedin.com/in/fixture');
  assert.equal(await page.locator('#start').inputValue(),'Immediately');
  assert.equal(await page.locator('[name="auth"]:checked').inputValue(),'yes');
  assert.equal(await page.evaluate(()=>window.submitClicks),0);
  assert.equal(await page.evaluate(()=>window.messages.filter(m=>m.action==='attempt'||m.action==='receipt').length),0);
  console.log('PASS: Chromium fills observed LinkedIn, availability and Lever radio wording without AI, and stops at ready for manual Submit.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
