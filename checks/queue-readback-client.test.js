import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
for(const client of ['assistant-client.js','web/progress.js']){
 const source=readFileSync(new URL('../'+client,import.meta.url),'utf8');
 test(client+' distinguishes applied transitions, refresh failures, explicit guards and unavailable verification without retrying POST',async()=>{
  for(const scenario of ['refresh-failed','lost-response-applied','guard-blocked','verification-unavailable']){
   const dom=new JSDOM('<div id="home-summary"></div><p id="notice"></p>',{url:'https://example.test/?view=settings',runScripts:'outside-only'}),w=dom.window;let posts=0,applied=false,afterPost=false;const calls=[];
   w.$=s=>w.document.querySelector(s);w.el=(tag,text)=>{const e=w.document.createElement(tag);if(text)e.textContent=text;return e;};w.field=form=>{const e=w.document.createElement('input');form.append(e);return e;};
   w.refresh=async()=>{if(scenario==='refresh-failed')throw Error('Request failed (HTTP 503, GET /api/jobs).');};
   w.api=async(path,method,data)=>{calls.push({path,method,data});if(path==='/applicants')return {applicants:[{id:'p',name:'Fixture'}]};if(path==='/application-batch'){posts++;afterPost=true;applied=['refresh-failed','lost-response-applied'].includes(scenario);if(scenario==='lost-response-applied')throw Error('Request failed (HTTP 502, POST /api/application-batch).');if(scenario==='guard-blocked')throw Error('An application is still running');return {};}
    if(afterPost&&scenario==='verification-unavailable')throw Error('Request failed (HTTP 503, GET /api/saved-search-queue).');
    return {mode:applied?'saved-search':'legacy',batch_enabled:!applied,applicant_id:applied?'p':null,paused:true,active_structured_search:true,blocker:afterPost&&scenario==='guard-blocked'?{title:'Platform Engineer',company:'Fixture',reason:'Application preparation is running'}:null};};
   w.eval(source.slice(source.indexOf('function renderBatchControl('),source.indexOf('function automaticSubmissionEnabled')));w.renderBatchControl({enabled:true,selected:20,completed:11});await new Promise(r=>setTimeout(r,0));
   const button=[...w.document.querySelectorAll('button')].find(x=>x.textContent==='Use saved search queue');assert.equal(button.disabled,false);await button.onclick();const notice=w.document.querySelector('#notice').textContent;
   if(scenario==='refresh-failed'){assert.match(notice,/queue is active/);assert.match(notice,/Dashboard refresh failed.*503.*GET/);}
   if(scenario==='lost-response-applied'){assert.match(notice,/queue is active/);assert(!notice.includes('transition failed'));}
   if(scenario==='guard-blocked'){assert.match(notice,/Queue transition failed/);assert.match(notice,/Platform Engineer at Fixture/);assert.equal(button.disabled,false);}
   if(scenario==='verification-unavailable'){assert.match(notice,/Could not verify whether the queue changed/);assert.equal(button.disabled,true);await button.onclick();assert.equal(posts,1);const check=[...w.document.querySelectorAll('button')].find(x=>x.textContent==='Check saved queue status');await check.onclick();assert.equal(posts,1);w.renderBatchControl({enabled:true,selected:20,completed:11});await new Promise(r=>setTimeout(r,0));assert.equal(w.document.querySelector('#notice').textContent,notice);assert.equal([...w.document.querySelectorAll('button')].find(x=>x.textContent==='Use saved search queue').disabled,true);}
   assert.equal(posts,1);dom.window.close();
  }
 });
 test(client+' reports status and operation for generic/non-JSON HTTP errors without echoing response bodies',async()=>{
  const dom=new JSDOM('',{url:'https://example.test/',runScripts:'outside-only'}),w=dom.window;
  const start=source.indexOf("async function api(path,method='GET',data){"),end=source.indexOf('\n}',start)+2;w.eval("let token='private-token';"+source.slice(start,end));
  w.fetch=async()=>({status:502,ok:false,json:async()=>({message:'proxy debug private-token'})});await assert.rejects(w.api('/application-batch','POST',{action:'saved-search'}),e=>e.status===502&&e.message==='Request failed (HTTP 502, POST /api/application-batch).');
  w.fetch=async()=>({status:503,ok:false,json:async()=>{throw Error('<html>private-token</html>')}});await assert.rejects(w.api('/saved-search-queue?applicant_id=private-id'),e=>e.message==='Invalid server response (HTTP 503, GET /api/saved-search-queue).');dom.window.close();
 });
}
