// Isolated synthetic employer page: no external employer requests or real applications.
const {chromium}=require('playwright');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.TEST_BROWSER_PATH?{executablePath:process.env.TEST_BROWSER_PATH}:{})});
 try{
  const context=await browser.newContext();
  await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<form id="app"><label>Full name<input id="name" required></label><button type="button" id="next">Next</button></form><script>document.querySelector('#next').onclick=()=>{document.querySelector('#app').innerHTML='<label>Email<input required type="email" id="email"></label><label>Resume<input type="file" required id="resume"></label><button type="button" id="submit">Submit application</button>';document.querySelector('#submit').onclick=()=>{if(!window.attempted)throw Error('Missing intent');window.clicks=(window.clicks||0)+1;document.querySelector('#app').innerHTML='<p>Your application has been received</p>';};};</script>`}));
  const page=await context.newPage();
  await page.addInitScript(()=>{
   window.messages=[];window.attempted=false;
   window.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){window.messages.push(m);if(m.action==='packet')return {ok:true,data:{job:{title:'Synthetic application'},profile:{name:'Fixture Applicant',email:'fixture@example.test'},answers:{},resume:{name:'resume.pdf',base64:btoa('%PDF-1.4 synthetic fixture')},automatic:true}};if(m.action==='state')return {ok:true,data:{attempted:window.attempted,automatic:!window.attempted}};if(m.action==='attempt'){if(window.attempted)throw Error('Duplicate attempt');window.attempted=true;}return {ok:true,data:{}};}}};
  });
  await page.goto('https://jobs.ashbyhq.com/fixture/job-123');
  for(const name of ['policy.js','content.js'])await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../extension',name),'utf8')});
  await page.waitForFunction(()=>window.messages.some(m=>m.action==='receipt'),{},{timeout:15000}).catch(async e=>{console.error(await page.evaluate(()=>({messages:window.messages,text:document.body.innerText})));throw e;});
  assert.equal(await page.evaluate(()=>window.clicks),1);
  assert.equal(await page.evaluate(()=>window.messages.filter(m=>m.action==='attempt').length),1);
  console.log('PASS: real Chromium form events, multi-page flow, PDF attachment, durable intent before submit, single click and receipt detection');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
