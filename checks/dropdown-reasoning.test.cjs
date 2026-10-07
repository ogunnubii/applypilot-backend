const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
test('hosted and local dropdown drafts preserve records and stop on changed state',async()=>{
 const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE applicants(id TEXT,user_id TEXT,consent INTEGER,gemini_facts_consent INTEGER,ai_consent INTEGER,google_research_consent INTEGER);CREATE TABLE jobs(id TEXT,user_id TEXT,applicant_id TEXT,status TEXT,local_owner TEXT,local_attempt_at TEXT,handoff_available INTEGER,url TEXT,answers_json TEXT,updated_at TEXT);CREATE TABLE events(job_id TEXT,type TEXT);INSERT INTO applicants VALUES('p','u',1,1,0,1);INSERT INTO jobs VALUES('j','u','p','running','device',NULL,0,'https://example.test/job','{}','now');");
 const clean=f=>read(f).replace(/^import .+;\s*$/gm,'').replace(/\bexport\s+(?=(?:async\s+)?function|const)/g,'');
 const {hostedOptionChoice,protectedHostedQuestion}=await import('../hosted-form.js');
 const hosted=new Function('canDraftProfessional','draftForJob','hostedOptionChoice','protectedHostedQuestion','researchConsentWithdrawn',clean('dropdown-answer.js')+';return prepareHostedDropdown;')(()=>true,()=>{},hostedOptionChoice,protectedHostedQuestion,()=>false);
 const local=new Function('canResearchQuestion','researchForJob','markResearchDraftUsed','canDraftProfessional','draftForJob','researchConsentWithdrawn',clean('form-answer.js')+';return prepareFormAnswer;')(()=>false,()=>{},()=>{},()=>true,()=>{},()=>false);
 const q='How many years of IT support experience do you have?',choices=['0-4 years','5-9 years','10+ years'],opts=choices.map((label,index)=>({label,value:String(index),index})),readJob=()=>db.prepare('SELECT * FROM jobs').get(),profile=()=>db.prepare('SELECT * FROM applicants').get(),good={answer:'5-9 years',provider:'gemini'};
 let result=await hosted(db,readJob(),profile(),{label:q},opts,{}, {draft:async()=>good});assert.equal(result.value,'1');assert.equal(result.aiPrepared,true);
 for(const mutation of ["UPDATE jobs SET local_attempt_at='now'","UPDATE jobs SET status='archived'","UPDATE applicants SET gemini_facts_consent=0","UPDATE jobs SET answers_json='{\"new\":\"edit\"}'"]){
  assert.equal(await hosted(db,readJob(),profile(),{label:q},opts,{}, {draft:async()=>{db.exec(mutation);return good;}}),null);
  db.exec("UPDATE jobs SET status='running',local_attempt_at=NULL,answers_json='{}';UPDATE applicants SET gemini_facts_consent=1");
 }
 db.exec("UPDATE jobs SET status='local_browser'");db.prepare('UPDATE jobs SET answers_json=?').run(JSON.stringify({[q]:'7+'}));
 result=await local(db,'u','j',q,{choices,draft:async()=>good});assert.equal(result.answer,'5-9 years');assert.equal(JSON.parse(readJob().answers_json)[q],'7+');
 result=await local(db,'u','j',q,{choices,draft:async()=>{db.prepare('UPDATE jobs SET answers_json=?').run(JSON.stringify({[q]:'10+ years'}));return good;}});assert.equal(result.answer,'10+ years');
 assert.equal(JSON.parse(readJob().answers_json)[q],'10+ years');db.close();
});
async function browserCase({custom=true,unscoped=false,duplicate=false,mutation='',answer='5–9 years',saved='7+',button=false}={}){
 const {JSDOM}=require('jsdom');
 const control=custom?(button?'<button type="button"':'<input readonly')+' id="years" role="combobox" aria-required="true" aria-expanded="false" '+(unscoped?'':'aria-controls="years-options"')+(button?'>Select...</button>':'>'):'<select id="years" required><option value="">Select...</option><option>0–4 years</option><option>5–9 years</option><option>10+ years</option></select>';
 const dom=new JSDOM('<form><label>How many years of IT support experience do you have?'+control+'</label>'+(custom?'<div id="years-options" role="listbox" hidden><div role="option">0–4 years</div><div role="option">5–9 years</div><div role="option">'+(duplicate?'5–9 years':'10+ years')+'</div><div role="option" aria-disabled="true">Unavailable</div></div>':'')+'<div role="listbox"><div role="option" id="unrelated">Wrong other menu</div></div><label>AI Policy for Application<select required id="policy"><option value="">Select...</option><option>Yes</option></select></label><button type="button" id="submit">Submit application</button></form>',{runScripts:'outside-only',url:'https://jobs.ashbyhq.com/example/test'}),w=dom.window,requests=[],messages=[];
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent}});w.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}]};w.setInterval=()=>0;w.clearInterval=()=>{};
 const el=w.document.getElementById('years'),menu=w.document.getElementById('years-options'),q='How many years of IT support experience do you have?';let clicked=0,unrelated=0;
 w.document.getElementById('submit').onclick=()=>clicked++;w.document.getElementById('unrelated').onclick=()=>unrelated++;
 if(custom){el.onclick=()=>{menu.hidden=false;el.setAttribute('aria-expanded','true')};el.onkeydown=e=>{if(e.key==='Escape'){menu.hidden=true;el.setAttribute('aria-expanded','false')}};for(const option of menu.children)option.onclick=()=>{if(button)el.textContent=option.textContent;else el.value=option.textContent;el.setAttribute('aria-valuetext',option.textContent);menu.hidden=true;el.setAttribute('aria-expanded','false')};}
 w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);if(m.action==='packet')return {ok:true,data:{job:{title:'Fixture'},profile:{},answers:saved?{[q]:saved}:{},aiAssistance:true}};if(m.action==='state')return {ok:true,data:{automatic:true,attempted:false}};if(m.action==='answer'){requests.push(m);assert(!m.choices.includes('Wrong other menu'));assert(!m.choices.includes('Unavailable'));if(mutation==='user'){el.value='10+ years';el.setAttribute('aria-valuetext','10+ years');}if(mutation==='options'){if(custom)menu.children[1].textContent='Different';else el.options[2].textContent='Different';}return {ok:true,data:{answer,reason:answer?'Supported by saved IT experience':'How many years of IT support have you performed?'}};}return {ok:true,data:{}};}}};
 w.eval(read('extension/policy.js'));w.eval(read('extension/content.js'));
 for(let i=0;i<150&&!messages.some(m=>m.action==='progress'&&m.blocked);i++)await new Promise(r=>setTimeout(r,20));
 const result={requests,value:el.getAttribute('aria-valuetext')||el.value||'',policy:w.document.getElementById('policy').value,clicked,unrelated};w.close();return result;
}
test('Gemini reads scoped custom dropdown options, maps a saved range and never touches declarations or Submit',async()=>{
 for(const config of [{},{unscoped:true},{button:true}]){const r=await browserCase(config);assert.equal(r.requests.length,1);assert.deepEqual(Array.from(r.requests[0].choices),['0–4 years','5–9 years','10+ years']);assert.equal(r.value,'5–9 years');assert.equal(r.policy,'');assert.equal(r.clicked,0);assert.equal(r.unrelated,0);}
});
test('native dropdowns with differently worded saved answers reach Gemini; no unsupported guesses are filled',async()=>{
 assert.equal((await browserCase({custom:false})).value,'5–9 years');
 for(const config of [{answer:''},{answer:'99 years'},{duplicate:true}]){const r=await browserCase(config);assert.equal(r.value,'');assert.equal(r.clicked,0);if(config.duplicate)assert.equal(r.requests.length,0);}
});
test('dropdown reasoning preserves manual edits and rejects options changed during inference',async()=>{
 assert.equal((await browserCase({mutation:'user'})).value,'10+ years');
 assert.equal((await browserCase({mutation:'options'})).value,'');assert.equal((await browserCase({custom:false,mutation:'options'})).value,'');
});
test('Gemini uses option enums and evidence, supports AV/VIP history and rejects missing or fabricated support',async()=>{
 const {geminiFactAnswer,canDraftProfessional}=await import('../answer-drafts.js');let input,calls=0;
 for(const q of ['Have you built or helped stand up a dedicated executive, VIP, or white-glove support function?','How often have you provided AV support for executive or board meetings?'])assert(canDraftProfessional(q));
 for(const q of ['AI Policy for Application','Please read the arbitration agreement','Do you require visa sponsorship?','What is your gender?'])assert(!canDraftProfessional(q));
 let response={answer:'5–9 years',reason:'Supported range',evidence:[{id:'1',quote:'I have seven years of IT support experience.'}]};
 const args={question:'How many years of IT support experience do you have?',profile:{gemini_facts_consent:1},job:{title:'Support'},answers:{'Professional background':'I have seven years of IT support experience.'},choices:['0–4 years','5–9 years','10+ years'],env:{GEMINI_API_KEY:'fixture'},fetchImpl:async(_url,req)=>{calls++;input=JSON.parse(req.body);return {ok:true,json:async()=>({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify(response)}]}]})}}};
 assert.equal((await geminiFactAnswer(args)).answer,'5–9 years');assert.deepEqual(input.response_format.schema.properties.answer.enum,['',...args.choices]);assert(input.system_instruction.includes('never round up years'));
 response={answer:'No',reason:'',evidence:[{id:'1',quote:'I managed executive support for ten years.'}]};await assert.rejects(geminiFactAnswer(args),/support this answer/);
 response={answer:'',reason:'How often have you supported board AV?',evidence:[]};assert.equal((await geminiFactAnswer(args)).answer,'');
 const before=calls;assert.equal((await geminiFactAnswer({...args,choices:['Same','same']})).answer,'');assert.equal(calls,before);
});
