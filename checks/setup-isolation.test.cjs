const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {JSDOM}=require('jsdom');
const path=require('node:path');
const root=path.join(__dirname,'..');
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
const alice={id:'profile-a',name:'Alice Example',email:'alice@example.test',phone:'5550100',location:'Private address',focus:'Platform',execution_mode:'local',consent:true,ai_consent:true,google_research_consent:true,gemini_facts_consent:true,has_resume:true,answers:{Website:'https://alice.example.test','Professional background':'Private Alice work history'}};
function fixture(){
 const dom=new JSDOM(readFileSync(path.join(root,'web/setup.html'),'utf8'),{url:'https://example.test/setup',runScripts:'outside-only'}),w=dom.window;
 w.sessionStorage.setItem('applypilot-token','account-a');w.URL.revokeObjectURL=()=>{};w.URL.createObjectURL=()=> 'blob:old-private-file';
 const calls=[];let delayA=false,resolveA,delayResume=false,resolveResume;
 w.fetch=async(url,options={})=>{
  const route=new URL(String(url),w.location.origin).pathname.replace('/api',''),authorization=options.headers?.Authorization,input=options.body&&typeof options.body==='string'?JSON.parse(options.body):null;
  calls.push({route,authorization,input});let data={};
  if(route==='/login')data={token:'account-b'};
  else if(route==='/applicants'&&(options.method||'GET')==='GET'){
   if(authorization==='Bearer account-a'&&delayA)return new Promise(resolve=>{resolveA=()=>resolve({ok:true,json:async()=>({applicants:[alice]})});});
   data={applicants:authorization==='Bearer account-a'?[alice]:[]};
  }else if(route==='/applicants/profile-a/experience')data={facts:[{id:'fact-a',title:'Alice private achievement',details:'Private project details'}]};
  else if(route==='/applicants/profile-a/resume'){
   data={base64:'WA==',mime:'application/pdf',applicant:alice.name,name:'alice.pdf',text:'Private Alice résumé',bytes:1};
   if(delayResume)return new Promise(resolve=>{resolveResume=()=>resolve({ok:true,json:async()=>data});});
  }else if(route==='/applicants'&&options.method==='POST')data={id:'profile-b'};
  return {ok:true,json:async()=>data};
 };
 w.eval(readFileSync(path.join(root,'web/setup.js'),'utf8'));
 const switchAccount=async()=>{const form=w.document.querySelector('#account');form.elements.email.value='bob@example.test';form.elements.password.value='long-new-password';await form.onsubmit({preventDefault(){},target:form,submitter:form.querySelector('[value=login]')});};
 return {w,calls,switchAccount,delayApplicants:()=>{delayA=true;},releaseApplicants:()=>resolveA(),delayResume:()=>{delayResume=true;},releaseResume:()=>resolveResume(),close:()=>w.close()};
}
test('switching from a populated account to a new account clears every applicant draft, consent and resume surface',async()=>{
 const f=fixture();try{
  await tick();const d=f.w.document,profile=d.querySelector('#profile');assert.equal(profile.elements.name.value,alice.name);
  assert.match(d.querySelector('#experience-list').textContent,/Alice private achievement/);
  d.querySelector('#resume-editor').hidden=false;d.querySelector('#resume-editor-text').value='Private edited résumé';d.querySelector('#resume-editor-pages').textContent='Private PDF page';
  d.querySelector('#resume-preview').setAttribute('open','');d.querySelector('#resume-preview-text').textContent='Private Alice résumé';d.querySelector('#resume-original').href='blob:old-private-file';d.querySelector('#resume-previous').href='blob:old-previous-file';
  d.querySelector('#search [name=instruction]').value='Alice private job search';d.querySelector('#job [name=url]').value='https://private.example.test/job';
  await f.switchAccount();
  assert.equal(d.querySelector('#profiles').value,'');assert.equal(d.querySelector('#profiles').options.length,1);
  for(const input of profile.querySelectorAll('input:not([type=file]),textarea'))assert.equal(input.type==='checkbox'?input.checked:input.value,input.type==='checkbox'?false:'',input.name);
  assert.equal(d.querySelector('#resume').value,'');assert.equal(d.querySelector('#resume-editor').hidden,true);assert.equal(d.querySelector('#resume-editor-text').value,'');assert.equal(d.querySelector('#resume-editor-pages').textContent,'');assert.equal(d.querySelector('#save-edited-resume').disabled,true);
  assert.equal(d.querySelector('#resume-preview').open,false);assert.equal(d.querySelector('#resume-preview-text').textContent,'');assert.equal(d.querySelector('#resume-original').hasAttribute('href'),false);assert.equal(d.querySelector('#resume-previous').hasAttribute('href'),false);
  assert.equal(d.querySelector('#experience-list').textContent,'');assert.equal(d.querySelector('#experience-form').hidden,true);assert.equal(d.querySelector('#current-resume').textContent,'');
  assert.equal(d.querySelector('#search [name=instruction]').value,'');assert.equal(d.querySelector('#job [name=url]').value,'');
  assert.equal(d.querySelector('#account [name=password]').value,'');
  profile.elements.name.value='Bob';profile.elements.email.value='bob@example.test';await profile.onsubmit({preventDefault(){},target:profile,submitter:profile.querySelector('button')});
  const save=f.calls.find(c=>c.route==='/applicants'&&c.input);assert.equal(save.authorization,'Bearer account-b');assert.equal(save.input.name,'Bob');assert.deepEqual(save.input.answers,{});assert.equal(save.input.consent,false);assert.equal(f.calls.some(c=>c.authorization==='Bearer account-b'&&c.route.includes('/resume')),false);
 }finally{f.close();}
});
test('an old account applicant response cannot repopulate a newly signed-in account',async()=>{
 const f=fixture();try{await tick();f.delayApplicants();const oldLoad=f.w.load();await tick();await f.switchAccount();f.releaseApplicants();await oldLoad;assert.equal(f.w.document.querySelector('#profiles').options.length,1);assert.equal(f.w.document.querySelector('#profile [name=name]').value,'');}finally{f.close();}
});
test('an old account resume response cannot reopen its preview after switching accounts',async()=>{
 const f=fixture();try{
  await tick();f.delayResume();const button=[...f.w.document.querySelectorAll('#current-resume button')].find(b=>b.textContent==='View current resume');const preview=button.onclick();await tick();await f.switchAccount();f.releaseResume();await preview;
  assert.equal(f.w.document.querySelector('#resume-preview').open,false);assert.equal(f.w.document.querySelector('#resume-preview-text').textContent,'');assert.equal(f.w.document.querySelector('#resume-original').hasAttribute('href'),false);
 }finally{f.close();}
});
