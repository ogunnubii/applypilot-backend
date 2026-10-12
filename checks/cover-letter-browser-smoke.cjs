// Real Chromium; every employer request is intercepted. No account, provider,
// production database, real employer navigation or Submit action is involved.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
(async()=>{
 const {composeCoverLetter}=await import('../cover-letter.js');
 const {renderCoverLetter,coverLetterFormat,documentTypes}=await import('../cover-letter-document.js');
 const hosted=await import('../hosted-form.js'),{hostedFormState}=await import('../hosted-form-state.js'),{fillHostedText,typeHostedSearch}=await import('../hosted-input.js'),{pickResumeField}=await import('../form-policy.js');
 const {savedOptionSelections,sameApplication}=await import('../local-policy.js');
 const text=composeCoverLetter({profile:{name:'Élodie Fixture'},job:{title:'Support Engineer',company:'Example Company'},facts:{'Professional background':'I investigated customer incidents and documented practical solutions. I supported Linux services.'},experience:[]}).answer;
 const launch=()=>chromium.launch({headless:true,...(process.env.TEST_BROWSER_PATH?{executablePath:process.env.TEST_BROWSER_PATH}:{})});
 const pdf=await renderCoverLetter(text,'pdf',{launch});assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
 const files={pdf,docx:await renderCoverLetter(text,'docx')};
 if(process.env.COVER_LETTER_EVIDENCE_DIR){fs.mkdirSync(process.env.COVER_LETTER_EVIDENCE_DIR,{recursive:true});for(const [format,buffer]of Object.entries(files))fs.writeFileSync(path.join(process.env.COVER_LETTER_EVIDENCE_DIR,'synthetic-cover-letter.'+format),buffer);}
 const prepare=async(_db,_uid,_id,options)=>{if(!options.required)return {answer:''};const format=options.format==='file'?coverLetterFormat(options.accept):null;if(options.format==='file'&&!format)return {answer:'',reason:'Unsupported employer format.'};return {answer:text,requiresReview:true,manualSubmit:true,...(format?{file:{name:'cover-letter.'+format,mimeType:documentTypes[format],base64:files[format].toString('base64')}}:{})};};
 const worker=fs.readFileSync(path.join(__dirname,'../worker.js'),'utf8'),source=worker.slice(worker.indexOf('async function fieldDescriptor('),worker.indexOf('async function recordFormProgress('));
 const helpers=new Function(...Object.keys(hosted),'hostedFormState','fillHostedText','typeHostedSearch','pickResumeField','savedOptionSelections','sameApplication','prepareCoverLetter','employerHold','savedSearchClaimProblem','event','db',source+';return {custom,attachHostedCoverLetters,attachHostedResume};')(...Object.values(hosted),hostedFormState,fillHostedText,typeHostedSearch,pickResumeField,savedOptionSelections,sameApplication,prepare,()=>null,()=>'',()=>{},null);
 const browser=await launch();let scenarios=0;
 try{
  for(const mode of ['extension','hosted'])for(const kind of ['text','docx','pdf','unsupported','optional-text','optional-file','existing-text','existing-file','edit-during-generation','accept-changed']){
   const context=await browser.newContext(),page=await context.newPage(),url='https://jobs.lever.co/fixture/cover-letter',file=!/text|edit-during/.test(kind),optional=kind.startsWith('optional'),existing=kind.startsWith('existing'),accept=kind==='unsupported'?'.txt':kind==='pdf'?'.pdf':'.docx';
   const field=file?`<label>Cover letter<input id="letter" type="file" accept="${accept}" ${optional?'':'required'}></label>`:`<label>Cover letter<textarea id="letter" ${optional?'':'required'}>${existing?'My existing letter':''}</textarea></label>`;
   await context.route('**/*',route=>route.request().url()===url?route.fulfill({contentType:'text/html',body:`<form>${field}<button type="button" id="submit">Submit application</button></form><script>window.submits=0;document.getElementById('submit').onclick=()=>submits++;</script>`}):route.abort());
   await page.goto(url);if(existing&&file)await page.locator('#letter').setInputFiles({name:'my-own-letter.docx',mimeType:documentTypes.docx,buffer:files.docx});
   const calls=[];const prepareWithEdit=async(...args)=>{calls.push(args[3]);if(kind==='edit-during-generation')await page.locator('#letter').fill('My concurrent edit');if(kind==='accept-changed')await page.locator('#letter').evaluate(e=>e.accept='.txt');return prepare(...args);};
   if(mode==='extension'){
    await page.exposeFunction('applypilotFixtureMessage',async m=>{calls.push(m);let data={};if(m.action==='packet')data={job:{id:'fixture',title:'Support Engineer',url},profile:{name:'Fixture'},savedFactsAvailable:true,autonomousSubmit:true,answers:{},resume:{name:'resume.pdf',base64:Buffer.from('%PDF-test-resume').toString('base64')}};
     if(m.action==='state')data={attempted:false,automatic:true};if(m.action==='cover-letter')data=await prepareWithEdit(null,'u','fixture',m);return {ok:true,data};});
    await page.evaluate(()=>{window.chrome={runtime:{onMessage:{addListener(fn){window.fixtureListener=fn;}},sendMessage:m=>window.applypilotFixtureMessage(m)}};});
    await page.addScriptTag({path:path.join(__dirname,'../extension/policy.js')});await page.addScriptTag({path:path.join(__dirname,'../extension/content.js')});
    for(let i=0;i<120&&!calls.some(m=>m.action==='progress'&&m.blocked);i++)await page.waitForTimeout(50);
    assert(!calls.some(m=>m.action==='attempt'),kind+' must not request a submission');
   }else{
    // Cover-letter-only forms must not receive a resume or fail resume detection.
    assert.deepEqual(await helpers.attachHostedResume(page,{resume_path:'/must-not-read/resume.pdf'}),{attached:false});
    const localHelpers=new Function(...Object.keys(hosted),'hostedFormState','fillHostedText','typeHostedSearch','pickResumeField','savedOptionSelections','sameApplication','prepareCoverLetter','employerHold','savedSearchClaimProblem','event','db',source+';return {custom,attachHostedCoverLetters};')(...Object.values(hosted),hostedFormState,fillHostedText,typeHostedSearch,pickResumeField,savedOptionSelections,sameApplication,prepareWithEdit,()=>null,()=>'',()=>{},null);
    const job={id:'fixture',user_id:'u',url,answers_json:'{}'};
    if(file)await localHelpers.attachHostedCoverLetters(page,job);else await localHelpers.custom(page,{answers_json:'{}'},job);
   }
   const actual=await page.locator('#letter').evaluate(e=>e.type==='file'?[...e.files].map(f=>({name:f.name,size:f.size,type:f.type})):e.value);
   if(optional)assert(file?actual.length===0:actual==='',mode+' '+kind);
   else if(existing)assert(file?actual[0].name==='my-own-letter.docx':actual==='My existing letter',mode+' '+kind);
   else if(kind==='edit-during-generation')assert.equal(actual,'My concurrent edit');
   else if(kind==='unsupported'||kind==='accept-changed')assert.equal(actual.length,0,mode+' '+kind);
   else if(file){assert.equal(actual[0].name,'cover-letter.'+kind);assert.equal(actual[0].size,files[kind].length);assert.equal(actual[0].type,documentTypes[kind]);}
   else assert.equal(actual,text,mode+' '+kind);
   if(mode==='extension'&&kind==='text'){await page.waitForTimeout(100);await page.locator('#letter').fill('');const response=await page.evaluate(()=>new Promise(resolve=>window.fixtureListener({action:'fill'},null,resolve)));assert(response.ok);assert.equal(await page.locator('#letter').inputValue(),text,'explicit repreparation refreshes an emptied cover-letter field');}
   assert.equal(await page.evaluate(()=>submits),0,mode+' '+kind);await context.close();scenarios++;
  }
  console.log('PASS: '+scenarios+' real-browser extension/hosted cover-letter scenarios; PDF/DOCX, required/optional, existing/concurrent edits, changed accepted format, no resume substitution and zero Submit clicks.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
