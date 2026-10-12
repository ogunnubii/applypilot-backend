import test from 'node:test';
import assert from 'node:assert/strict';
import {submitHostedApplication,declineLeverCookies} from './hosted-submission.js';
test('only the observed optional Lever cookie notice can be declined',async()=>{
 const expected='This website uses cookies to improve your web experience. By clicking Accept, you agree to the use of cookies.';
 for(const scenario of ['valid','foreign','ambiguous','terms','accept','stays']){
  let clicks=0,hidden=false;
  const deny={count:async()=>scenario==='ambiguous'?2:1,innerText:async()=>scenario==='accept'?'Accept':'Deny',click:async()=>{clicks++;hidden=scenario!=='stays';}};
  const notice={count:async()=>1,locator:selector=>selector==='p'?{allTextContents:async()=>[scenario==='terms'?expected+' By submitting, you agree to employment terms.':expected]}:deny,waitFor:async()=>{if(!hidden)throw Error('still visible');}};
  const page={url:()=>scenario==='foreign'?'https://example.test/apply':'https://jobs.lever.co/fixture/role-123',locator:selector=>{assert.equal(selector,'.cc-window[role="dialog"][aria-label="cookieconsent"]:visible');return notice;}};
  assert.equal(await declineLeverCookies(page),scenario==='valid',scenario);
  assert.equal(clicks,['valid','stays'].includes(scenario)?1:0,scenario);
 }
});
function fixture(options={}){
 let text=options.before||'Name Email Resume Submit application',url='https://jobs.lever.co/fixture/role-123',attempts=0,clicks=0;
 const events=[];
 const input={job:{id:'fixture',url},page:{url:()=>url,locator:()=>({innerText:async()=>text})},submit:{async isEnabled(){return !options.disabled;},async click(clickOptions){if(clickOptions?.trial){events.push('trial');return;}events.push('click');clicks++;if(options.clickError)throw Error('connection lost');}},review:async()=>{if(options.reviewRedirect)url=options.reviewRedirect;return options.check||{captcha:false,signIn:false,missing:[]};},reserve:()=>{events.push('reserve');if(attempts)throw Error('Already attempted');attempts++;},wait:async()=>{if(!clicks)return;text=options.after??'Your application has been received';if(options.redirect)url=options.redirect;},recordLimit:()=>events.push('limit')};
 return {input,events,get clicks(){return clicks;},get attempts(){return attempts;}};
}
test('autonomous submission reserves before its only click and confirms only a new same-job receipt',async()=>{
 const f=fixture();const result=await submitHostedApplication(f.input);assert.equal(result.status,'submitted');assert.deepEqual(f.events,['trial','reserve','click']);assert.equal(f.clicks,1);
 await submitHostedApplication(f.input);assert.equal(f.clicks,1);
});

test('sent-to receipt after one matching application click confirms without repeating the attempt',async()=>{
 const f=fixture({after:'Your job application has been sent to Randstad Canada.'});
 const result=await submitHostedApplication(f.input);
 assert.equal(result.status,'submitted');
 assert.equal(result.confirmation,'Your job application has been sent to Randstad Canada.');
 await submitHostedApplication(f.input);
 assert.equal(f.clicks,1);
 const mismatch=fixture({after:'Your job application has been sent to Randstad Canada.',redirect:'https://jobs.lever.co/other/role-456'});
 assert.equal((await submitHostedApplication(mismatch.input)).challenge,'Unconfirmed submission');
});
test('unknown required answer, CAPTCHA, existing receipt and legal declaration stop before reservation',async()=>{
 for(const options of [{check:{missing:['Years of experience']}},{check:{captcha:true,missing:[]}},{check:{signIn:true,missing:[]}},{check:{pending:true,missing:[]}},{disabled:true},{before:'Your application has been received'},{before:'By submitting you agree to our terms'}]){
  const f=fixture(options);assert.equal((await submitHostedApplication(f.input)).status,'needs_review');assert.equal(f.attempts,0);assert.equal(f.clicks,0);
 }
});
test('uncertain click, timeout and other job receipt never confirm and never permit a second attempt',async()=>{
 for(const options of [{clickError:true},{after:'Still processing'},{redirect:'https://jobs.lever.co/other/role-456/thanks'}]){
  const f=fixture(options);const result=await submitHostedApplication(f.input);assert.equal(result.challenge,'Unconfirmed submission');assert.equal(f.clicks,1);assert.equal(f.attempts,1);
  await submitHostedApplication(f.input).catch(()=>{});assert.equal(f.clicks,1);
 }
});
test('destination changing during asynchronous final validation stops before any transmission',async()=>{
 const f=fixture({reviewRedirect:'https://jobs.lever.co/other/role-456'});assert.equal((await submitHostedApplication(f.input)).challenge,'Application identity changed');assert.equal(f.attempts,0);
});

test('verification appearing after Submit parks the uncertain attempt promptly and never repeats it',async()=>{
 for(const key of ['captcha','signIn']){
  const f=fixture({after:'Complete the employer verification to continue'});let receiptWaits=0;
  const wait=f.input.wait;
  f.input.wait=async ms=>{if(f.clicks)receiptWaits++;await wait(ms);};
  f.input.review=async()=>({missing:[],[key]:f.clicks>0});
  const result=await submitHostedApplication(f.input);
  assert.equal(result.challenge,'Unconfirmed submission');assert.match(result.message,/appeared after the automatic Submit click/);
  assert.equal(receiptWaits,1);assert.equal(f.clicks,1);assert.equal(f.attempts,1);
  await submitHostedApplication(f.input).catch(()=>{});assert.equal(f.clicks,1);
 }
});
test('best-effort mode releases pre-submit blocked browsers without discarding uncertain sessions',async()=>{
 const {retainBlockedSession}=await import('./hosted-submission.js');
 assert.equal(retainBlockedSession({status:'needs_review',challenge:'Missing answers',skipBlocked:true}),false);
 assert.equal(retainBlockedSession({status:'needs_review',challenge:'Missing answers',skipBlocked:false}),true);
 assert.equal(retainBlockedSession({status:'needs_review',challenge:'Unconfirmed submission',skipBlocked:true}),true);
 assert.equal(retainBlockedSession({status:'needs_review',challenge:'Worker error',attempted:true,skipBlocked:true}),true);
 assert.equal(retainBlockedSession({status:'submitted',skipBlocked:true}),false);
});
test('enabling best effort releases old blocked sessions even when all browser slots are full',async()=>{
 const {releaseSkippedHandoffs}=await import('./hosted-submission.js'),closed=[],notices=[];
 const session=(id,extra={})=>({job:{id},context:{close:async()=>closed.push(id)},...extra});
 const handoffs={sessions:new Map([['blocked',session('blocked')],['busy',session('busy',{busy:true})],['uncertain',session('uncertain',{attempted:true})],['manual',session('manual')]]),onClose:job=>notices.push(job.id)};
 await releaseSkippedHandoffs(handoffs,job=>job.id!=='manual');
 assert.deepEqual(closed,['blocked']);assert.deepEqual(notices,['blocked']);assert.deepEqual([...handoffs.sessions.keys()],['busy','uncertain','manual']);
});

test('negative employer response never upgrades the single reserved attempt to submitted',async()=>{
 for(const after of ['No application received. Please try again.','Your application was received with errors and could not be processed.']){
  const f=fixture({after});const result=await submitHostedApplication(f.input);assert.equal(result.challenge,'Unconfirmed submission');assert.equal(f.clicks,1);assert.equal(f.attempts,1);
  await submitHostedApplication(f.input).catch(()=>{});assert.equal(f.clicks,1);
 }
});

test('automatic click waits for async validation and a continuous settled interval',async()=>{
 const f=fixture();let time=0,clickedAt=-1;const click=f.input.submit.click;
 f.input.review=async()=>({missing:[],pending:time<1500});
 f.input.wait=async ms=>{time+=ms;if(f.clicks)await fixtureWait();};
 const fixtureWait=async()=>{f.input.page.locator=()=>({innerText:async()=> 'Your application has been received'});};
 f.input.submit.click=async options=>{if(!options?.trial)clickedAt=time;return click(options);};
 assert.equal((await submitHostedApplication(f.input)).status,'submitted');
 assert.equal(clickedAt,3500);assert.equal(f.clicks,1);
});

test('late validation, changed declarations and an obscured button prevent any attempt',async()=>{
 for(const cause of ['invalid','declaration','obscured']){
  const f=fixture();let checked=false;const click=f.input.submit.click;
  f.input.submit.click=async options=>{if(options?.trial){if(cause==='obscured')throw Error('covered');checked=true;if(cause==='declaration')f.input.page.locator=()=>({innerText:async()=> 'By submitting you agree to our terms'});}return click(options);};
  f.input.review=async()=>({missing:checked&&cause==='invalid'?['Employer validation']:[]});
  assert.equal((await submitHostedApplication(f.input)).status,'needs_review');assert.equal(f.attempts,0);assert.equal(f.clicks,0);
 }
});

test('a delayed employer receipt remains observed beyond the old thirty-second window',async()=>{
 const f=fixture({after:'Processing application'});let seconds=0;const wait=f.input.wait;
 f.input.wait=async ms=>{await wait(ms);if(f.clicks&&++seconds>=45)f.input.page.locator=()=>({innerText:async()=> 'Your application has been received'});};
 assert.equal((await submitHostedApplication(f.input)).status,'submitted');assert.equal(seconds,45);assert.equal(f.clicks,1);
});

test('readiness interval includes asynchronous validation triggered by scrolling Submit into view',async()=>{
 const f=fixture({after:'Still reviewing the application'});
 let time=0,trialAt=null,clickedAt=null,accepted=false;
 const actualClick=f.input.submit.click;
 f.input.submit.click=async options=>{
  if(options?.trial){trialAt=time;return actualClick(options);}
  clickedAt=time;
  // The scroll starts lazy validation. The busy indicator renders one task
  // later, and the employer's model becomes ready 800 ms after scrolling.
  accepted=trialAt!==null&&time>=trialAt+800;
  return actualClick(options);
 };
 f.input.review=async()=>({missing:[],pending:trialAt!==null&&time>=trialAt+50&&time<trialAt+800});
 f.input.wait=async ms=>{
  time+=ms;
  if(f.clicks&&accepted)f.input.page.locator=()=>({innerText:async()=> 'Your application has been received'});
 };
 assert.equal((await submitHostedApplication(f.input)).status,'submitted');
 assert(clickedAt>=trialAt+2800,'require a settled interval after the scroll-triggered validation finishes');
 assert.equal(f.attempts,1);assert.equal(f.clicks,1);
});

test('scroll-triggered pending uploads and late invalid fields stop before reservation',async()=>{
 for(const cause of ['upload','invalid','captcha','sign-in','disabled','redirect']){
  const f=fixture();let time=0,trialAt=null;
  const click=f.input.submit.click;
  f.input.submit.click=async options=>{if(options?.trial)trialAt=time;return click(options);};
  f.input.wait=async ms=>{time+=ms;};
  const changed=()=>trialAt!==null&&time>=trialAt+50;
  f.input.review=async()=>{
   if(changed()&&cause==='redirect')f.input.page.url=()=> 'https://jobs.lever.co/other/role-456';
   return {missing:changed()&&cause==='invalid'?['Employer validation']:[],pending:changed()&&cause==='upload',captcha:changed()&&cause==='captcha',signIn:changed()&&cause==='sign-in'};
  };
  f.input.submit.isEnabled=async()=>!(changed()&&cause==='disabled');
  const result=await submitHostedApplication(f.input);
  assert.equal(result.status,'needs_review',cause);assert.equal(f.attempts,0,cause);assert.equal(f.clicks,0,cause);
  assert.equal(f.events.filter(event=>event==='trial').length,1,cause);
 }
});

test('settling after the trial does not repeat the actionability action or weaken the one-click guard',async()=>{
 const f=fixture();let time=0,trialAt=null,clickedAt=-1;
 const click=f.input.submit.click,wait=f.input.wait;
 f.input.submit.click=async options=>{if(options?.trial)trialAt=time;else clickedAt=time;return click(options);};
 f.input.wait=async ms=>{time+=ms;await wait(ms);};
 // A second asynchronous validation wave interrupts an apparently ready form.
 f.input.review=async()=>({missing:[],pending:trialAt!==null&&time>=trialAt+1000&&time<trialAt+2000});
 assert.equal((await submitHostedApplication(f.input)).status,'submitted');
 assert.equal(clickedAt,4000);assert.deepEqual(f.events,['trial','reserve','click']);
 await submitHostedApplication(f.input);assert.equal(f.clicks,1);
});
