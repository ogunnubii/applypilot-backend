import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {fillHostedButtonGroups} from './hosted-buttons.js';
import {employmentContext,EMPLOYMENT_KEYS as K} from './employment-answers.js';
import {hostedFormState} from './hosted-form-state.js';

function fixture(question,{selected=null,disabled=false,change=false}={}){
 const dom=new JSDOM('<form><div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title _required_1"></label><div class="ashby-application-form-input-yesno"><input type="checkbox" hidden><button type="button" aria-pressed="false">Yes</button><button type="button" aria-pressed="false">No</button></div></div><button id="submit">Submit</button></form>',{runScripts:'outside-only'}),w=dom.window;
 w.document.querySelector('label').textContent=question;
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent}});
 w.HTMLElement.prototype.getBoundingClientRect=function(){return {width:this.hidden?0:100,height:this.hidden?0:20}};
 const group=w.document.querySelector('.ashby-application-form-input-yesno'),buttons=[...group.querySelectorAll('button')];let clicks=0,reads=0;
 function choose(index){buttons.forEach((b,i)=>b.setAttribute('aria-pressed',String(i===index)));group.querySelector('input').checked=index===0;}
 if(selected!==null)choose(selected);buttons.forEach(b=>{b.disabled=disabled});
 const optionLocator={evaluateAll:async fn=>{reads++;if(change&&reads===2)choose(0);return w.eval('('+fn.toString()+')')(buttons)},nth:index=>({click:async()=>{clicks++;choose(index)}})};
 const wrapper={evaluate:async fn=>w.eval('('+fn.toString()+')')(group),locator:()=>optionLocator};
 const page={locator:selector=>{assert.equal(selector,'.ashby-application-form-input-yesno:visible');return {count:async()=>1,nth:()=>wrapper}}};
 return {dom,w,page,clicks:()=>clicks,state:()=>w.eval('('+hostedFormState.toString()+')')()};
}
test('Ashby No is selected from an approved fact and counts as filled without submitting',async()=>{
 const q='Will you now or in the future require sponsorship for employment visa status in this country?',p={answers_json:JSON.stringify({[K.canadaSponsorship]:'No'})};
 p.employment_context=employmentContext(p,{job_metadata_json:'{"location":"Remote, Canada"}'});
 const f=fixture(q);try{assert.equal(f.state().filled,0);assert.equal(await fillHostedButtonGroups(f.page,p),1);assert.equal(f.clicks(),1);assert.equal(f.state().filled,1);assert.deepEqual([...f.state().missing],[]);}finally{f.dom.window.close()}
});
test('answered, disabled, changed, unknown and declaration controls remain untouched',async()=>{
 for(const config of [{selected:0},{disabled:true},{change:true}]){
  const f=fixture('Preferred contact by email?',config);try{assert.equal(await fillHostedButtonGroups(f.page,{}, {'Preferred contact by email?':'No'}),0);assert.equal(f.clicks(),0);}finally{f.dom.window.close()}
 }
 for(const q of ['I accept the terms','Are you authorized to work in Canada?']){
  const f=fixture(q);try{assert.equal(await fillHostedButtonGroups(f.page,{}, {[q]:'Yes'}),0);assert.equal(f.clicks(),0);}finally{f.dom.window.close()}
 }
});

test('confirmed adult answer fills the employer Yes button without treating a declaration as an age question',async()=>{
 const p={answers_json:JSON.stringify({[K.over18]:'Yes'})};p.employment_context=employmentContext(p,{job_metadata_json:'{"location":"Global"}'});
 for(const [question,expected]of [['Are you over the age of 18?',1],['Are you over the age of 18 and do you accept our agreement?',0]]){
  const f=fixture(question);try{assert.equal(await fillHostedButtonGroups(f.page,p),expected);assert.equal(f.clicks(),expected);assert.equal(f.state().filled,expected);}finally{f.dom.window.close();}
 }
});
