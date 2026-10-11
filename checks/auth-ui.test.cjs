const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {JSDOM,VirtualConsole}=require('jsdom');
const path=require('node:path');
const root=path.join(__dirname,'..');
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
function fixture(client,{url='https://example.test/signup',session='',handler}={}){
 const page=client==='assistant-client.js'?'assistant-page.html':'web/progress.html';
 const dom=new JSDOM(readFileSync(path.join(root,page),'utf8'),{url,runScripts:'outside-only',virtualConsole:new VirtualConsole()}),w=dom.window;
 w.setInterval=()=>0;if(session)w.sessionStorage.setItem('applypilot-token',session);const calls=[];
 w.fetch=async(url,options={})=>{
  const route=new URL(String(url),w.location.origin).pathname.replace('/api',''),input=options.body?JSON.parse(options.body):undefined;
  calls.push({route,input});const custom=await handler?.(route,input);if(custom)return custom;
  const data=route==='/jobs'?{jobs:[]}:route==='/status'?{workerOnline:true}:route==='/application-history'?{records:[]}:route==='/operations'?{totals:{},applications:[]}:route==='/activity'?{events:[]}:route==='/continuations'?{requests:[]}:route==='/pipeline'?{enabled:false,found:0}:route==='/employer-limits'?{limits:[]}:route==='/searches'?{searches:[]}:route==='/ai-status'?{profiles:[],attempts:[]}:{};
  return {ok:true,json:async()=>data};
 };
 w.eval(readFileSync(path.join(root,'extension/policy.js'),'utf8'));w.eval(readFileSync(path.join(root,client),'utf8'));
 const form=w.document.querySelector('#auth');form.elements.email.value='person@example.test';form.elements.password.value='long-test-password';
 return {w,calls,form,submit:()=>form.onsubmit({preventDefault(){},target:form}),close:()=>w.close()};
}
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
for(const client of ['assistant-client.js','web/progress.js']){
 test(client+' supports separate signup and signin without requiring a registration code',async()=>{
  const f=fixture(client);
  try{
   assert.equal(f.w.document.querySelector('#auth-submit').textContent,'Create account →');
   assert.match(f.w.document.querySelector('#auth-account-limitations').textContent,/Email verification and password recovery/);assert.equal(f.w.document.querySelector('#auth-account-limitations').hidden,false);
   assert.equal(f.form.elements.password.minLength,12);assert.equal(f.form.elements.password.autocomplete,'new-password');
   assert.equal(f.form.querySelector('[name=registration_code]'),null);
   f.w.document.querySelector('#auth-switch').click();
   assert.equal(f.w.document.querySelector('#auth-submit').textContent,'Sign in →');
   assert.equal(f.form.elements.password.hasAttribute('minlength'),false,'existing shorter passwords may still log in');
   assert.equal(f.form.elements.email.value,'person@example.test','switching mode retains entered identity');
  }finally{f.close();}
 });
 test(client+' keeps unverified-account email notifications disabled and explains why',async()=>{
  const f=fixture(client,{handler:route=>route==='/notifications'?response({enabled:false,configured:false,emailVerificationRequired:true}):undefined});
  try{await f.w.refresh(true);await tick();const section=f.w.document.querySelector('#blocker-notifications');assert.equal(section.querySelector('input').disabled,true);assert.equal(section.querySelector('input').checked,false);assert.match(section.textContent,/unavailable until email verification is supported/);}finally{f.close();}
 });
 test(client+' prevents repeated signup and saves only the opted-in session, never the password',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);
  const f=fixture(client,{handler:route=>route==='/signup'?pending:undefined});
  try{
   f.form.elements.remember.checked=true;const first=f.submit();await f.submit();
   assert.equal(f.calls.filter(c=>c.route==='/signup').length,1);
   assert.equal(f.w.document.querySelector('#auth-submit').disabled,true);
   resolve(response({token:'new-token',user:{id:'u',email:'person@example.test'}}));await first;
   assert.equal(f.w.localStorage.getItem('applypilot-remembered-token'),'new-token');
   assert.equal(f.form.elements.password.value,'');
   assert.equal(f.w.document.querySelector('#account-email').textContent,'person@example.test');
   assert.match(f.w.document.querySelector('#notice').textContent,/Account created/);
   assert.match(f.w.document.querySelector('#notice a').href,/\/setup$/);
   assert(!Object.keys(f.w.localStorage).some(k=>/password/i.test(k)));
  }finally{f.close();}
 });
 test(client+' retains unsuccessful signup input and rejects short passwords without a request',async()=>{
  const f=fixture(client,{handler:route=>route==='/signup'?response({error:'Unable to create account with these details. Try signing in.'},409):undefined});
  try{
   f.form.elements.password.value='too-short';await f.submit();assert.equal(f.calls.filter(c=>c.route==='/signup').length,0);
   assert.match(f.w.document.querySelector('#auth-error').textContent,/12–128/);
   f.form.elements.password.value='long-test-password';await f.submit();
   assert.equal(f.form.elements.email.value,'person@example.test');assert.equal(f.form.elements.password.value,'long-test-password');
   assert.match(f.w.document.querySelector('#auth-error').textContent,/Try signing in/);
   assert.equal(f.w.document.querySelector('#auth-submit').disabled,false);
   assert.equal(f.w.sessionStorage.getItem('applypilot-token'),null);
  }finally{f.close();}
 });
 test(client+' verifies a restored session before loading private work and clears an expired session',async()=>{
  const f=fixture(client,{session:'expired',handler:route=>route==='/me'?response({error:'Sign in required'},401):undefined});
  try{
   await tick();assert.equal(f.calls[0].route,'/me');assert.equal(f.calls.some(c=>c.route==='/jobs'),false);
   assert.equal(f.w.sessionStorage.getItem('applypilot-token'),null);assert.equal(f.w.document.querySelector('#workspace').hidden,true);
   assert.match(f.w.document.querySelector('#notice').textContent,/session expired/);
  }finally{f.close();}
 });
 test(client+' revokes a session before clearing it and treats a revoked session as signed out',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);
  const f=fixture(client,{session:'valid',handler:route=>route==='/me'?response({user:{id:'u',email:'person@example.test'}}):route==='/logout'?pending:undefined});
  try{
   await tick();const first=f.w.document.querySelector('#logout').onclick();await f.w.document.querySelector('#logout').onclick();
   assert.equal(f.calls.filter(c=>c.route==='/logout').length,1);assert.equal(f.w.sessionStorage.getItem('applypilot-token'),'valid');
   resolve(response({error:'Sign in required'},401));await first;
   assert.equal(f.w.sessionStorage.getItem('applypilot-token'),null);assert.equal(f.w.document.querySelector('#workspace').hidden,true);
   assert.equal(f.w.document.querySelector('#account-email').textContent,'');
  }finally{f.close();}
 });
 test(client+' preserves the session on a failed server logout and allows retry',async()=>{
  const f=fixture(client,{session:'valid',handler:route=>route==='/me'?response({user:{id:'u',email:'person@example.test'}}):route==='/logout'?response({error:'Temporary outage'},503):undefined});
  try{
   await tick();await f.w.document.querySelector('#logout').onclick();assert.equal(f.w.sessionStorage.getItem('applypilot-token'),'valid');
   assert.equal(f.w.document.querySelector('#logout').disabled,false);assert.match(f.w.document.querySelector('#notice').textContent,/Could not sign out on the server/);
  }finally{f.close();}
 });
}
