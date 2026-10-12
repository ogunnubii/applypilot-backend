import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
for(const file of ['assistant-client.js','web/progress.js'])test(file+' renders automatic evidence separately and Stop sends explicit revocation',async()=>{
 const dom=new JSDOM(readFileSync('assistant-page.html','utf8'),{url:'https://example.test/assistant?view=settings',runScripts:'outside-only'}),w=dom.window;w.setInterval=()=>0;
 const jobs=[{id:'chosen',company:'Example',title:'Platform Engineer',status:'running',required_fields_json:'[]',url:'https://jobs.lever.co/example/chosen'}];
 const campaign={id:'c',applicant_id:'p',enabled:true,current_batch:2,selected:20,settled:0,totals:{prepared:17,attempted:18,confirmed:17,automatic:17,assisted:0,blocked:1,deferred:1,unresolved:1},members:[{job_id:'chosen',company:'Example',title:'Platform Engineer',url:jobs[0].url,batch_number:2,outcome:'pending'}]},calls=[];
 w.fetch=async(url,options={})=>{calls.push([url,options]);const data=String(url).endsWith('/jobs')?{jobs,automatic:campaign}:String(url).endsWith('/status')?{workerOnline:true}:String(url).endsWith('/application-history')?{records:[]}:String(url).endsWith('/operations')?{totals:{confirmed:17},applications:[]}:String(url).endsWith('/continuations')?{requests:[]}:String(url).endsWith('/searches')?{searches:[]}:String(url).endsWith('/activity')?{events:[]}:String(url).endsWith('/employer-limits')?{limits:[]}:{};if(String(url).endsWith('/automatic-campaign')&&options.method==='PUT')campaign.enabled=false;return {ok:true,json:async()=>data};};
 w.eval(readFileSync('extension/policy.js','utf8'));w.eval(readFileSync(file,'utf8'));await w.refresh(true);
 const panel=w.document.querySelector('#automatic-campaign');assert.equal(panel.hidden,false);assert.match(panel.textContent,/Batch 2/);assert.match(panel.textContent,/17 Employer-confirmed/);assert.match(panel.textContent,/18 Attempted/);assert.match(w.document.querySelector('.submit-policy').textContent,/Automatic submission is enabled/);
 assert.equal(w.document.querySelector('#work-focus').hidden,true);
 const stop=[...panel.querySelectorAll('button')].find(b=>b.textContent==='Stop automatic applications');assert(stop);await stop.onclick();
 const revoke=calls.find(([url,o])=>String(url).endsWith('/automatic-campaign')&&o.method==='PUT');assert.deepEqual(JSON.parse(revoke[1].body),{enabled:false});assert.match(panel.textContent,/Stopped/);assert.match(panel.textContent,/Resume automatic batches of 20/);assert.match(w.document.querySelector('.submit-policy').textContent,/You review/);w.close();
});
