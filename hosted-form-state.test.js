import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {hostedFormState} from './hosted-form-state.js';

// Synthetic fixture reproducing Ashby's label-only required markers and
// custom control structure observed during the hosted application test.
const title=label=>`<label class="ashby-application-form-question-title _required_fixture_91">${label}</label>`;
const field=(label,control)=>`<div class="ashby-application-form-field-entry">${title(label)}${control}</div>`;
const html='<form>'+field('Name','<input required>')+field('Phone','<input type="tel" required>')+field('Email','<input type="email" required>')+
 field('Location','<input role="combobox" aria-autocomplete="list" aria-expanded="false" placeholder="Start typing...">')+
 field('Resume','<input type="file" required style="width:1px;height:1px">')+
 `<div><fieldset class="ashby-application-form-input-radio-group">${title('Work authorization')}<label><input type="radio" name="auth">Yes</label><label><input type="radio" name="auth">No</label></fieldset></div>`+
 field('Sponsorship','<div class="ashby-application-form-input-yesno"><button aria-pressed="false" data-option="yes">Yes</button><button aria-pressed="false" data-option="no">No</button><input type="checkbox" tabindex="-1" style="display:none"></div>')+
 '<label>LinkedIn<input id="linkedin"></label><input type="file" style="display:none"><input required disabled></form>';
function fixture(markup=html){
 const dom=new JSDOM(markup,{runScripts:'outside-only'}),w=dom.window;
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 w.HTMLElement.prototype.getBoundingClientRect=function(){return {width:parseInt(this.style.width)||100,height:parseInt(this.style.height)||20};};
 const read=w.eval('('+hostedFormState.toString()+')');
 return {dom,w,read,d:w.document};
}
test('label-only required questions count once, including clipped resume and custom No choice',()=>{
 const f=fixture();try{
  const state=f.read();assert.equal(state.required,7);assert.equal(state.filled,0);
  assert.deepEqual([...state.missing],['Name','Phone','Email','Location','Resume','Work authorization','Sponsorship']);
  const combo=f.d.querySelector('[role=combobox]');assert.equal(f.read(combo).label,'Location');assert.equal(f.read(combo).required,true);
  assert.equal(f.read(f.d.querySelector('[type=radio]')).label,'Work authorization');
  assert.equal(f.read(f.d.querySelector('#linkedin')).required,false);
 }finally{f.dom.window.close();}
});
test('four contact/upload values cannot hide the three missing custom questions',()=>{
 const f=fixture();try{
  const inputs=f.d.querySelectorAll('input');inputs[0].value='Fixture Applicant';inputs[1].value='4165550132';inputs[2].value='fixture@example.test';
  Object.defineProperty(f.d.querySelector('[type=file]'),'files',{value:[{name:'fixture.pdf'}]});
  // jsdom's native validity uses its private FileList, not the fixture's files getter.
  f.d.querySelector('[type=file]').checkValidity=()=>true;
  let state=f.read();assert.equal(state.required,7);assert.equal(state.filled,4);assert.deepEqual([...state.missing],['Location','Work authorization','Sponsorship']);
  f.d.querySelector('[role=combobox]').value='Toronto, Ontario, Canada';
  f.d.querySelector('[type=radio]').checked=true;
  f.d.querySelector('[data-option=no]').setAttribute('aria-pressed','true');
  assert.equal(f.d.querySelector('[type=checkbox]').checked,false,'No legitimately leaves the hidden checkbox unchecked');
  state=f.read();assert.equal(state.filled,7);assert.equal(state.missing.length,0);
 }finally{f.dom.window.close();}
});
test('uncommitted autocomplete query remains missing even though text is visible',()=>{
 const f=fixture();try{
  const combo=f.d.querySelector('[role=combobox]');combo.value='Toronto';combo.dataset.applypilotUncommittedSearch='true';
  assert(f.read().missing.includes('Location'));
  combo.value='Toronto, Ontario, Canada';delete combo.dataset.applypilotUncommittedSearch;
  assert(!f.read().missing.includes('Location'));
 }finally{f.dom.window.close();}
});
test('hidden steps, optional fields and disabled native controls do not inflate completion',()=>{
 const f=fixture('<section hidden>'+field('Future question','<input required>')+'</section><fieldset disabled>'+field('Disabled','<input required>')+'</fieldset><input type="hidden" required><label>Optional<input></label>');
 try{assert.equal(f.read().required,0);assert.equal(f.read().missing.length,0);}finally{f.dom.window.close();}
});
test('native invalid values and framework errors stay blockers after required fields are populated',()=>{
 const f=fixture('<label>Optional email<input type="email" value="invalid"></label>'+field('Name','<input value="Fixture" aria-invalid="true">'));
 try{assert.deepEqual([...f.read().missing],['Optional email','Name']);assert.equal(f.read().filled,0);}finally{f.dom.window.close();}
});
test('native radio and ARIA radio group completeness is grouped by question',()=>{
 const f=fixture('<fieldset><legend>Schedule</legend><input type="radio" name="schedule" required><input type="radio" name="schedule"></fieldset><div role="radiogroup" aria-required="true" aria-label="Office"><div role="radio" aria-checked="false">A</div><div role="radio" aria-checked="false">B</div></div>');
 try{assert.equal(f.read().required,2);f.d.querySelectorAll('input')[1].checked=true;f.d.querySelector('[role=radio]').setAttribute('aria-checked','true');assert.equal(f.read().filled,2);assert.equal(f.read().missing.length,0);}finally{f.dom.window.close();}
});
