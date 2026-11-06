// Synthetic Greenhouse-style forms (jsdom): optional fields never block or reach
// Gemini, the exact saved resume must be attached before Submit, and the
// helper's own edits do not trigger endless refills.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const RESUME=Buffer.from('%PDF-1.4 synthetic resume').toString('base64');
function form({attached='resume.pdf',size=Buffer.from(RESUME,'base64').length,extra=''}={}){
 return `<form id="application"><label for="first">First Name *</label><input id="first" name="first" required>
  <label for="info">Additional Information</label><textarea id="info" name="info" aria-describedby="info-help"></textarea><p id="info-help">Add a cover letter or anything else you want to share.</p>
  <label for="resume">Resume/CV *</label><input id="resume" type="file" name="resume" required data-attached="${attached}" data-size="${size}">${extra}
  <button type="submit" id="submit">Submit application</button></form>`;
}
async function run(html,{autonomous=true}={}){
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://job-boards.greenhouse.io/acme/jobs/123'}),w=dom.window,messages=[];let submits=0;
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});w.HTMLElement.prototype.getClientRects=()=>[{}];
 const realInterval=w.setInterval.bind(w);w.setInterval=(fn,ms)=>realInterval(fn,ms===2500?40:ms);
 if(!w.crypto?.randomUUID)Object.defineProperty(w,'crypto',{value:require('node:crypto').webcrypto});
 const input=w.document.getElementById('resume');
 // jsdom cannot hold real files: model the browser's file list and validity.
 let held=[];
 if(input.dataset.attached)held=[new w.File([Buffer.alloc(Number(input.dataset.size))],input.dataset.attached,{type:'application/pdf'})];
 Object.defineProperty(input,'files',{configurable:true,get:()=>Object.assign([...held],{item:i=>held[i]}),set:()=>{/* employer widget did not retain the upload */}});
 Object.defineProperty(input,'validity',{configurable:true,get:()=>({valid:held.length>0,valueMissing:!held.length})});
 w.DataTransfer=class{constructor(){this.list=[];this.items={add:f=>this.list.push(f)};}get files(){return this.list;}};
 w.document.getElementById('application').addEventListener('submit',e=>{e.preventDefault();submits++;w.document.body.insertAdjacentHTML('beforeend','<h1>Thank you for applying.</h1>\n');});
 let attempted=false;
 w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(structuredClone(m));
  if(m.action==='packet')return {ok:true,data:{job:{id:'j',title:'SRE',company:'Acme',attempted:false},profile:{first_name:'Fixture',name:'Fixture Applicant'},answers:{'First Name':'Fixture'},resume:{name:'resume.pdf',base64:RESUME},savedFactsAvailable:true,aiAssistance:true,autonomousSubmit:autonomous,prepareSteps:true,autofillOnly:!autonomous}};
  if(m.action==='state')return {ok:true,data:{automatic:true,attempted,autonomousSubmit:autonomous,prepareSteps:true,autofillOnly:!autonomous,refreshEnabled:true}};
  if(m.action==='answer')return {ok:true,data:{answer:'',reason:'Save your answer.'}};
  if(m.action==='attempt'){attempted=true;return {ok:true,data:{ok:true,permitted:true}};}
  return {ok:true,data:{}};}}};
 w.eval(read('extension/policy.js'));w.eval(read('extension/content.js'));
 const done=async(pred,ms=5000)=>{const end=Date.now()+ms;while(Date.now()<end&&!pred())await new Promise(r=>setTimeout(r,20));};
 return {w,messages,done,submits:()=>submits};
}
test('optional Additional Information with help text neither blocks nor reaches Gemini; the form submits once',{timeout:15000},async()=>{
 const h=await run(form());
 try{
  await h.done(()=>h.messages.some(m=>m.action==='attempt')||h.messages.some(m=>m.action==='progress'&&m.blocked));
  const blocked=h.messages.filter(m=>m.action==='progress'&&m.blocked);
  assert.equal(blocked.length,0,JSON.stringify(blocked.map(b=>b.message)));
  assert(!h.messages.some(m=>m.action==='answer'&&/Additional Information/.test(m.question)),'optional question never drafted');
  assert.equal(h.messages.filter(m=>m.action==='attempt').length,1);assert.equal(h.w.document.getElementById('info').value,'','optional left blank');
 }finally{h.w.close();}
});
test('a different resume file blocks Submit with the reason; nothing is attempted',{timeout:15000},async()=>{
 const h=await run(form({attached:'old-cv.pdf',size:999}));
 try{
  await h.done(()=>h.messages.some(m=>m.action==='progress'&&m.blocked));
  const b=h.messages.find(m=>m.action==='progress'&&m.blocked);assert.match(b.message,/not your saved resume/);assert.deepEqual(b.fields,['Resume']);
  assert(!h.messages.some(m=>m.action==='attempt'));assert.equal(h.submits(),0);
 }finally{h.w.close();}
});
test('a missing resume blocks Submit',{timeout:15000},async()=>{
 const h=await run(form({attached:''}));
 try{
  await h.done(()=>h.messages.some(m=>m.action==='progress'&&m.blocked));
  assert(h.messages.some(m=>m.action==='progress'&&m.blocked&&/resume/i.test(m.message+' '+(m.fields||[]).join(' '))));
  assert(!h.messages.some(m=>m.action==='attempt'));
 }finally{h.w.close();}
});
test('a required unknown question blocks once: identical blocker reports are not re-sent',{timeout:15000},async()=>{
 const h=await run(form({extra:'<label for="k8s">Years of production Kubernetes experience *</label><input id="k8s" required>'}),{autonomous:false});
 try{
  await h.done(()=>h.messages.some(m=>m.action==='progress'&&m.blocked));
  const first=h.messages.filter(m=>m.action==='progress'&&m.blocked);
  assert(first[0].fields.some(f=>/Kubernetes/.test(f)));assert.equal(typeof first[0].step,'number');
  // Our own edits must not count as form changes that restart filling.
  h.w.document.getElementById('first').value='Fixture';await new Promise(r=>setTimeout(r,900));
  assert.equal(h.messages.filter(m=>m.action==='progress'&&m.blocked).length,first.length,'no repeated identical blocker');
  assert(!h.messages.some(m=>m.action==='attempt'));
 }finally{h.w.close();}
});
