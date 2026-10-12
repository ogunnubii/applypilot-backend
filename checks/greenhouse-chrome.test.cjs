const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const questions={
 location:'Location: (Please confirm your work/residency location)',
 timezone:'Which time zone do you primarily work in?',
 kubernetes:'Do you have experience configuring and troubleshooting Kubernetes infrastructure?',
 argo:'Do you have hands-on experience with Argo CD?',
 support:'Have you worked in a customer-facing support role?',
 experience:'Please describe your hands-on experience with Kubernetes and Argo CD. Include details such as:'
};
const help='How you have used Kubernetes in a professional setting Specific ways you have worked with Argo CD (e.g., deployments, rollbacks, pipeline management)';
const choices={timezone:['Eastern Time (US & Canada)','Pacific Time (US & Canada)'],kubernetes:['Yes','No'],argo:['Yes','No'],support:['Yes','No']};
const ids=Object.fromEntries(Object.keys(questions).map((key,i)=>[key,'question_'+(6753577009+i*1000)]));
const escape=value=>String(value).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// Reduced from public Akuity Greenhouse HTML. React Select has a visible search
// input and a separate opacity-zero required validation input, not two questions.
function control(key){
 const id=ids[key],label='<label id="'+id+'-label" for="'+id+'" class="label">'+escape(questions[key])+'<span aria-hidden="true">*</span></label>';
 if(choices[key])return '<div class="select__container">'+label+'<div class="select-shell"><div class="select__control"><div class="select__value-container"><div class="select__placeholder" id="'+id+'-placeholder">Select...</div><div class="select__input-container" data-value=""><input id="'+id+'" class="select__input" type="text" role="combobox" aria-labelledby="'+id+'-label" aria-required="true" aria-expanded="false" aria-describedby="'+id+'-placeholder"></div></div></div><input required tabindex="-1" aria-hidden="true" style="opacity:0;pointer-events:none;position:absolute" value=""></div></div>';
 const description=key==='experience'?'<div id="'+id+'-description"><p>How you have used Kubernetes in a professional setting</p> <p>Specific ways you have worked with Argo CD (e.g., deployments, rollbacks, pipeline management)</p></div>':'';
 const tag=key==='experience'?'textarea':'input';
 return '<div class="field-wrapper"><div class="input-wrapper">'+label+'<'+tag+' id="'+id+'" aria-label="'+escape(questions[key])+'" aria-required="true" aria-describedby="'+id+'-description '+id+'-help"'+(tag==='textarea'?'></textarea>':' type="text">')+'</div>'+description+'</div>';
}

async function fixture({keys=Object.keys(questions),answers={},savedFactsAvailable=false,prepareAnswer=()=>({answer:''}),rejectSelection=false,before=()=>{},html}={}){
 const dom=new JSDOM('<form>'+(html??keys.map(control).join(''))+'<button type="button" id="submit">Submit application</button></form>',{runScripts:'outside-only',url:'https://job-boards.greenhouse.io/akuity/jobs/fixture'});
 const w=dom.window,messages=[],requests=[],opened=[];let clicks=0;
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 // Opacity-zero controls have layout rectangles in Chrome. They must be
 // excluded by aria-hidden, not by a fixture that pretends they have no layout.
 w.HTMLElement.prototype.getClientRects=function(){return this.isConnected&&!this.closest('[hidden]')?[{}]:[];};
 w.setInterval=()=>0;w.clearInterval=()=>{};
 w.document.getElementById('submit').onclick=()=>clicks++;
 const select=(key,value,{afterSearch=false}={})=>{
  const input=w.document.getElementById(ids[key]),container=input.closest('.select__value-container');
  container.querySelector('.select__placeholder')?.remove();container.querySelector('.select__single-value')?.remove();
  const label=w.document.createElement('div');label.className='select__single-value';label.textContent=value;
  if(afterSearch)container.append(label);else container.prepend(label);
  input.value='';input.parentElement.dataset.value='';input.setAttribute('aria-expanded','false');
  input.closest('.select__container').querySelector('input[aria-hidden="true"]')?.remove();
  w.document.getElementById(ids[key]+'-options')?.remove();
 };
 for(const key of keys.filter(key=>choices[key])){
  const input=w.document.getElementById(ids[key]);if(!input)continue;
  // React Select binds opening to Control.onMouseDown, not Input.onClick.
  input.closest('.select__control').onmousedown=()=>{
   if(input.getAttribute('aria-expanded')==='true')return;
   opened.push(key);const menu=w.document.createElement('div');menu.id=ids[key]+'-options';menu.setAttribute('role','listbox');
   for(const value of choices[key]){const option=w.document.createElement('div');option.setAttribute('role','option');option.textContent=value;option.onclick=()=>{
    if(rejectSelection){input.value=value;input.parentElement.dataset.value=value;input.setAttribute('aria-expanded','false');menu.remove();}
    else select(key,value);
   };menu.append(option);}
   w.document.body.append(menu);input.setAttribute('aria-controls',menu.id);input.setAttribute('aria-expanded','true');
  };
  input.onkeydown=event=>{if(event.key==='Escape'){w.document.getElementById(ids[key]+'-options')?.remove();input.setAttribute('aria-expanded','false');}};
 }
 w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(message){
  messages.push(message);
  if(message.action==='packet')return {ok:true,data:{job:{title:'Support Engineer'},profile:{},answers:{...answers},savedFactsAvailable,aiAssistance:false,autonomousSubmit:false,prepareSteps:true}};
  if(message.action==='state')return {ok:true,data:{automatic:true,attempted:false,autonomousSubmit:false,prepareSteps:true}};
  if(message.action==='answer'){requests.push(message);return {ok:true,data:prepareAnswer(message)};}
  return {ok:true,data:{}};
 }}};
 before(w,select);
 w.eval(read('extension/policy.js'));w.eval(read('extension/content.js'));
 for(let n=0;n<350&&!messages.some(m=>m.action==='progress'&&m.blocked);n++)await new Promise(resolve=>setTimeout(resolve,20));
 assert(messages.some(m=>m.action==='progress'&&m.blocked),'fixture preparation must finish');
 return {w,messages,requests,opened,clicks,progress:messages.findLast(m=>m.action==='progress'&&m.blocked),close:()=>w.close()};
}

test('Greenhouse React Select opens on mousedown, commits exact saved Yes/No choices and never submits',async()=>{
 const saved={location:'Fixture City, Fixture Region, Fixture Country',timezone:choices.timezone[0],kubernetes:'Yes',argo:'No',support:'Yes',experience:'My approved fixture experience.'};
 const f=await fixture({answers:Object.fromEntries(Object.entries(saved).map(([key,value])=>[questions[key],value]))});
 try{
  for(const [key,value]of Object.entries(saved)){
   const input=f.w.document.getElementById(ids[key]);
   if(choices[key]){assert.equal(input.closest('.select__control').querySelector('.select__single-value')?.textContent,value);assert.equal(input.value,'');assert(f.opened.includes(key));}
   else assert.equal(input.value,value);
  }
  assert.equal(f.progress.readyForSubmit,true);assert.deepEqual({...f.progress.progress},{required:6,filled:6});
  assert.equal(f.requests.length,0);assert.equal(f.clicks,0);assert(!f.messages.some(m=>['attempt','receipt'].includes(m.action)));
  const captured=f.messages.find(m=>m.action==='capture').fields;
  assert(captured.some(row=>row.question===questions.argo&&row.answer==='No'));
 }finally{f.close();}
});

test('unknown Greenhouse requirements expose exact questions and textarea help, with no generic proxy inputs',async()=>{
 const f=await fixture({savedFactsAvailable:true,before:w=>w.document.getElementById(ids.timezone).removeAttribute('aria-required')});
 try{
  assert.deepEqual(Array.from(f.progress.fields),Object.values(questions));
  assert.deepEqual({...f.progress.progress},{required:6,filled:0});assert.equal(f.progress.readyForSubmit,false);
  assert.deepEqual(f.requests.map(m=>m.question),Object.values(questions));
  for(const key of Object.keys(choices))assert.deepEqual(Array.from(f.requests.find(m=>m.question===questions[key]).choices),choices[key]);
  assert.equal(f.requests.find(m=>m.question===questions.experience).fieldHelp,help);
  assert.equal(f.w.document.querySelectorAll('input[aria-hidden="true"][required]').length,4);
  assert.equal(f.clicks,0);assert(!f.messages.some(m=>['attempt','receipt'].includes(m.action)));
 }finally{f.close();}
});

test('saved-fact No is a valid selection while an unsupported answer stays unresolved',async()=>{
 const f=await fixture({keys:['argo','support'],savedFactsAvailable:true,prepareAnswer:m=>({answer:m.question===questions.argo?'No':'',reason:'The saved facts do not answer this question.'})});
 try{
  assert.equal(f.w.document.getElementById(ids.argo).closest('.select__control').querySelector('.select__single-value')?.textContent,'No');
  assert.deepEqual(Array.from(f.progress.fields),[questions.support]);assert.deepEqual({...f.progress.progress},{required:2,filled:1});
  assert.equal(f.progress.readyForSubmit,false);assert.equal(f.clicks,0);
 }finally{f.close();}
});

test('React Select search text is not a completed selection even when the menu closes',async()=>{
 const f=await fixture({keys:['argo'],answers:{[questions.argo]:'No'},rejectSelection:true});
 try{assert.equal(f.w.document.getElementById(ids.argo).value,'No');assert.deepEqual(Array.from(f.progress.fields),[questions.argo]);assert.equal(f.progress.readyForSubmit,false);assert.equal(f.progress.progress.filled,0);assert.equal(f.clicks,0);}
 finally{f.close();}
});

test('a committed label wins over an earlier empty data-value search wrapper and is preserved',async()=>{
 const f=await fixture({keys:['argo'],answers:{[questions.argo]:'Yes'},before:(_w,select)=>select('argo','No',{afterSearch:true})});
 try{assert.equal(f.progress.readyForSubmit,true);assert.equal(f.opened.length,0);assert(f.messages.find(m=>m.action==='capture').fields.some(row=>row.question===questions.argo&&row.answer==='No'));assert.equal(f.clicks,0);}
 finally{f.close();}
});

test('a custom combobox inherits its hidden required descendant without surfacing the proxy as a question',async()=>{
 const f=await fixture({keys:[],html:'<label id="choice-label">Choose the support region<span aria-hidden="true">*</span></label><div role="combobox" aria-labelledby="choice-label"><input aria-hidden="true" required></div>'});
 try{assert.deepEqual(Array.from(f.progress.fields),['Choose the support region']);assert.deepEqual({...f.progress.progress},{required:1,filled:0});assert.equal(f.progress.readyForSubmit,false);}
 finally{f.close();}
});


test('equivalent saved IANA and Greenhouse timezone aliases fill while conflicting zones stay blank',async()=>{
 for(const other of ['Eastern Time (ET)','America/Vancouver']){
  const f=await fixture({keys:['timezone'],answers:{'Time zone':'America/Toronto',[questions.timezone]:other}});
  try{
   const value=f.w.document.getElementById(ids.timezone).closest('.select__control').querySelector('.select__single-value')?.textContent||'';
   assert.equal(value,other==='Eastern Time (ET)'?choices.timezone[0]:'');
   assert.equal(f.progress.readyForSubmit,other==='Eastern Time (ET)');assert.equal(f.clicks,0);
  }finally{f.close();}
 }
});
