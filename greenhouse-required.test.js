import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {hostedFormState} from './hosted-form-state.js';
import {hostedFieldAnswer,hostedOptionChoice,protectedHostedQuestion,scopedHostedComboboxOptions} from './hosted-form.js';

// Structure and wording read from the public Akuity Greenhouse form on
// 2026-10-11. All values and interactions below stay in this synthetic DOM.
const questions=[
 'Which time zone do you primarily work in?',
 'Do you have experience configuring and troubleshooting Kubernetes infrastructure?',
 'Do you have hands-on experience with Argo CD?',
 'Have you worked in a customer-facing support role?'
];
const options=[['Pacific Time (PT)','Mountain Time (MT)','Central Time (CT)','Eastern Time (ET)','Other (please specify)'],['Yes','No'],['Yes','No'],['Yes','No']];
const combo=(q,i)=>`<div class="field-wrapper"><div class="select__container"><label for="q${i}" id="q${i}-label">${q}<span aria-hidden="true">*</span></label><div class="select-shell"><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div><div class="select__input-container" data-value=""><input type="text" id="q${i}" role="combobox" aria-required="true" aria-labelledby="q${i}-label" aria-expanded="false" aria-controls="list${i}"></div></div></div><input required aria-hidden="true" tabindex="-1" style="opacity:0"></div><div id="list${i}" role="listbox" hidden>${options[i].map(o=>`<div role="option">${o}</div>`).join('')}</div></div></div>`;
const locationQuestion='Location: (Please confirm your work/residency location)';
const detailQuestion='Please describe your hands-on experience with Kubernetes and Argo CD. Include details such as:';
const html=`<form><div class="field-wrapper"><label for="location">${locationQuestion}<span aria-hidden="true">*</span></label><input id="location" aria-required="true" aria-describedby="location-description"><div id="location-description">(City and Country)</div></div>${questions.map(combo).join('')}<div class="field-wrapper"><label for="details">${detailQuestion}<span aria-hidden="true">*</span></label><textarea id="details" aria-required="true" aria-describedby="details-help"></textarea><div id="details-help">How you have used Kubernetes in a professional setting. Specific ways you have worked with Argo CD (e.g., deployments, rollbacks, pipeline management)</div></div><button type="submit">Submit application</button></form>`;
function fixture(){
 const dom=new JSDOM(html,{runScripts:'outside-only'}),w=dom.window,d=w.document;
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 w.HTMLElement.prototype.getBoundingClientRect=function(){return {width:this.closest('[hidden]')?0:100,height:20};};
 const read=w.eval('('+hostedFormState.toString()+')');
 return {dom,w,d,read};
}
function select(d,i,value){
 const control=d.getElementById('q'+i).closest('.select__control');control.querySelector('.select__placeholder')?.remove();control.querySelector('.select__single-value')?.remove();
 const selected=d.createElement('div');selected.className='select__single-value';selected.textContent=value;control.querySelector('.select__value-container').prepend(selected);
 const e=d.getElementById('q'+i);e.value='';e.setAttribute('aria-expanded','false');d.getElementById('list'+i).hidden=true;
}
test('Greenhouse labels retain exact questions, required flags and multipart field help',()=>{
 const f=fixture();try{
  const state=f.read();assert.equal(state.required,6);assert.equal(state.filled,0);
  assert.deepEqual(Array.from(state.missing),[locationQuestion+'*',...questions.map(q=>q+'*'),detailQuestion+'*']);
  assert.equal(f.read(f.d.getElementById('q2')).required,true);
  f.d.getElementById('q2').removeAttribute('aria-required');assert.equal(f.read().required,6,'required validation proxy applies to its one real dropdown');
  assert.match(f.read(f.d.getElementById('details')).description,/rollbacks, pipeline management/);
 }finally{f.dom.window.close();}
});
test('Greenhouse committed sibling values count; queries, placeholder and invalid selections do not',()=>{
 const f=fixture();try{
  const e=f.d.getElementById('q2');e.value='Yes';e.parentElement.dataset.value='Yes';
  assert.equal(f.read(e).populated,false);assert.equal(f.read().filled,0);
  e.value='';select(f.d,2,'Yes');assert.equal(f.read(e).selectedValue,'Yes');assert.equal(f.read(e).populated,true);assert.equal(f.read().filled,1);
  e.setAttribute('aria-invalid','true');assert.equal(f.read().filled,0);assert(f.read().missing.includes(questions[2]+'*'));
  e.removeAttribute('aria-invalid');e.dataset.applypilotUncommittedSearch='true';assert.equal(f.read().filled,0);
  delete e.dataset.applypilotUncommittedSearch;assert.equal(f.read().filled,1);
 }finally{f.dom.window.close();}
});
function fakePage(f,{ignoreClicks=false}={}){
 const apply=(fn,e,arg)=>f.w.eval('('+fn.toString()+')')(e,arg);
 const visible=e=>!e.closest('[hidden],[aria-hidden="true"]');
 const find=(root,selector)=>[...root.querySelectorAll(selector.replaceAll(':visible',''))].filter(e=>!selector.includes(':visible')||visible(e));
 class Locator{
  constructor(resolve){this.resolve=resolve;}
  get elements(){return this.resolve();}
  count=async()=>this.elements.length;
  nth=i=>new Locator(()=>[this.elements[i]]);
  locator=selector=>new Locator(()=>this.elements.flatMap(e=>find(e,selector)));
  evaluate=async(fn,arg)=>apply(fn,this.elements[0],arg);
  evaluateAll=async(fn,arg)=>apply(fn,this.elements,arg);
  getAttribute=async attr=>this.elements[0].getAttribute(attr);
  click=async()=>{const e=this.elements[0];if(e.getAttribute('role')==='combobox'){f.d.getElementById(e.getAttribute('aria-controls')).hidden=false;e.setAttribute('aria-expanded','true');}else if(e.getAttribute('role')==='option'&&!ignoreClicks){const i=Number(e.parentElement.id.replace('list',''));select(f.d,i,e.textContent);}};
  press=async key=>{if(key==='Escape'){const e=this.elements[0];f.d.getElementById(e.getAttribute('aria-controls')).hidden=true;e.setAttribute('aria-expanded','false');}};
 }
 return {locator:selector=>new Locator(()=>find(f.d,selector)),waitForTimeout:async()=>{},waitForFunction:async(fn,arg)=>{assert(apply(fn,arg),'menu appeared');}};
}
const worker=readFileSync(new URL('./worker.js',import.meta.url),'utf8');
const source=worker.slice(worker.indexOf('async function customControls('),worker.indexOf('\nasync function recordFormProgress('));
function controls({draft=async(_db,_j,p,d,opts,answers)=>hostedOptionChoice(d,opts,p,answers)}={}){
 return new Function('fieldDescriptor','hostedFieldAnswer','protectedHostedQuestion','typeHostedSearch','scopedHostedComboboxOptions','prepareHostedDropdown','authorizeResearchFill','fillHostedButtonGroups','db',source+';return customControls;')(
  locator=>locator.evaluate(hostedFormState),hostedFieldAnswer,protectedHostedQuestion,async()=>false,scopedHostedComboboxOptions,draft,()=>true,async()=>{},null);
}
test('actual hosted dropdown loop commits saved choices without overwriting a prefilled Greenhouse selection',async()=>{
 const f=fixture();try{
  select(f.d,2,'No');let calls=0;
  const p={answers_json:JSON.stringify({[questions[0]]:'Eastern Time (ET)',[questions[1]]:'Yes',[questions[2]]:'Yes',[questions[3]]:'Yes'})};
  const fill=controls({draft:async(...args)=>{calls++;return hostedOptionChoice(args[3],args[4],args[2],args[5]);}});
  const result=await fill(fakePage(f),p,{});assert.deepEqual(result.unresolved,[]);assert.equal(calls,3);
  assert.deepEqual(questions.map((_,i)=>f.read(f.d.getElementById('q'+i)).selectedValue),['Eastern Time (ET)','Yes','No','Yes']);
  assert.equal(f.read().filled,4);assert.deepEqual(Array.from(f.read().missing),[locationQuestion+'*',detailQuestion+'*']);
  await fill(fakePage(f),p,{});assert.equal(calls,3,'repeat preparation preserves all committed answers');
 }finally{f.dom.window.close();}
});
test('unknown Argo history and ignored option clicks remain exact required blockers',async()=>{
 for(const ignoreClicks of [false,true]){
  const f=fixture();try{
   const p={answers_json:JSON.stringify({[questions[0]]:'Eastern Time (ET)',[questions[1]]:'Yes',[questions[3]]:'Yes'})};
   const result=await controls()(fakePage(f,{ignoreClicks}),p,{});
   assert(result.unresolved.includes(questions[2]+'*'));assert.equal(f.read(f.d.getElementById('q2')).populated,false);
   if(ignoreClicks){assert.equal(result.unresolved.length,4);assert.equal(f.read().filled,0);}else assert.equal(f.read().filled,3);
   assert.equal(f.d.querySelector('input[type=submit]'),null);
  }finally{f.dom.window.close();}
 }
});


test('hosted React Select preserves an unfinished user query before or during drafting',async()=>{
 for(const phase of ['before','during']){
  const f=fixture();try{
   const e=f.d.getElementById('q2');if(phase==='before')e.value='My unfinished search';
   const p={answers_json:JSON.stringify({[questions[2]]:'Yes'})};let argoDrafts=0;
   const fill=controls({draft:async(...args)=>{
    if(args[3].label===questions[2]+'*'){argoDrafts++;if(phase==='during')e.value='My unfinished search';}
    return hostedOptionChoice(args[3],args[4],args[2],args[5]);
   }});
   const result=await fill(fakePage(f),p,{});assert.equal(e.value,'My unfinished search');assert.equal(f.read(e).selectedValue,'');
   assert(result.unresolved.includes(questions[2]+'*'));assert.equal(argoDrafts,phase==='before'?0:1);
  }finally{f.dom.window.close();}
 }
});
