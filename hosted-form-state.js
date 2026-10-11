// This function is serialized into the employer page. Keep all DOM helpers
// inside it so field descriptions, final validation and progress agree.
export function hostedFormState(target) {
 const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
 const text=e=>clean(e?.innerText||e?.textContent);
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'&&!e.closest('[hidden],[aria-hidden="true"]');};
 const wrapperFor=e=>e.closest('.ashby-application-form-field-entry,.ashby-application-form-input-radio-group,[data-field-entry-id],[data-automation-id*="formField" i],.application-question,fieldset,[role="group"],[class*="field" i]');
 const titleFor=e=>wrapperFor(e)?.querySelector(':scope > .ashby-application-form-question-title,:scope > legend,:scope > label');
 const ids=value=>clean(value).split(/\s+/).map(id=>text(document.getElementById(id))).filter(Boolean).join(' ');
 function describe(e){
  const wrapper=wrapperFor(e),title=titleFor(e),explicit=[...e.labels||[]].map(text).join(' ');
  let context='';if(wrapper){const clone=wrapper.cloneNode(true);clone.querySelectorAll('input,textarea,select,button,[role="option"],script,style').forEach(node=>node.remove());context=text(clone);}
  // Ashby marks required questions on the label, including unlabeled native
  // controls and a No button backed by an unchecked hidden checkbox.
  const ashbyRequired=title?.classList.contains('ashby-application-form-question-title')&&[...title.classList].some(c=>/^_required_/.test(c));
  const question=text(title)||explicit||ids(e.getAttribute('aria-labelledby'))||context;
  return {label:clean(question).slice(0,4000),ariaLabel:clean(e.getAttribute('aria-label')),description:ids(e.getAttribute('aria-describedby')).slice(0,4000),name:e.name||'',id:e.id||'',placeholder:e.placeholder||'',autocomplete:e.autocomplete||'',type:e.type||e.getAttribute('role')||'',required:!!(e.required||e.getAttribute('aria-required')==='true'||e.closest('[aria-required="true"]')||ashbyRequired)};
 }
 if(target?.nodeType===1)return describe(target);
 const all=[...document.querySelectorAll('input,textarea,select,[role="combobox"],[role="checkbox"],[role="radiogroup"],[role="radio"],[role="textbox"],.ashby-application-form-input-yesno')];
 const groups=new Map();
 for(const e of all){
  if(e.disabled||e.matches(':disabled')||e.getAttribute('aria-disabled')==='true')continue;
  const yesno=e.closest('.ashby-application-form-input-yesno');if(yesno&&yesno!==e)continue;
  const role=e.getAttribute('role');if(role==='radio'&&e.closest('[role="radiogroup"]'))continue;
  if(role==='radiogroup'&&e.querySelector('input[type="radio"]'))continue;
  // File pickers may be visually clipped; their visible upload wrapper is
  // the actionable control. Other hidden inputs are not current questions.
  const file=e.type==='file',wrapper=wrapperFor(e);
  if(!visible(e)&&!(file&&wrapper&&visible(wrapper)))continue;
  if(e.type==='hidden'||['submit','button','reset'].includes(e.type))continue;
  const descriptor=describe(e),label=descriptor.label||descriptor.ariaLabel||descriptor.name||'Required field';
  // checkValidity() fires invalid events and can mutate React form state.
  // Inspection must be passive, including while diagnosing a previous click.
  const invalid=e.getAttribute('aria-invalid')==='true'||(e.willValidate&&e.validity?.valid===false);
  let filled;
  if(yesno)filled=!!e.querySelector('button[aria-pressed="true"]');
  else if(file)filled=!!e.files?.length;
  else if(e.type==='radio')filled=[...document.querySelectorAll('input[type="radio"]')].some(other=>other.form===e.form&&other.name===e.name&&other.checked);
  else if(e.tagName==='SELECT')filled=[...e.selectedOptions||[]].some(option=>!option.disabled&&clean(option.value)&&! /^(?:select|choose)(?:\b|\.{3})/i.test(text(option)));
  else if(e.type==='checkbox')filled=e.checked;
  else if(role==='checkbox'||role==='radio')filled=e.getAttribute('aria-checked')==='true';
  else if(role==='radiogroup')filled=!!e.querySelector('[role="radio"][aria-checked="true"]');
  else if(role==='combobox'){const value=clean(e.value||e.getAttribute('aria-valuetext')||e.getAttribute('data-value')||(!e.matches('input')?e.textContent:''));filled=e.dataset.applypilotUncommittedSearch!=='true'&&!!value&&!/^(?:select|choose)(?:\b|\.{3})/i.test(value);}
  else filled=!!clean(e.value||((role==='textbox')?e.textContent:''));
  filled=filled&&!invalid;
  const key=e.type==='radio'&&e.name?'radio:'+e.name+':'+[...document.forms].indexOf(e.form):e;
  const old=groups.get(key);
  groups.set(key,{label,required:descriptor.required||!!old?.required,filled:!!filled&&old?.filled!==false,invalid:invalid||!!old?.invalid});
 }
 const fields=[...groups.values()];
 let captcha=[...document.querySelectorAll('iframe[src*="captcha"],iframe[title*="challenge" i],.g-recaptcha,.h-captcha')].some(visible);
 if([...document.querySelectorAll('[name="g-recaptcha-response"],[name="h-captcha-response"]')].some(e=>e.value?.trim()))captcha=false;
 const pending=[...document.querySelectorAll('form[aria-busy="true"],input[aria-busy="true"],textarea[aria-busy="true"],select[aria-busy="true"],[role="form"][aria-busy="true"],.ashby-application-form-field-entry [aria-busy="true"],.ashby-application-form-field-entry [role="progressbar"]')].some(visible);
 return {captcha,signIn:[...document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"]')].some(visible),pending,missing:[...new Set(fields.filter(f=>f.invalid||f.required&&!f.filled).map(f=>f.label))],required:fields.filter(f=>f.required).length,filled:fields.filter(f=>f.required&&f.filled).length};
}
