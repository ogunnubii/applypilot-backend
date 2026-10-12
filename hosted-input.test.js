import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {hostedFormState} from './hosted-form-state.js';
import {fillHostedText,typeHostedSearch,sameHostedInputValue} from './hosted-input.js';
import {hostedFieldKind,hostedFieldAnswer,protectedHostedQuestion} from './hosted-form.js';

const worker=readFileSync(new URL('./worker.js',import.meta.url),'utf8');

test('approved immediate availability selects the calendar Today option instead of typing non-date text',async()=>{
 for(const count of [0,1,2]){
  const f=fixture('<input class="ashby-application-form-input-date" required>');
  try{
   const input=f.w.document.querySelector('input'),l=f.locator(input);let choices=0;
   l.page=()=>({waitForTimeout:async()=>{},locator:selector=>{
    assert.match(selector,/aria-current="date"/);assert.match(selector,/aria-disabled/);
    return {count:async()=>count,click:async()=>{choices++;input.value='10/11/2026';input.dispatchEvent(new f.w.Event('change',{bubbles:true}));}};
   }});
   assert.equal(await fillHostedText(l,'Immediately',{kind:'employment'}),count===1);
   assert.equal(choices,count===1?1:0);assert(!f.calls.some(c=>Array.isArray(c)&&c[0]==='type'));
   if(count===1)assert.equal(input.value,'10/11/2026');
  }finally{f.dom.window.close()}
 }
 const f=fixture('<input class="ashby-application-form-input-date">');
 try{assert.equal(await fillHostedText(f.locator(f.w.document.querySelector('input')),'In a few weeks',{kind:'employment'}),false);assert.equal(f.calls.length,0);}finally{f.dom.window.close()}
});

// This adapter tests the helper's Playwright contract and framework state in a
// DOM fixture. The separate Chromium smoke test verifies actual trusted events.
function fixture(html){
 const dom=new JSDOM(html,{runScripts:'outside-only'}),{window:w}=dom;
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 w.HTMLElement.prototype.getBoundingClientRect=()=>({width:100,height:20});
 const calls=[];
 function locator(e){
  let changed=false;
  const native=Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?w.HTMLTextAreaElement.prototype:w.HTMLInputElement.prototype,'value').set;
  return {
   isEditable:async()=>!e.disabled&&!e.readOnly,
   inputValue:async()=>e.value,
   evaluate:async (fn,arg)=>w.eval(`(${fn.toString()})`)(e,arg),
   click:async()=>{calls.push('click');e.focus();e.click();},
   pressSequentially:async value=>{calls.push(['type',value]);for(const character of value){
    e.dispatchEvent(new w.KeyboardEvent('keydown',{key:character,bubbles:true}));
    if(e.maxLength<0||e.value.length<e.maxLength)native.call(e,e.value+character);
    changed=true;e.dispatchEvent(new w.InputEvent('input',{bubbles:true,inputType:'insertText',data:character}));
    e.dispatchEvent(new w.KeyboardEvent('keyup',{key:character,bubbles:true}));
   }},
   press:async key=>{calls.push(['press',key]);e.dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true}));e.dispatchEvent(new w.KeyboardEvent('keyup',{key,bubbles:true}));},
   blur:async()=>{calls.push('blur');if(changed)e.dispatchEvent(new w.Event('change',{bubbles:true}));e.blur();},
   page:()=>({waitForTimeout:async()=>{}})
  };
 }
 const code=worker.slice(worker.indexOf('async function review(page)'),worker.indexOf('\nasync function custom(page'));
 w.hostedFormState=w.eval('('+hostedFormState.toString()+')');
 const review=()=>w.eval(`(${code})`)({evaluate:fn=>fn()});
 return {dom,w,calls,locator,review};
}

test('hosted custom fields fill saved name facts but never ask AI to resolve missing or conflicting identity',async()=>{
 const code=worker.slice(worker.indexOf('async function custom(page,p,j)'),worker.indexOf('\nasync function selections('));
 for(const [profile,expected] of [
  [{name:'Fixture Applicant',answers_json:'{}'},'Fixture Applicant'],
  [{name:'Fixture Applicant',answers_json:JSON.stringify({'Legal Name':'Different Applicant'})},''],
  [{answers_json:'{}'},'']
 ]){
  const f=fixture('<label>Legal Name<textarea required></textarea></label>');
  try{
   const input=f.w.document.querySelector('textarea'),locator=f.locator(input);
   const custom=Function('hostedFieldKind','hostedFieldAnswer','protectedHostedQuestion','fillHostedText','automaticTextAnswer','fieldDescriptor','event','authorizeResearchFill','return ('+code+')')(
    hostedFieldKind,hostedFieldAnswer,protectedHostedQuestion,fillHostedText,
    ()=>{throw Error('A model must not invent/resolve profile identity');},async()=>({label:'Legal Name',required:true}),()=>{},()=>true);
   const result=await custom({locator:()=>({count:async()=>1,nth:()=>locator})},profile,{answers_json:'{}'});
   assert.equal(input.value,expected);assert.deepEqual(result.unresolved,expected?[]:['Legal Name']);
  }finally{f.dom.window.close();}
 }
});

test('keyboard and blur commit all contact fields and the final field to employer state',async()=>{
 const f=fixture('<form><label>Name<input id="name" required></label><label>Email<input id="email" type="email" required></label><label>Phone<input id="phone" type="tel" required></label><label>Address<input id="address" required></label><label>Answer<textarea id="answer" required></textarea></label></form>');
 try{
  const expected={name:'Fixture Applicant',email:'fixture@example.test',phone:'+1 (416) 555-0132',address:'12 Example Street',answer:'First line.\nSecond line.'},model={};
  for(const [id,event] of [['name','keyup'],['email','keyup'],['phone','change'],['address','blur'],['answer','input']]){
   const e=f.w.document.getElementById(id);e.addEventListener(event,()=>{model[id]=e.value;e.setAttribute('aria-invalid','false');});
   // The old paste-style fill leaves these keyboard/commit models untouched,
   // even though the visible required fields have nonempty valid DOM values.
   e.value=expected[id];e.dispatchEvent(new f.w.InputEvent('input',{bubbles:true}));
   if(id!=='answer')assert.equal(model[id],undefined);
   e.value='';e.setAttribute('aria-invalid','true');
  }
  for(const [id,value] of Object.entries(expected))assert.equal(await fillHostedText(f.locator(f.w.document.getElementById(id)),value),true);
  assert.deepEqual(model,expected);
  assert.deepEqual([...(await f.review()).missing],[]);
  assert.equal(f.w.document.activeElement,f.w.document.body,'last control is also blurred before review');
  assert.equal(f.calls.filter(call=>call==='blur').length,5);
  assert(f.calls.filter(Array.isArray).every(call=>call[0]==='type'||call[1]==='End'),'no delete, append-repair, Enter, or submit actions');
 }finally{f.dom.window.close();}
});

test('controlled input native events update framework state rather than just its visible value',async()=>{
 const f=fixture('<label>Name<input required></label>');
 try{
  const e=f.w.document.querySelector('input'),native=Object.getOwnPropertyDescriptor(f.w.HTMLInputElement.prototype,'value');
  let tracked='',model='';
  Object.defineProperty(e,'value',{get(){return native.get.call(this);},set(value){tracked=String(value);native.set.call(this,value);}});
  e.addEventListener('input',()=>{if(e.value!==tracked){tracked=e.value;model=e.value;}});
  e.value='Not committed';e.dispatchEvent(new f.w.Event('input',{bubbles:true}));assert.equal(model,'');
  e.value='';await fillHostedText(f.locator(e),'Élodie 王');assert.equal(model,'Élodie 王');assert.equal(e.value,model);
 }finally{f.dom.window.close();}
});

test('existing, readonly, disabled and newly autofilled values are never overwritten or appended',async()=>{
 const f=fixture('<input value="User edit"><input readonly><input disabled><input id="autofill">');
 try{
  f.w.document.querySelector('#autofill').addEventListener('focus',event=>{event.target.value='Employer autofill';});
  for(const e of f.w.document.querySelectorAll('input'))assert.equal(await fillHostedText(f.locator(e),'Replacement'),false);
  assert.deepEqual([...f.w.document.querySelectorAll('input')].map(e=>e.value),['User edit','','','Employer autofill']);
  assert.equal(f.calls.filter(Array.isArray).length,0);
 }finally{f.dom.window.close();}
});

test('truncation or a framework reverting an answer stops without destructive retry',async()=>{
 for(const html of ['<input maxlength="5">','<input id="reverted">']){
  const f=fixture(html);
  try{
   const e=f.w.document.querySelector('input');if(e.id)e.addEventListener('blur',()=>{e.value='';});
   await assert.rejects(fillHostedText(f.locator(e),'Complete answer'),{code:'HOSTED_INPUT_NOT_RETAINED'});
   assert.equal(f.calls.filter(call=>Array.isArray(call)&&call[0]==='type').length,1);
  }finally{f.dom.window.close();}
 }
});

test('telephone presentation punctuation may vary but data, country prefix and email stay exact',()=>{
 assert.equal(sameHostedInputValue('+1 (416) 555-0132','+14165550132',{type:'tel'}),true);
 for(const value of ['14165550132','+14165550133','+14165550132 ext 4'])assert.equal(sameHostedInputValue(value,'+14165550132',{type:'tel'}),false);
 assert.equal(sameHostedInputValue('fixture@example.tes','fixture@example.test',{type:'email'}),false);
 assert.equal(sameHostedInputValue(' First Last','First Last',{type:'text'}),false);
});

test('final review refuses framework errors, optional invalid fields and busy validation',async()=>{
 const f=fixture('<form aria-busy="true"><label>Name<input required value="Filled" aria-invalid="true"></label><label>Optional email<input type="email" value="bad"></label><input required disabled aria-invalid="true"></form>');
 try{
  const state=await f.review();assert.deepEqual([...state.missing],['Name','Optional email']);assert.equal(state.pending,true);
  f.w.document.querySelector('form').removeAttribute('aria-busy');f.w.document.querySelector('[aria-invalid]').setAttribute('aria-invalid','false');f.w.document.querySelector('[type=email]').value='fixture@example.test';
  const fixed=await f.review();assert.equal(fixed.missing.length,0);assert.equal(fixed.pending,false);
 }finally{f.dom.window.close();}
});

test('both hosted contact and custom-answer filling use the keyboard commit helper',()=>{
 assert.match(worker,/fillHostedText\(l,selected.answer,\{kind:selected.kind\}\)/);
 assert.match(worker,/fillHostedText\(l,selected.answer\)/);
 assert.doesNotMatch(worker,/\.fill\(selected.answer\)/);
});

test('combobox roles cannot hide native type and pattern validation errors',async()=>{
 const f=fixture('<label>Email choice<input role="combobox" type="email" value="invalid"></label><label>Postal choice<input role="combobox" pattern="[0-9]{5}" value="ABC"></label><label>Valid choice<input role="combobox" required value="Toronto"></label>');
 try{assert.deepEqual([...(await f.review()).missing],['Email choice','Postal choice','Valid choice']);}
 finally{f.dom.window.close();}
});

test('searchable location types a query without blur or pretending an option is selected',async()=>{
 const f=fixture('<input role="combobox"><input role="combobox" value="User selection"><button role="combobox">Choose</button>');
 try{const e=f.w.document.querySelector('input');await typeHostedSearch(f.locator(e),'Toronto, Ontario, Canada');assert.equal(e.value,'Toronto, Ontario, Canada');assert.equal(e.dataset.applypilotUncommittedSearch,'true');assert.equal(f.w.document.activeElement,e);assert(!f.calls.includes('blur'));assert.equal(await typeHostedSearch(f.locator(f.w.document.querySelectorAll('input')[1]),'Replacement'),false);assert.equal(await typeHostedSearch(f.locator(f.w.document.querySelector('button')),'Replacement'),false);}finally{f.dom.window.close();}
});

test('an unchanged worker-owned location query can resume without typing twice or overwriting edits',async()=>{
 const f=fixture('<input role="combobox">');
 try{
  const input=f.w.document.querySelector('input'),locator=f.locator(input);
  assert.equal(await typeHostedSearch(locator,'Toronto, Ontario, Canada'),true);
  const count=f.calls.length;
  assert.equal(await typeHostedSearch(locator,'Toronto, Ontario, Canada'),true);
  assert.equal(f.calls.length,count);
  input.value='Applicant edit';assert.equal(await typeHostedSearch(locator,'Toronto, Ontario, Canada'),false);
  assert.equal(input.value,'Applicant edit');
  input.value='Toronto, Ontario, Canada';delete input.dataset.applypilotUncommittedSearch;
  assert.equal(await typeHostedSearch(locator,'Toronto, Ontario, Canada'),false);
 }finally{f.dom.window.close();}
});

function leverFixture(labels=['Toronto, Ontario, Canada'],commit=true){
 const f=fixture('<form><label for="location">Current location</label><div class="application-field"><input class="location-input" id="location" name="location" required><input type="hidden" name="selectedLocation"><div class="dropdown-results"></div></div></form><div class="dropdown-results"><div class="dropdown-location">Toronto, Ontario, Canada</div></div>');
 const input=f.w.document.querySelector('input'),hidden=input.nextElementSibling,results=hidden.nextElementSibling,l=f.locator(input);
 let open=false;
 input.addEventListener('input',()=>{open=true;results.replaceChildren(...labels.map(label=>{const div=f.w.document.createElement('div');div.className='dropdown-location';div.textContent=label;return div;}));});
 input.addEventListener('blur',()=>{if(open){input.value='';hidden.value='';results.replaceChildren();}});
 l.locator=selector=>{assert.equal(selector,'..');return {locator:selector=>{assert.equal(selector,'.dropdown-results .dropdown-location:visible');return {
  allTextContents:async()=>[...results.children].map(e=>e.textContent),
  nth:index=>({click:async()=>{const option=results.children[index];assert(option);f.calls.push('option');if(commit){open=false;input.value=option.textContent;hidden.value=JSON.stringify({name:option.textContent});results.replaceChildren();}}})
 };}};};
 return {...f,input,hidden,l};
}

test('Lever descriptions retain the real question separately from radio answers and search hints',async()=>{
 const f=fixture('<li class="application-question custom-question"><div><div class="application-label"><div class="text">Do you have experience working in a start-up environment?<span>✱</span></div></div><div class="application-field"><label><input type="radio" name="cards[x][field0]" value="Yes" required>Yes</label><label><input type="radio" name="cards[x][field0]" value="No" required>No</label></div></div></li><li class="application-question"><div class="application-label">Why this company?✱</div><div class="application-field"><textarea name="cards[y][field0]" required></textarea></div></li>');
 try{
  const radios=[...f.w.document.querySelectorAll('input')];
  for(const e of radios){const d=await f.locator(e).evaluate(hostedFormState);assert.equal(d.label,'Do you have experience working in a start-up environment?✱');assert.equal(d.optionLabel,e.value);assert.equal(d.ambiguous,false);}
  assert.deepEqual([...(await f.review()).missing],['Do you have experience working in a start-up environment?✱','Why this company?✱']);
 }finally{f.dom.window.close();}
});

test('Lever location selects an exact scoped option and reads the employer payload after blur',async()=>{
 const f=leverFixture(['Toronto, Ohio, United States','Toronto, Ontario, Canada']);
 try{
  assert.equal(await fillHostedText(f.l,'Toronto, Ontario, Canada',{kind:'location'}),true);
  assert.equal(f.input.value,'Toronto, Ontario, Canada');assert.equal(JSON.parse(f.hidden.value).name,f.input.value);
  assert.deepEqual([...(await f.review()).missing],[]);assert.equal(f.calls.filter(x=>x==='option').length,1);
  assert.equal(await fillHostedText(f.l,'Vancouver, British Columbia, Canada',{kind:'location'}),false);
  assert(!f.calls.some(x=>Array.isArray(x)&&x[0]==='press'),'no Enter or submit is used to choose the location');
 }finally{f.dom.window.close();}
});

test('Lever queries, mismatched payloads and ambiguous or missing options never count as completed',async()=>{
 for(const labels of [[],['Toronto, Ohio, United States'],['Toronto, Ontario, Canada','Toronto, Ontario, Canada']]){
  const f=leverFixture(labels);
  try{
   assert.equal(await fillHostedText(f.l,'Toronto, Ontario, Canada',{kind:'location'}),false);
   assert.equal(f.hidden.value,'');assert.deepEqual([...(await f.review()).missing],['Current location']);assert(!f.calls.includes('option'));
   delete f.input.dataset.applypilotUncommittedSearch;
   for(const payload of ['',JSON.stringify({name:'Toronto, Ohio, United States'}),'invalid']){f.hidden.value=payload;assert.deepEqual([...(await f.review()).missing],['Current location']);}
  }finally{f.dom.window.close();}
 }
 const f=leverFixture(undefined,false);
 try{await assert.rejects(fillHostedText(f.l,'Toronto, Ontario, Canada',{kind:'location'}),{code:'HOSTED_INPUT_NOT_RETAINED'});assert.deepEqual([...(await f.review()).missing],['Current location']);}finally{f.dom.window.close();}
});

test('Lever location preserves existing edits and accepts only trusted current-location facts',async()=>{
 for(const state of ['edit','hidden','untrusted','focus']){
  const f=leverFixture();
  try{
   if(state==='edit')f.input.value='Applicant edit';
   if(state==='hidden')f.hidden.value=JSON.stringify({name:'Existing selection'});
   if(state==='focus')f.input.addEventListener('focus',()=>{f.input.value='Employer autofill';});
   assert.equal(await fillHostedText(f.l,'Toronto, Ontario, Canada',{kind:state==='untrusted'?undefined:'location'}),false);
   assert(!f.calls.some(x=>Array.isArray(x)&&x[0]==='type'));assert(!f.calls.includes('option'));
  }finally{f.dom.window.close();}
 }
});
