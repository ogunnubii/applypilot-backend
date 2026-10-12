const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {JSDOM}=require('jsdom');
const root=join(__dirname,'..');

function fixture(client){
 const dom=new JSDOM(readFileSync(join(root,client==='assistant-client.js'?'assistant-page.html':'web/progress.html'),'utf8'),{url:'https://example.test/assistant?view=settings',runScripts:'outside-only'}),w=dom.window;
 w.setInterval=()=>0;
 const job=(id,extra={})=>({id,title:'Senior DevOps Engineer',company:id==='member'?'Chromatic':'Synthetic '+id,url:'https://jobs.lever.co/fixture/'+id,status:'needs_review',challenge:'Manual review',required_fields_json:'[]',execution_mode:'cloud',metadata:{manualReview:true},...extra});
 const state={jobs:[job('member',{automatic_member:true}),job('outside',{automatic_member:false}),job('old-member',{automatic_member:true}),job('retained',{automatic_member:true,handoff_available:1})],automatic:{id:'campaign',enabled:true,current_batch:3,selected:1,settled:0,totals:{},members:[{job_id:'member',batch_number:3,outcome:'pending'}]},preparation:{}};
 const calls=[];
 w.fetch=async(url,options={})=>{const route=new URL(String(url),w.location.origin).pathname.replace('/api','');calls.push({route,method:options.method||'GET'});const data=route==='/jobs'?state:route==='/status'?{workerOnline:true}:route==='/application-history'?{records:[]}:route==='/operations'?{totals:{},applications:[]}:route==='/activity'?{events:[]}:route==='/continuations'?{requests:[]}:route==='/pipeline'?{enabled:false}:route==='/employer-limits'?{limits:[]}:route==='/searches'?{searches:[]}:route==='/ai-status'?{profiles:[],attempts:[]}:{};return {ok:true,json:async()=>data};};
 w.eval(readFileSync(join(root,'extension/policy.js'),'utf8'));w.eval(readFileSync(join(root,client),'utf8'));
 return {w,state,calls,close:()=>w.close()};
}

for(const client of ['assistant-client.js','web/progress.js'])test(client+' shows hosted ownership and batch restrictions without offering local takeover',async()=>{
 const f=fixture(client);try{
  await f.w.refresh(true);const d=f.w.document;
  for(const id of ['member','outside','old-member','retained'])assert.equal(d.querySelector('#job-'+id+' .manual-autofill'),null,'forbidden local autofill must not be offered: '+id);
  assert.match(d.querySelector('#job-member .local-autofill-unavailable').textContent,/hosted worker/);
  assert.match(d.querySelector('#job-old-member .local-autofill-unavailable').textContent,/hosted worker/,'membership is not limited to the last 40 snapshot entries');
  assert.match(d.querySelector('#job-outside .local-autofill-unavailable').textContent,/outside the current automatic batch/);
  assert([...d.querySelectorAll('#job-retained button')].some(b=>b.textContent==='Take over filled application'),'existing hosted handoff stays accessible');
  assert.equal(d.querySelector('#job-member').dataset.confirmed,'false');
  assert.equal(f.calls.filter(c=>c.method!=='GET').length,0,'rendering must not change campaigns, claim jobs, report completion or submit');
  f.state.automatic.enabled=false;await f.w.refresh();
  assert.match(d.querySelector('#job-outside .local-autofill-unavailable').textContent,/stopped/,'campaign-only changes refresh the job controls');
  assert.equal(d.querySelector('#job-member .manual-autofill'),null,'stopping a campaign does not release its members');
  f.state.preparation={id:'prep',enabled:true,members:[{job_id:'outside',position:1}]};await f.w.refresh(true);
  assert(d.querySelector('#job-outside .manual-autofill'),'explicit separate preparation campaign still allows its nonmember');
  assert.equal(d.querySelector('#job-member .manual-autofill'),null,'manual preparation does not override hosted membership');
  f.state.automatic={};f.state.preparation={};await f.w.refresh(true);
  assert(d.querySelector('#job-outside .manual-autofill'),'ordinary manual autofill remains available');
  assert.equal(f.calls.filter(c=>c.method!=='GET').length,0);
 }finally{f.close();}
});
