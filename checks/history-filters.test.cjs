const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const root=path.join(__dirname,'..');

function fixture(client,{settings=true,focus={enabled:true,auto_submit:false,job_id:'openai'},batch=null}={}){
 const dom=new JSDOM(readFileSync(path.join(root,client==='assistant-client.js'?'assistant-page.html':'web/progress.html'),'utf8'),{url:'https://example.test/assistant'+(settings?'?view=settings':''),runScripts:'outside-only'}),w=dom.window;
 w.setInterval=()=>0;
 w.HTMLElement.prototype.scrollIntoView=()=>{};
 const job=(id,status,extra={})=>({id,status,title:'Platform Engineer '+id,company:id==='openai'?'OpenAI':'Employer '+id,url:'https://jobs.lever.co/example/'+id,execution_mode:'cloud',required_fields_json:'[]',...extra});
 const state={focus,batch,jobs:[
  job('openai','paused',{challenge:'Missing answers',required_fields_json:'["Notice period?"]',attempts:1}),
  job('receipt','submitted',{confirmation:'Thank you for applying',attempts:1,local_attempt_at:'2026-10-10T12:00:00Z'}),
  job('interview','interview',{confirmation:'Thank you for applying'}),
  job('uncertain','local_browser',{execution_mode:'cloud',local_phase:'blocked',local_attempt_at:'2026-10-10T13:00:00Z',challenge:'Unconfirmed submission'}),
  job('blocked','needs_review',{challenge:'Missing answers',required_fields_json:'["Start date?"]'}),
  job('queued','queued'),job('duplicate','duplicate')
 ],records:[{id:'external',company:'External employer',title:'SRE',status:'interview',source:'Imported'}]};
 const evidence=[{id:'openai',blocked:true,worked:true},{id:'receipt',confirmed:true,worked:true,completion:'automatic'},{id:'interview',confirmed:true,worked:true,completion:'assisted'},{id:'uncertain',awaiting:true,worked:true},{id:'blocked',blocked:true},{id:'queued',active:true}];
 const calls=[];
 w.fetch=async(url,options={})=>{
  const route=new URL(String(url),w.location.origin).pathname.replace('/api',''),method=options.method||'GET';
  calls.push({route,method});
  assert.equal(method,'GET','browsing history must not mutate applications or authorization');
  const data=route==='/jobs'?{jobs:state.jobs,focus:state.focus,batch:state.batch}:route==='/status'?{workerOnline:true}:route==='/application-history'?{records:state.records}:route==='/operations'?{checkedAt:'2026-10-11T12:00:00Z',totals:{confirmed:2,worked:4,awaiting:1},applications:evidence}:route==='/activity'?{events:[{job_id:'receipt',company:'Employer receipt',title:'Platform Engineer receipt',at:'2026-10-10T12:00:00Z',message:'Employer receipt recorded'}]}:route==='/continuations'?{requests:[]}:route==='/pipeline'?{enabled:false,found:0}:route==='/employer-limits'?{limits:[]}:route==='/searches'?{searches:[]}:route==='/ai-status'?{profiles:[],attempts:[]}:{};
  return {ok:true,json:async()=>structuredClone(data)};
 };
 w.eval(readFileSync(path.join(root,'extension/policy.js'),'utf8'));
 w.eval(readFileSync(path.join(root,client),'utf8'));
 const visible=()=>[...w.document.querySelector('#jobs').children].filter(card=>!card.hidden&&w.getComputedStyle(card).display!=='none').map(card=>card.id).sort();
 const filter=name=>w.document.querySelector('[data-filter="'+name+'"]').click();
 const search=value=>{const input=w.document.querySelector('#job-search');input.value=value;input.dispatchEvent(new w.Event('input'));};
 const metric=label=>[...w.document.querySelectorAll('#operations>.operation-metrics button')].find(button=>button.querySelector('span').textContent===label).click();
 return {w,state,calls,visible,filter,search,metric,close:()=>w.close()};
}

for(const client of ['assistant-client.js','web/progress.js']){
 for(const [mode,options] of Object.entries({focus:{},batch:{focus:{},batch:{enabled:true,selected:2,completed:1,job_ids:['openai','receipt']}},unscoped:{focus:{}}})){
  test(client+' '+mode+' history honors All records, search, receipt and completion filters across refreshes',async()=>{
   const f=fixture(client,options),before=JSON.stringify(f.state);
   try{
    await f.w.refresh(true);
    f.filter('all');
    assert.deepEqual(f.visible(),['external-external','job-blocked','job-interview','job-openai','job-queued','job-receipt','job-uncertain']);
    assert.equal(f.w.document.querySelector('#application-list-title').textContent,'All application records');
    assert.equal(f.w.document.querySelector('#visible-job-count').textContent,'7 shown');
    assert.equal(f.w.document.querySelector('#job-duplicate'),null);
    f.search('  EMPLOYER RECEIPT  ');assert.deepEqual(f.visible(),['job-receipt']);
    await f.w.refresh();assert.deepEqual(f.visible(),['job-receipt'],'unchanged polling preserves the selected filter and search');
    await f.w.refresh(true);assert.deepEqual(f.visible(),['job-receipt'],'manual refresh preserves the selected filter and search');
    f.search('no matching company');assert.deepEqual(f.visible(),[]);
    assert.equal(f.w.document.querySelector('#empty-state').hidden,false);
    assert.equal(f.w.document.querySelector('#visible-job-count').textContent,'0 shown');
    f.search('');f.metric('Receipts recorded');
    assert.deepEqual(f.visible(),['job-interview','job-receipt']);
    assert.equal(f.w.document.querySelector('#application-list-title').textContent,'Employer-confirmed submissions');
    f.metric('Receipts recorded');assert.deepEqual(f.visible(),['job-interview','job-receipt'],'repeated drilldown is read-only and stable');
    f.search('interview');assert.deepEqual(f.visible(),['job-interview'],'search also applies to receipt drilldowns');
    f.search('');f.w.document.querySelector('#completion-breakdown button[data-completion=automatic]').click();
    assert.deepEqual(f.visible(),['job-receipt']);
    f.w.document.querySelector('#completion-breakdown button[data-completion=assisted]').click();
    assert.deepEqual(f.visible(),['job-interview']);
    f.metric('Awaiting receipt');assert.deepEqual(f.visible(),['job-uncertain']);
    f.filter('interview');assert.deepEqual(f.visible(),['external-external','job-interview']);
    assert.equal(f.w.document.querySelector('#submitted-count').textContent,'1');
    assert.equal(f.w.document.querySelector('#interview-count').textContent,'2');
    assert.equal(JSON.stringify(f.state),before,'paused focus, attempts and API records must remain unchanged');
    assert(f.calls.every(call=>call.method==='GET'));
   }finally{f.close();}
  });
 }
 test(client+' settings pending filter is not overridden by focus or batch',async()=>{
  const f=fixture(client,{batch:{enabled:true,selected:1,job_ids:['openai']}});
  try{
   await f.w.refresh(true);assert.deepEqual(f.visible(),['job-blocked','job-openai','job-queued']);
   f.search('blocked');assert.deepEqual(f.visible(),['job-blocked']);
   f.filter('all');f.search('');f.filter('pending');assert.deepEqual(f.visible(),['job-blocked','job-openai','job-queued']);
  }finally{f.close();}
 });
 test(client+' history polling follows new returned records without resetting the filter or widening working controls',async()=>{
  const f=fixture(client);
  try{
   await f.w.refresh(true);
   assert.match(f.w.document.querySelector('#missing-answers').textContent,/Notice period/);
   assert.doesNotMatch(f.w.document.querySelector('#missing-answers').textContent,/Start date/,'history rendering must not expand automatic answer-saving scope');
   assert.deepEqual(Array.from(f.w.document.querySelector('#application-archive-control').archiveCandidates,j=>j.id),['openai']);
   f.filter('all');f.search('receipt');
   f.state.jobs.push({...f.state.jobs.find(j=>j.id==='receipt'),id:'receipt-new',title:'New receipt role'});
   await f.w.refresh();assert.deepEqual(f.visible(),['job-receipt','job-receipt-new']);
   assert.equal(f.w.document.querySelector('[data-filter=all]').getAttribute('aria-pressed'),'true');
   assert.equal(f.w.document.querySelector('#job-search').value,'receipt');
   f.search('');f.metric('Receipts recorded');
   f.state.focus.job_id='blocked';await f.w.refresh();
   assert.deepEqual(f.visible(),['job-interview','job-receipt'],'server-side focus changes must not override receipt history');
   assert.equal(f.w.document.querySelector('#application-list-title').textContent,'Employer-confirmed submissions');
   assert(f.calls.every(call=>call.method==='GET'));
  }finally{f.close();}
 });
 test(client+' default focus keeps the selected job and skip-blocked flow while explicit filters can inspect history',async()=>{
  const f=fixture(client,{settings:false});
  try{
   await f.w.refresh(true);assert.deepEqual(f.visible(),['job-openai']);
   assert.equal(f.w.document.querySelector('#application-list-title').textContent,'Current application');
   f.state.focus.skip_blocked=true;await f.w.refresh();
   assert.deepEqual(f.visible(),['job-blocked','job-openai']);
   f.filter('all');assert(f.visible().includes('job-receipt'));
   f.metric('Receipts recorded');assert.deepEqual(f.visible(),['job-interview','job-receipt']);
   f.filter('pending');assert.deepEqual(f.visible(),['job-blocked','job-openai']);
   f.state.focus.skip_blocked=false;f.state.focus.search_queue_only=true;await f.w.refresh();
   assert.deepEqual(f.visible(),['job-interview','job-openai','job-receipt','job-uncertain'],'saved-search focus retains receipt and uncertain-attempt visibility');
   f.search('blocked');assert.deepEqual(f.visible(),['job-blocked'],'explicit search is not pinned to the focused job');
  }finally{f.close();}
 });
 test(client+' default batch stays scoped while explicit filters and search inspect other returned records',async()=>{
  const f=fixture(client,{settings:false,focus:{},batch:{enabled:true,selected:2,job_ids:['openai','receipt']}});
  try{
   await f.w.refresh(true);assert.deepEqual(f.visible(),['job-openai']);
   assert.equal(f.w.document.querySelector('#application-list-title').textContent,'Current batch - up to 20 jobs');
   f.filter('all');assert(f.visible().includes('job-receipt'));
   f.metric('Receipts recorded');assert.deepEqual(f.visible(),['job-interview','job-receipt']);
   f.filter('pending');assert.deepEqual(f.visible(),['job-openai']);
   f.search('blocked');assert.deepEqual(f.visible(),['job-blocked']);
  }finally{f.close();}
 });
 test(client+' unscoped focus view displays historical drilldowns instead of hiding them with attention-only CSS',async()=>{
  const f=fixture(client,{settings:false,focus:{}});
  try{
   await f.w.refresh(true);assert.deepEqual(f.visible(),['job-blocked','job-openai']);
   f.metric('Receipts recorded');assert.deepEqual(f.visible(),['job-interview','job-receipt']);
   f.filter('pending');assert.deepEqual(f.visible(),['job-blocked','job-openai']);
  }finally{f.close();}
 });
 test(client+' history activity and completion links target retained records without changing the selected application',async()=>{
  const f=fixture(client);
  try{
   await f.w.refresh(true);
   const completion=f.w.document.querySelector('#completion-breakdown a[href="#job-receipt"]');
   assert(completion,'completion breakdown retains nonfocused receipt links');
   completion.click();assert(f.visible().includes('job-receipt'));
   f.filter('pending');f.w.document.querySelector('.activity-row').click();assert(f.visible().includes('job-receipt'));
   assert.equal(f.state.focus.job_id,'openai');assert.equal(f.state.focus.auto_submit,false);
  }finally{f.close();}
 });
 test(client+' an opened history deep link does not override a later filter during polling',async()=>{
  const f=fixture(client);
  try{
   f.w.location.hash='#job-receipt';await f.w.refresh(true);
   assert(f.visible().includes('job-receipt'),'initial deep link reveals its record');
   f.filter('interview');assert.deepEqual(f.visible(),['external-external','job-interview']);
   f.state.jobs.find(j=>j.id==='openai').updated_at='2026-10-11T12:01:00Z';
   for(const details of f.w.document.querySelectorAll('#jobs details'))details.open=false;
   await f.w.refresh();assert.deepEqual(f.visible(),['external-external','job-interview'],'a stale hash must not reopen a record excluded by the selected history filter');
   f.search('no matching company');await f.w.refresh(true);assert.deepEqual(f.visible(),[]);
  }finally{f.close();}
 });
}
