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

test('Lever wrapping location labels exclude dynamic suggestions and hidden search hints',()=>{
 const f=fixture('<form><li class="application-question"><label><div class="application-label">Current location <span>✱</span></div><div class="application-field"><input id="location" name="location" class="location-input" required><input type="hidden" name="selectedLocation"><div class="dropdown-container"><div class="dropdown-results"><div class="dropdown-location">Toronto, ON, CAN</div></div><div class="dropdown-no-results">No location found. Try entering a different location</div><div class="dropdown-loading-results">Loading</div></div></div></label></li></form>');
 try{assert.equal(f.read(f.d.getElementById('location')).label,'Current location ✱');assert.deepEqual([...f.read().missing],['Current location ✱']);}finally{f.dom.window.close();}
});

test('optional messaging consent nested under a required phone does not become a missing phone answer',()=>{
 const sms='<div class="ashby-application-form-texting-consent-description"><p>Receive text message updates?</p><label><input type="radio" name="communicationConsent">Yes - I consent to receiving text messages</label><label><input type="radio" name="communicationConsent">No - I do not consent to receiving text messages</label></div>';
 const f=fixture(field('Phone Number','<input id="phone" type="tel" required value="4165550132">'+sms));
 try{
  const state=f.read();assert.equal(state.required,1);assert.equal(state.filled,1);assert.equal(state.missing.length,0);
  const radio=f.d.querySelector('[type=radio]');
  assert.equal(f.read(radio).required,false);assert.match(f.read(radio).label,/consent to receiving text messages/);
  assert.equal(f.d.querySelector('[type=radio]:checked'),null);
  radio.required=true;assert.equal(f.read().required,2);assert.equal(f.read().missing.length,1);
  assert.match(f.read().missing[0],/consent/);
  radio.required=false;radio.setAttribute('aria-required','true');assert.equal(f.read().missing.length,1);
  radio.removeAttribute('aria-required');f.d.querySelector('#phone').value='';assert.deepEqual([...f.read().missing],['Phone Number']);
 }finally{f.dom.window.close();}
});
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
  Object.defineProperty(f.d.querySelector('[type=file]'),'validity',{value:{valid:true}});
  let state=f.read();assert.equal(state.required,7);assert.equal(state.filled,4);assert.deepEqual([...state.missing],['Location','Work authorization','Sponsorship']);
  f.d.querySelector('[role=combobox]').value='Toronto, Ontario, Canada';
  f.d.querySelector('[role=combobox]').dataset.applypilotCommittedValue='Toronto, Ontario, Canada';
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
  assert(f.read().missing.includes('Location'),'raw input text is still not a committed choice');
  combo.dataset.applypilotCommittedValue=combo.value;
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

test('repeated validation never emits invalid events or changes employer form state',()=>{
 const f=fixture('<form><label>Email<input type="email" required value="invalid"></label></form>');
 try{let invalidEvents=0;f.d.querySelector('input').addEventListener('invalid',()=>invalidEvents++);for(let i=0;i<5;i++)assert.equal(f.read().missing.length,1);assert.equal(invalidEvents,0);}finally{f.dom.window.close();}
});

test('visible upload progress holds submission even when the file input has a value',()=>{
 const f=fixture(field('Resume','<input type="file"><div role="progressbar">Uploading</div>'));
 try{assert.equal(f.read().pending,true);f.d.querySelector('[role=progressbar]').hidden=true;assert.equal(f.read().pending,false);}finally{f.dom.window.close();}
});
test('native radio and ARIA radio group completeness is grouped by question',()=>{
 const f=fixture('<fieldset><legend>Schedule</legend><input type="radio" name="schedule" required><input type="radio" name="schedule"></fieldset><div role="radiogroup" aria-required="true" aria-label="Office"><div role="radio" aria-checked="false">A</div><div role="radio" aria-checked="false">B</div></div>');
 try{assert.equal(f.read().required,2);f.d.querySelectorAll('input')[1].checked=true;f.d.querySelector('[role=radio]').setAttribute('aria-checked','true');assert.equal(f.read().filled,2);assert.equal(f.read().missing.length,0);}finally{f.dom.window.close();}
});

test('required native selects reject nonempty and disabled placeholders before final submit',()=>{
 for(const option of ['<option value="placeholder">Select a country</option>','<option value="choose">Choose...</option>','<option value="ca" disabled selected>Canada</option>']){
  const f=fixture('<label for="country">Country</label><select id="country" required>'+option+'<option value="real">Canada</option></select>');
  try{assert.equal(f.read().filled,0);assert.deepEqual([...f.read().missing],['Country']);f.d.querySelector('select').value='real';assert.equal(f.read().filled,1);assert.equal(f.read().missing.length,0);}finally{f.dom.window.close();}
 }
});

test('ARIA required combobox placeholders remain incomplete while genuine selections count',()=>{
 for(const control of ['<div role="combobox" aria-required="true">Select a country</div>','<input role="combobox" aria-required="true" aria-valuetext="Choose...">']){
  const f=fixture(control);try{assert.equal(f.read().filled,0);assert.equal(f.read().missing.length,1);const e=f.d.querySelector('[role=combobox]');e.setAttribute('aria-valuetext','Canada');assert.equal(f.read().filled,1);}finally{f.dom.window.close();}
 }
 const f=fixture('<select required multiple><option value="placeholder" selected>Select a country</option><option value="ca" selected>Canada</option></select><div role="combobox">Select a country</div>');
 try{assert.equal(f.read().filled,1);assert.equal(f.read().missing.length,0);}finally{f.dom.window.close();}
});
