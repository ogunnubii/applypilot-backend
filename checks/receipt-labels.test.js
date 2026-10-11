import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

for(const client of ['assistant-client.js','web/progress.js'])test(client+' never advertises completed or attempted manual-review jobs as ready to apply again',async()=>{
 const dom=new JSDOM(readFileSync('assistant-page.html','utf8'),{url:'https://example.test/?view=settings',runScripts:'outside-only'}),w=dom.window;
 w.setInterval=()=>0;
 const jobs=[['pending','submitted'],['confirmed','submitted'],['interview','interview'],['rejected','rejected'],['offer','offer'],['fresh','needs_review']].map(([id,status])=>({id,status,title:'Cloud Engineer',company:id,url:'https://www.iitjobs.com/job/cloud-engineer-123',metadata:{manualReview:true},required_fields_json:'[]',local_attempt_at:id==='pending'?'2026-10-07T06:30:00Z':null}));
 const applications=jobs.map(j=>({id:j.id,confirmed:j.id==='confirmed',awaiting:j.id==='pending'}));
 w.fetch=async url=>({ok:true,json:async()=>{
  const path=new URL(url,'https://example.test').pathname;
  return path==='/api/jobs'?{jobs}:path==='/api/operations'?{applications,totals:{}}:path==='/api/application-history'?{records:[]}:path==='/api/continuations'?{requests:[]}:path==='/api/searches'?{searches:[]}:path==='/api/ai-status'?{profiles:[],attempts:[]}:path==='/api/activity'?{events:[]}:path==='/api/employer-limits'?{limits:[]}:{};
 }});
 try{
  w.eval(readFileSync('extension/policy.js','utf8'));w.eval(readFileSync(client,'utf8'));await w.refresh(true);
  const label=id=>w.document.querySelector('#job-'+id+' .badge').textContent;
  assert.equal(label('pending'),'Awaiting employer receipt');assert.equal(label('confirmed'),'Receipt recorded');
  const interview=w.document.querySelector('#job-interview');assert(interview);assert(!/Ready for autofill|Review & apply/.test(interview.textContent));assert.equal(label('rejected'),'Rejected');assert.equal(label('offer'),'Offer');
  assert.equal(label('fresh'),'Ready for autofill');
 }finally{w.close();}
});
