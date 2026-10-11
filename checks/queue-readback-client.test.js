import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
for(const client of ['assistant-client.js','web/progress.js'])test(client+' distinguishes preparation from submission authorization',async()=>{
 const source=readFileSync(new URL('../'+client,import.meta.url),'utf8');
 for(const [flags,expected] of [
  [{paused:true,focus_enabled:false,auto_submit:false},'Automation is paused.'],
  [{paused:false,focus_enabled:true,auto_submit:false},'Preparation is enabled. Automatic submission is off; you review and submit.'],
  [{paused:false,focus_enabled:true,auto_submit:true},'Preparation and automatic submission are enabled.'],
  [{paused:false},'Automatic submission status is unavailable; check the Application automation control.']
 ]){
  const dom=new JSDOM('<div id="home-summary"></div><p id="notice"></p>',{url:'https://example.test/?view=settings',runScripts:'outside-only'}),w=dom.window;
  w.$=s=>w.document.querySelector(s);w.el=(tag,text)=>{const e=w.document.createElement(tag);if(text)e.textContent=text;return e;};w.field=form=>{const e=w.document.createElement('input');form.append(e);return e;};
  w.api=async(path,method)=>{assert.equal(method,undefined,'readback must not change authorization');return path==='/applicants'?{applicants:[{id:'p',name:'Fixture'}]}:{mode:'saved-search',batch_enabled:false,applicant_id:'p',active_structured_search:true,...flags};};
  w.eval(source.slice(source.indexOf('function renderBatchControl('),source.indexOf('function automaticSubmissionEnabled')));w.renderBatchControl({enabled:false});await new Promise(r=>setTimeout(r,0));
  assert.equal(w.document.querySelector('#application-batch [role=status]').textContent,'Saved search queue is active. '+expected);dom.window.close();
 }
});
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
for(const client of ['assistant-client.js','web/progress.js'])test(client+' renders blocker evidence directly with UTC labels and missing details, without HTML and with unavailable quarantine disabled',async()=>{
 const source=readFileSync(new URL('../'+client,import.meta.url),'utf8'),dom=new JSDOM('<div id="home-summary"></div><p id="notice"></p>',{url:'https://example.test/?view=settings',runScripts:'outside-only'}),w=dom.window;
 w.$=s=>w.document.querySelector(s);w.el=(tag,text)=>{const e=w.document.createElement(tag);if(text)e.textContent=text;return e;};w.field=form=>{const e=w.document.createElement('input');form.append(e);return e;};w.refresh=async()=>{};
 w.api=async path=>path==='/applicants'?{applicants:[{id:'p',name:'Fixture'}]}:{mode:'legacy',batch_enabled:true,applicant_id:null,paused:true,active_structured_search:true,blocker:{id:'outside-batch',title:'Engineer <img src=x>',company:'Fixture',reason:'Submission is in progress',status:'local_browser',phase:'verifying',updated_at:'2026-10-11T04:00:00.000Z',attempt_at:null,worker_claim_at:null,profile_execution_mode:'cloud',recorded_execution_source:'local-browser',recent_events:[{type:'manual_submission',at:'2026-10-11T03:59:00.000Z'}]}};
 w.eval(source.slice(source.indexOf('function renderBatchControl('),source.indexOf('function automaticSubmissionEnabled')));w.renderBatchControl({enabled:true,selected:20,completed:11,job_ids:['some-other-job']});await new Promise(r=>setTimeout(r,0));
 const panel=w.document.querySelector('[aria-label="Blocking application details"]');assert(panel&&!panel.hidden);assert.match(panel.textContent,/Engineer <img src=x>/);assert.equal(panel.querySelector('img'),null);assert.match(panel.textContent,/Status: local_browser/);assert.match(panel.textContent,/Execution phase: verifying/);assert.match(panel.textContent,/Current profile execution mode: Hosted worker/);assert.match(panel.textContent,/Recorded execution source: Local browser record/);assert.match(panel.textContent,/2026-10-11 04:00:00.000 UTC/);assert.match(panel.textContent,/Submission attempt recorded: Details unavailable/);assert.match(panel.textContent,/not proof.*stopped/);assert.match(panel.textContent,/not a live heartbeat/);assert.match(panel.textContent,/manual_submission/);assert.equal(panel.querySelectorAll('button').length,1);assert.equal(panel.querySelector('button').disabled,true);assert.equal(panel.querySelectorAll('a,input').length,0);dom.window.close();
});
for(const client of ['assistant-client.js','web/progress.js'])test(client+' explicitly quarantines exact evidence once and verifies uncertain responses without retrying',async()=>{
 for(const outcome of ['success','lost-response','unavailable','late-receipt','denied']){
  const source=readFileSync(new URL('../'+client,import.meta.url),'utf8'),dom=new JSDOM('<div id="home-summary"></div><p id="notice"></p>',{url:'https://example.test/?view=settings',runScripts:'outside-only'}),w=dom.window;let posts=0,reads=0,done=false;
  w.$=s=>w.document.querySelector(s);w.el=(tag,text)=>{const e=w.document.createElement(tag);if(text)e.textContent=text;return e;};w.field=form=>{const e=w.document.createElement('input');form.append(e);return e;};w.refresh=async()=>{};
  w.api=async(path,method,data)=>{
   if(path==='/applicants')return {applicants:[{id:'p',name:'Fixture'}]};
   if(path==='/jobs/j/park-unresolved'){
    if(method==='POST'){posts++;assert.equal(data.evidence,'snapshot');await new Promise(r=>setTimeout(r,0));done=true;if(outcome!=='success')throw Error('HTTP 502');return {message:'Receipt remains unresolved. Automation is paused.'};}
    reads++;if(outcome==='unavailable')throw Error('HTTP 503');return {parked:outcome==='lost-response',quarantined:outcome==='lost-response',receipt_confirmed:outcome==='late-receipt'};
   }
   return {mode:'legacy',batch_enabled:true,paused:true,active_structured_search:true,blocker:done?null:{id:'j',title:'Engineer',company:'Fixture',unresolved_action:{eligible:outcome!=='denied',reason:outcome==='denied'?'A browser continuation is still dispatching.':'Eligible',evidence:'snapshot'}}};
  };
  w.eval(source.slice(source.indexOf('function renderBatchControl('),source.indexOf('function automaticSubmissionEnabled')));w.renderBatchControl({enabled:true});await new Promise(r=>setTimeout(r,0));
  const button=[...w.document.querySelectorAll('button')].find(x=>x.textContent==='Keep receipt unresolved and continue');
  if(outcome==='denied'){assert(button.disabled);assert.match(w.document.body.textContent,/continuation is still dispatching/);await button.onclick();assert.equal(posts,0);}else{
   const first=button.onclick();await button.onclick();await first;assert.equal(posts,1);assert.equal(reads,outcome==='success'?0:1);
   const notice=w.document.querySelector('#notice').textContent;
   assert.match(notice,outcome==='unavailable'?/Could not verify.*Do not repeat/:outcome==='late-receipt'?/receipt is now confirmed/:/Receipt remains unresolved/);
  }
  dom.window.close();
 }
});
