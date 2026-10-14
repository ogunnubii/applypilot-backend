import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {hostedFormState} from './hosted-form-state.js';
import * as hosted from './hosted-form.js';
import {fillHostedText,typeHostedSearch} from './hosted-input.js';
import {pickResumeField} from './form-policy.js';
import {savedAnswer,savedOptionSelections,sameApplication} from './local-policy.js';
import {resolveResumePath} from './storage-paths.js';

const worker=readFileSync(new URL('./worker.js',import.meta.url),'utf8');
const source=worker.slice(worker.indexOf('async function fieldDescriptor('),worker.indexOf('async function recordFormProgress('));
const helpers=new Function(...Object.keys(hosted),'hostedFormState','fillHostedText','typeHostedSearch','pickResumeField','savedOptionSelections','sameApplication','automaticTextAnswer','prepareHostedDropdown','researchConsentWithdrawn','hasResearchDraftForQuestion','markResearchDraftUsed','fillHostedButtonGroups','event','db','resolveResumePath',source+';return {fill,custom,selections,radios,checkboxes,customControls,attachHostedResume,prepareHostedFields};')(
 ...Object.values(hosted),hostedFormState,fillHostedText,typeHostedSearch,pickResumeField,savedOptionSelections,sameApplication,
 async({question,answers})=>({answer:savedAnswer(question,answers),source:'saved'}),
 async(_db,_j,p,d,options,answers)=>hosted.hostedOptionChoice(d,options,p,answers),()=>false,()=>false,()=>{},async()=>{},()=>{},null,resolveResumePath);

function fixture(html){
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://jobs.lever.co/fixture/role'}),w=dom.window,d=w.document;
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 w.HTMLElement.prototype.getBoundingClientRect=function(){return {width:parseInt(this.style.width)||100,height:parseInt(this.style.height)||20};};
 const evaluate=(fn,e,arg)=>w.eval('('+fn.toString()+')')(e,arg);
 const visible=e=>!e.closest('[hidden],[aria-hidden="true"]')&&w.getComputedStyle(e).display!=='none';
 const find=(root,selector)=>[...root.querySelectorAll(selector.replaceAll(':visible',''))].filter(e=>!selector.includes(':visible')||visible(e));
 let time=0;const timers=[],actions=[];
 const wait=async ms=>{time+=ms;for(let i=0;i<timers.length;i++)if(timers[i].at<=time){const [{fn}]=timers.splice(i--,1);fn();}};
 const after=(ms,fn)=>timers.push({at:time+ms,fn});
 class Locator{
  constructor(resolve){this.resolve=resolve;}
  get elements(){return this.resolve().filter(Boolean);}
  count=async()=>this.elements.length;
  nth=i=>new Locator(()=>[this.elements[i]]);
  locator=selector=>new Locator(()=>this.elements.flatMap(e=>find(e,selector)));
  evaluate=async(fn,arg)=>evaluate(fn,this.elements[0],arg);
  evaluateAll=async(fn,arg)=>evaluate(fn,this.elements,arg);
  inputValue=async()=>this.elements[0].value;
  getAttribute=async attr=>this.elements[0].getAttribute(attr);
  isEditable=async()=>!this.elements[0].disabled&&!this.elements[0].readOnly;
  isChecked=async()=>this.elements[0].checked;
  click=async()=>{actions.push(['click',this.elements[0].id]);this.elements[0].focus();this.elements[0].click();};
  press=async key=>this.elements[0].dispatchEvent(new w.KeyboardEvent('keyup',{key,bubbles:true}));
  pressSequentially=async value=>{const e=this.elements[0];for(const key of value){e.value+=key;e.dispatchEvent(new w.InputEvent('input',{data:key,bubbles:true}));e.dispatchEvent(new w.KeyboardEvent('keyup',{key,bubbles:true}));}actions.push(['type',e.id,value]);};
  fill=async value=>{const e=this.elements[0];e.value=value;e.dispatchEvent(new w.Event('input',{bubbles:true}));actions.push(['fill',e.id,value]);};
  blur=async()=>{const e=this.elements[0];e.dispatchEvent(new w.Event('change',{bubbles:true}));e.blur();};
  selectOption=async value=>{const e=this.elements[0],values=Array.isArray(value)?value:[value];for(const o of e.options)o.selected=values.some(v=>typeof v==='object'?v.index===o.index:v===o.value);e.dispatchEvent(new w.Event('input',{bubbles:true}));e.dispatchEvent(new w.Event('change',{bubbles:true}));actions.push(['select',e.id,values]);};
  check=async()=>{const e=this.elements[0];e.checked=true;e.dispatchEvent(new w.Event('change',{bubbles:true}));actions.push(['check',e.id]);};
  setInputFiles=async path=>{const e=this.elements[0];Object.defineProperty(e,'files',{configurable:true,value:[{name:path.split('/').pop(),size:128}]});Object.defineProperty(e,'validity',{configurable:true,value:{valid:true}});e.dispatchEvent(new w.Event('change',{bubbles:true}));actions.push(['upload',e.id]);};
  page=()=>page;
 }
 const page={locator:selector=>new Locator(()=>find(d,selector)),evaluate:async(fn,arg)=>evaluate(fn,arg),waitForTimeout:wait,waitForFunction:async(fn,arg)=>{for(let i=0;i<20;i++){if(evaluate(fn,arg))return;await wait(250);}throw Error('Fixture condition did not settle');},url:()=>w.location.href};
 const read=()=>evaluate(hostedFormState);
 const profile={name:'Fixture Applicant',email:'fixture@example.test',resume_path:'/synthetic/resume.pdf',answers_json:'{}'};
 const job={id:'fixture',url:page.url(),answers_json:'{}'};
 return {dom,w,d,page,read,profile,job,actions,after,wait,time:()=>time};
}

const use=(html,fn)=>{const f=fixture(html);return Promise.resolve().then(()=>fn(f)).finally(()=>f.dom.window.close());};

test('full accessible question outranks a visual label fragment and specific names outrank a group title',()=>use('<fieldset class="form-field"><legend>Your name</legend><label for="first">First name</label><input id="first" required><label for="last">Last name</label><input id="last" required></fieldset><label id="prefix" for="tools">Which tools</label><span id="suffix">have you used in production?</span><input id="tools" aria-labelledby="prefix suffix" required>',async f=>{
 f.profile.answers_json=JSON.stringify({'Which tools have you used in production?':'Approved fixture tool'});
 await helpers.fill(f.page,f.profile);await helpers.custom(f.page,f.profile,f.job);
 assert.equal(f.d.querySelector('#first').value,'Fixture');assert.equal(f.d.querySelector('#last').value,'Applicant');assert.equal(f.d.querySelector('#tools').value,'Approved fixture tool');assert.equal(f.read().missing.length,0);
}));

test('native grouped radios use complete group question and separate option names',()=>use('<fieldset aria-labelledby="prefix suffix"><span id="prefix">Preferred work</span><span id="suffix">schedule?</span><label><input type="radio" name="schedule" id="remote" required>Remote</label><label><input type="radio" name="schedule" id="hybrid">Hybrid</label></fieldset>',async f=>{
 f.profile.answers_json=JSON.stringify({'Preferred work schedule?':'Hybrid'});await helpers.radios(f.page,f.profile,f.job);
 assert.equal(f.d.querySelector('#hybrid').checked,true);assert.equal(f.d.querySelector('#remote').checked,false);assert.equal(f.read().missing.length,0);
}));

test('native multi-select fills exactly all approved options atomically and preserves existing selections',()=>use('<label for="tools">Tools used</label><select id="tools" multiple required><option value="git">Git</option><option value="sql">SQL</option><option value="go">Go</option></select>',async f=>{
 f.profile.answers_json=JSON.stringify({'Tools used':'["Git","SQL"]'});await helpers.selections(f.page,f.profile,f.job);
 assert.deepEqual([...f.d.querySelector('#tools').selectedOptions].map(o=>o.value),['git','sql']);assert.equal(f.read().missing.length,0);
 f.profile.answers_json=JSON.stringify({'Tools used':'Go'});await helpers.selections(f.page,f.profile,f.job);assert.deepEqual([...f.d.querySelector('#tools').selectedOptions].map(o=>o.value),['git','sql']);
}));

test('unknown, duplicate, disabled and protected multi-selection answers leave the whole question empty',async()=>{
 for(const [label,answer,options] of [['Tools used','Git\nUnknown','<option>Git</option>'],['Tools used','Git','<option>Git</option><option>Git</option>'],['Tools used','Git','<optgroup disabled label="Unavailable"><option>Git</option></optgroup>'],['I agree to these terms','First','<option>First</option>']])await use(`<label for="multi">${label}</label><select id="multi" multiple required>${options}</select>`,async f=>{
  f.profile.answers_json=JSON.stringify({[label]:answer});await helpers.selections(f.page,f.profile,f.job);assert.equal(f.d.querySelector('#multi').selectedOptions.length,0);assert.equal(f.actions.length,0);
 });
});

test('employer-reverted single and multiple selections cannot count as successful fills',async()=>{
 for(const multiple of ['', ' multiple'])await use(`<label for="office">Preferred office</label><select id="office" required${multiple}><option value="">Choose</option><option value="toronto">Toronto</option></select>`,async f=>{
  f.d.querySelector('#office').addEventListener('change',e=>{e.target.value='';});f.profile.answers_json=JSON.stringify({'Preferred office':'Toronto'});
  await assert.rejects(helpers.selections(f.page,f.profile,f.job),{code:'HOSTED_INPUT_NOT_RETAINED'});assert.equal(f.read().missing.length,1);
 });
});

test('exact ISO dates use native date commit and reject guessed, invalid, out-of-range and prefilled dates',async()=>{
 for(const [answer,expected] of [['2026-11-01','2026-11-01'],['11/01/2026',''],['Immediately',''],['2026-02-31',''],['2027-01-01','']])await use('<label>Available to start<input id="date" type="date" min="2026-01-01" max="2026-12-31" required></label>',async f=>{
  assert.equal(await fillHostedText(f.page.locator('#date'),answer,{kind:'employment'}),!!expected);assert.equal(f.d.querySelector('#date').value,expected);
 });
 await use('<input id="date" type="date" value="2026-10-31">',async f=>{assert.equal(await fillHostedText(f.page.locator('#date'),'2026-11-01'),false);assert.equal(f.d.querySelector('#date').value,'2026-10-31');});
});

test('conditional rescans fill delayed required fields and wait through upload completion without repeating the attachment',()=>use('<form><label>Email<input id="email" type="email" required></label><div class="upload-field"><label for="resume">Resume</label><input type="file" id="resume" required></div><div id="conditional"></div><button id="submit">Submit application</button></form>',async f=>{
 let added=false;f.d.querySelector('#email').addEventListener('change',()=>{if(added)return;added=true;f.after(500,()=>{f.d.querySelector('#conditional').innerHTML='<label for="portfolio">Website</label><input id="portfolio" type="url" required>';});});
 f.d.querySelector('#resume').addEventListener('change',()=>{const progress=f.d.createElement('div');progress.setAttribute('role','progressbar');progress.textContent='Uploading';f.d.querySelector('form').append(progress);f.after(1000,()=>progress.remove());});
 f.profile.answers_json=JSON.stringify({Website:'https://example.test/portfolio'});
 const result=await helpers.prepareHostedFields(f.page,f.profile,f.job,f.wait);
 assert.equal(f.d.querySelector('#portfolio').value,'https://example.test/portfolio');assert.equal(result.check.missing.length,0);assert.equal(result.check.pending,false);
 assert.equal(f.actions.filter(a=>a[0]==='upload').length,1);assert(!f.actions.some(a=>a[1]==='submit'));assert(f.time()>=3000);
}));

test('unknown required facts and persistent generic upload progress remain explicit blockers',async()=>{
 await use('<form><label>Unverified experience<input id="unknown" required></label><div aria-busy="true">Uploading file</div><button id="submit">Submit</button></form>',async f=>{
  const result=await helpers.prepareHostedFields(f.page,f.profile,f.job,f.wait);assert.equal(result.check.pending,true);assert.deepEqual([...result.check.missing],['Unverified experience']);assert.equal(f.d.querySelector('#unknown').value,'');assert.equal(f.actions.length,0);
 });
});

test('upload preparation preserves applicant files, ignores hidden future steps, and reports failed attachment retention',async()=>{
 await use('<form><section hidden><label>Resume<input type="file" id="future"></label></section><div class="field"><label>Resume<input type="file" id="resume"></label></div></form>',async f=>{
  Object.defineProperty(f.d.querySelector('#resume'),'files',{value:[{name:'applicant-edit.pdf',size:500}]});assert.equal((await helpers.attachHostedResume(f.page,f.profile)).attached,false);assert.equal(f.actions.length,0);
 });
 await use('<form><label>Resume<input type="file" id="resume" required></label></form>',async f=>{
  f.d.querySelector('#resume').addEventListener('change',e=>Object.defineProperty(e.target,'files',{value:[]}));assert.match((await helpers.attachHostedResume(f.page,f.profile)).issue,/did not retain/);
  assert.equal((await helpers.attachHostedResume(f.page,f.profile)).attached,false);assert.equal(f.actions.filter(a=>a[0]==='upload').length,1);
 });
});

test('generic required annotations and selected React multivalue chips count without using the typed search query',()=>use('<form><label for="name">Full name *</label><input id="name"><label for="skills">Skills *</label><div class="select__control"><span class="select__multi-value__label">Git</span><span class="select__multi-value__label">SQL</span><input id="skills" role="combobox"></div></form>',async f=>{
 assert.equal(f.read().required,2);assert.equal(f.read().filled,1);assert.deepEqual([...f.read().missing],['Full name *']);
 f.d.querySelector('#skills').dataset.applypilotUncommittedSearch='true';assert.equal(f.read().filled,0);
}));

test('individual checkboxes keep their own labels rather than borrowing a shared fieldset title',()=>use('<fieldset><legend>Contact preferences</legend><label><input id="updates" type="checkbox">Email me job updates</label><label><input id="sms" type="checkbox">Text message consent</label></fieldset>',async f=>{
 f.profile.answers_json=JSON.stringify({'Contact preferences':'Yes','Email me job updates':'Yes'});await helpers.checkboxes(f.page,f.profile,f.job);
 assert.equal(f.d.querySelector('#updates').checked,true);assert.equal(f.d.querySelector('#sms').checked,false);
}));

test('a required visually hidden choice with a visible label cannot disappear from readiness',()=>use('<form><label><input id="consent" type="checkbox" required style="display:none">I agree to the terms</label><label><input type="radio" name="work" required style="display:none">Remote</label><label><input type="radio" name="work" style="display:none">Hybrid</label></form>',async f=>{
 assert.equal(f.read().required,2);assert.equal(f.read().filled,0);assert.equal(f.read().missing.length,2);
}));

test('duplicate HTML values cannot select the wrong offered label',async()=>{
 for(const multiple of ['', ' multiple'])await use(`<label for="tool">Tool used</label><select id="tool"${multiple}><option value="">Choose</option><option value="tool">Terraform</option><option value="tool">Argo CD</option></select>`,async f=>{
  f.profile.answers_json=JSON.stringify({'Tool used':'Argo CD'});await helpers.selections(f.page,f.profile,f.job);assert.deepEqual([...f.d.querySelector('#tool').selectedOptions].map(o=>[o.index,o.textContent]),[[2,'Argo CD']]);
 });
});

test('closed combobox raw text is incomplete until an exact option click is verified, and edits invalidate the marker',()=>use('<label>Current location<input id="location" role="combobox" required aria-expanded="false" value="Toron"></label>',async f=>{
 assert.equal(f.read().filled,0);f.d.querySelector('#location').dataset.applypilotCommittedValue='Toronto';assert.equal(f.read().filled,0);
 f.d.querySelector('#location').value='Toronto';assert.equal(f.read().filled,1);f.d.querySelector('#location').value='Toron';assert.equal(f.read().filled,0);
}));

test('unsupported custom multi-selects never make a partial choice or call a partial saved set ready',async()=>{
 for(const chip of ['', '<span class="select__multi-value__label">Git</span>'])await use(`<label for="tools">Tools used</label><div class="select__control">${chip}<input id="tools" role="combobox" required></div>`,async f=>{
  f.profile.answers_json=JSON.stringify({'Tools used':'["Git","SQL"]'});const result=await helpers.customControls(f.page,f.profile,f.job);assert.equal(f.actions.length,0);assert.deepEqual(result.unresolved,['Tools used']);assert.equal(f.read().filled,0);assert.deepEqual([...f.read().missing],['Tools used']);
 });
});

test('protected field help prevents generic radio and checkbox answer reuse',()=>use('<fieldset><legend>Answer</legend><span id="help">I consent to a background check</span><label><input type="radio" id="yes" name="answer" aria-describedby="help">Yes</label><label><input type="radio" name="answer" aria-describedby="help">No</label></fieldset><label>Choice<input id="check" type="checkbox" aria-describedby="help"></label>',async f=>{
 f.profile.answers_json=JSON.stringify({Answer:'Yes',Choice:'Yes'});await helpers.radios(f.page,f.profile,f.job);await helpers.checkboxes(f.page,f.profile,f.job);assert.equal(f.actions.length,0);assert.equal(f.d.querySelector('#yes').checked,false);assert.equal(f.d.querySelector('#check').checked,false);
}));

test('specific contact labels retain third-party group context and cannot copy applicant identity into a reference',()=>use('<fieldset><legend>Supervisor contact</legend><label for="name">Name</label><input id="name"><label for="email">Email</label><input id="email" type="email"></fieldset>',async f=>{
 await helpers.fill(f.page,f.profile);assert.equal(f.actions.length,0);assert.equal(f.d.querySelector('#name').value,'');assert.equal(f.d.querySelector('#email').value,'');
}));

test('wrapping labels exclude nested dropdown options and textarea answers from the question',()=>use('<label>Which tools?<select id="tools" multiple required><option>Git</option><option>SQL</option></select></label><label>Professional summary<textarea id="summary">Existing applicant text</textarea></label>',async f=>{
 f.profile.answers_json=JSON.stringify({'Which tools?':'["Git","SQL"]'});await helpers.selections(f.page,f.profile,f.job);assert.equal(f.d.querySelector('#tools').selectedOptions.length,2);
 const description=await f.page.locator('#summary').evaluate(hostedFormState);assert.equal(description.label,'Professional summary');assert.equal(f.d.querySelector('#summary').value,'Existing applicant text');
}));

test('same question with different help and generic context-only labels cannot reuse a question-only saved answer',()=>use('<label>Tools used<input id="tools1" aria-describedby="one" required></label><p id="one">For a commercial project</p><label>Tools used<input id="tools2" aria-describedby="two" required></label><p id="two">For a hobby project</p><label>Additional details<input id="details" aria-describedby="details-help" required></label><p id="details-help">Describe production leadership experience</p>',async f=>{
 f.profile.answers_json=JSON.stringify({'Tools used':'Git','Additional details':'Old unrelated explanation'});const result=await helpers.custom(f.page,f.profile,f.job);assert.equal(f.actions.length,0);assert.deepEqual(result.unresolved,['Tools used','Tools used','Additional details']);assert.equal(f.read().filled,0);
}));

test('answer capture retains complete accessible labels and all multiselect selections, never a search query',()=>use('<label id="prefix" for="tools">Which tools</label><span id="suffix">have you used?</span><select id="tools" aria-labelledby="prefix suffix" multiple><option selected>Git</option><option selected>SQL</option></select><label>Current location<input role="combobox" value="Uncommitted text"></label><label>Summary<textarea>Approved text</textarea></label>',async f=>{
 const source=worker.slice(worker.indexOf('async function rememberForm('),worker.indexOf('\nasync function humanPause('));let captured;
 const remember=new Function('fieldDescriptor','protectedHostedQuestion','captureAnswers','hasResearchDraftForQuestion','db',source+';return rememberForm;')(l=>l.evaluate(hostedFormState),hosted.protectedHostedQuestion,(_db,_job,fields)=>{captured=fields;},()=>false,null);
 await remember(f.page,f.job);assert.deepEqual(captured,[{question:'Which tools have you used?',answer:'["Git","SQL"]'},{question:'Summary',answer:'Approved text'}]);
}));

test('generic exact option clicks commit a marker only after readback; ignored clicks stay missing',async()=>{
 for(const ignored of [false,true])await use('<label>Location<input id="location" role="combobox" aria-controls="cities" aria-expanded="false" required></label><div id="cities" role="listbox" hidden><div role="option">Toronto, Ontario, Canada</div></div>',async f=>{
  const input=f.d.querySelector('#location'),list=f.d.querySelector('#cities');input.addEventListener('click',()=>{list.hidden=false;input.setAttribute('aria-expanded','true');});
  list.firstChild.addEventListener('click',()=>{if(ignored)return;input.value='Toronto, Ontario, Canada';input.setAttribute('aria-expanded','false');list.hidden=true;});
  f.profile.location='Toronto, Ontario, Canada';const result=await helpers.customControls(f.page,f.profile,f.job);
  assert.equal(input.dataset.applypilotCommittedValue,ignored?undefined:f.profile.location);assert.equal(f.read().missing.length,ignored?1:0);assert.deepEqual(result.unresolved,ignored?['Location']:[]);
 });
});

test('hosted numeric custom fields request numeric validation and leave prose saved answers unresolved',()=>use('<label>Years of relevant experience<input id="years" type="number" required></label>',async f=>{
 const {automaticTextAnswer}=await import('./automatic-answer.js');
 const code=worker.slice(worker.indexOf('async function custom(page,p,j)'),worker.indexOf('\nasync function selections('));let received;
 const custom=new Function('hostedFieldKind','hostedFieldAnswer','protectedHostedQuestion','fillHostedText','automaticTextAnswer','fieldDescriptor','event','authorizeResearchFill','db',code+';return custom;')(
  hosted.hostedFieldKind,hosted.hostedFieldAnswer,hosted.protectedHostedQuestion,fillHostedText,async input=>{received=input;return automaticTextAnswer(input);},l=>l.evaluate(hostedFormState),()=>{},()=>true,null);
 f.profile.answers_json=JSON.stringify({'Years of relevant experience':'Seven years'});
 const result=await custom(f.page,f.profile,f.job);assert.equal(received.answerFormat,'number');assert.equal(f.d.querySelector('#years').value,'');assert.equal(f.actions.length,0);assert.deepEqual(result.unresolved,['Years of relevant experience']);
}));
