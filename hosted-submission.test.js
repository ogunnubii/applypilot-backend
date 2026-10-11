import test from 'node:test';
import assert from 'node:assert/strict';
import {submitHostedApplication} from './hosted-submission.js';
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
