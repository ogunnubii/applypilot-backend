const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {JSDOM}=require('jsdom');
const path=require('node:path');
const root=path.join(__dirname,'..');

function fixture(client='assistant-client.js',{url='https://example.test/assistant',focus={},batch={},jobs=[],workerOnline=true}={}){
 const page=client==='assistant-client.js'?'assistant-page.html':'web/progress.html';
 const dom=new JSDOM(readFileSync(path.join(root,page),'utf8'),{url,runScripts:'outside-only'}),w=dom.window;
 w.setInterval=()=>0;const calls=[];let failing=false;
 const state={focus,batch,jobs};
 w.fetch=async(url,options={})=>{
  const route=new URL(String(url),w.location.origin).pathname.replace('/api',''),method=options.method||'GET',input=options.body?JSON.parse(options.body):undefined;
  calls.push({route,method,input});
  if(route==='/work-focus'&&method==='PUT'){
   if(failing)return {ok:false,status:503,json:async()=>({error:'Try later'})};
   state.focus={...state.focus,...input,job_id:state.focus.job_id||state.jobs[0]?.id||null};
   return {ok:true,json:async()=>state.focus};
  }
  const data=route==='/jobs'?{jobs:state.jobs,focus:state.focus,batch:state.batch}:route==='/status'?{workerOnline}:route==='/application-history'?{records:[]}:route==='/operations'?{totals:{confirmed:0,worked:1},applications:[]}:route==='/activity'?{events:[]}:route==='/continuations'?{requests:[]}:route==='/pipeline'?{enabled:false,found:0}:route==='/employer-limits'?{limits:[]}:route==='/searches'?{searches:[]}:route==='/ai-status'?{profiles:[],attempts:[]}:{};
  return {ok:true,json:async()=>data};
 };
 w.eval(readFileSync(path.join(root,'extension/policy.js'),'utf8'));
 w.eval(readFileSync(path.join(root,client),'utf8'));
 return {w,state,calls,fail:()=>{failing=true},close:()=>w.close()};
}
const job=(id,status='queued',extra={})=>({id,title:'Platform Engineer '+id,company:'Example '+id,status,url:'https://jobs.lever.co/example/'+id,required_fields_json:'[]',execution_mode:'cloud',...extra});

for(const client of ['assistant-client.js','web/progress.js']){
 test(client+' exposes explicit autonomy in a batch and pauses after a focused repeated click',async()=>{
  const f=fixture(client,{batch:{enabled:true,selected:1,completed:0,job_ids:['a'],minimum_cad:120000},jobs:[job('a')]});
  try{
   await f.w.refresh(true);const d=f.w.document;
   assert(d.querySelector('#work-focus').textContent.includes('send your saved profile'));
   assert(d.querySelector('#work-focus').textContent.includes('current batch'));
   const skip=d.querySelector('#autonomy-skip-blocked');assert.equal(skip.checked,false);skip.checked=true;skip.dispatchEvent(new f.w.Event('change'));
   let action=d.querySelector('#autonomy-toggle');action.focus();
   const start=action.onclick();await action.onclick();await start;
   assert.equal(f.calls.filter(c=>c.route==='/work-focus').length,1,'repeated clicks must not send duplicate authorization');
   assert.deepEqual(f.calls.find(c=>c.route==='/work-focus').input,{enabled:true,auto_submit:true,skip_blocked:true});
   action=d.querySelector('#autonomy-toggle');assert.equal(action.textContent,'Pause automatic submission');
   assert.equal(d.activeElement,action,'keep keyboard focus on the updated control');
   await action.onclick();
   assert.equal(f.calls.filter(c=>c.route==='/work-focus')[1].input.auto_submit,false);
   assert.equal(d.querySelector('#autonomy-toggle').textContent,'Enable automatic submission');
  }finally{f.close();}
 });
 test(client+' keeps blocked forms visible while the next selected form runs, but never calls either submitted',async()=>{
  const f=fixture(client,{focus:{enabled:true,auto_submit:true,skip_blocked:true,job_id:'b',parked:1,progress:{required:5,filled:5,percent:100}},batch:{enabled:true,selected:2,completed:0,job_ids:['a','b'],minimum_cad:120000},jobs:[job('a','needs_review',{challenge:'Missing answers',required_fields_json:'["Notice period?"]'}),job('b','running')]});
  try{
   await f.w.refresh(true);const d=f.w.document;
   assert.equal(d.querySelector('#job-a').hidden,false);assert.equal(d.querySelector('#job-b').hidden,false);
   assert(d.querySelector('#work-focus').textContent.includes('100% of current-step required fields filled'));
   assert(d.querySelector('#work-focus').textContent.includes('A filled form is not yet a confirmed submission'));
   assert.equal(d.querySelector('[data-home-filter=receipt] strong').textContent,'0');
   assert(d.querySelector('#job-b .job-next-step').textContent.includes('automatic submission'));
  }finally{f.close();}
 });
 test(client+' leaves uncertain attempts visible, with a receipt warning and the correct local browser requirement',async()=>{
  const f=fixture(client,{focus:{enabled:true,auto_submit:true,skip_blocked:true,job_id:'a',awaiting:true},jobs:[job('a','local_browser',{execution_mode:'local',local_phase:'blocked',local_attempt_at:'now',challenge:'Unconfirmed submission',last_message:'No receipt detected'})]});
  try{
   await f.w.refresh(true);const d=f.w.document;
   assert.equal(d.querySelector('#job-a').hidden,false);assert.match(d.querySelector('#job-a .badge').textContent,/Awaiting employer receipt/);
   assert.match(d.querySelector('#autonomy-state').textContent,/Do not resubmit/);
   assert.match(d.querySelector('#work-focus').textContent,/work stops when your PC is off/);
   assert.doesNotMatch(d.querySelector('#work-focus').textContent,/your PC can be off/);
  }finally{f.close();}
 });
 test(client+' does not claim authorization succeeded when the server rejects it',async()=>{
  const f=fixture(client,{jobs:[job('a')]});
  try{
   await f.w.refresh(true);f.fail();await f.w.document.querySelector('#autonomy-toggle').onclick();
   assert.match(f.w.document.querySelector('#notice').textContent,/could not be verified/);
   assert.equal(f.w.document.querySelector('#autonomy-toggle').disabled,true);
   assert.equal(f.state.focus.auto_submit,undefined);
  }finally{f.close();}
 });
 test(client+' shows hosted worker downtime and refreshes manual/autonomous explanation without job changes',async()=>{
  const f=fixture(client,{focus:{enabled:true,auto_submit:false,job_id:'a'},jobs:[job('a','running')],workerOnline:false});
  try{
   await f.w.refresh(true);assert.match(f.w.document.querySelector('.submit-policy').textContent,/You review it/);
   f.state.focus.auto_submit=true;await f.w.refresh();
   assert.match(f.w.document.querySelector('.submit-policy').textContent,/Automatic submission is enabled/);
   assert.match(f.w.document.querySelector('#work-focus').textContent,/Hosted worker is offline/);
   assert.match(f.w.document.querySelector('#job-a .job-next-step').textContent,/automatic submission/);
  }finally{f.close();}
 });
}
