// This function is serialized into the employer page. Keep all DOM helpers
// inside it so field descriptions, final validation and progress agree.
export function hostedFormState(target) {
 const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
 const text=e=>clean(e?.innerText||e?.textContent);
 const labelText=e=>{if(!e)return '';const clone=e.cloneNode(true);clone.querySelectorAll('input,textarea,select,button,[role="option"],script,style').forEach(node=>node.remove());return clean(clone.textContent);};
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'&&!e.closest('[hidden],[aria-hidden="true"]');};
 // Text-message consent is a separate optional question nested inside Ashby's
 // required Phone field. It must not inherit the phone label or required mark.
 // Native/ARIA requirements on the consent controls still count normally.
 const wrapperFor=e=>{const lever=e.closest('.application-question');return lever?.querySelector('.application-label')?lever:e.parentElement?.closest('.ashby-application-form-texting-consent-description,.ashby-application-form-field-entry,.ashby-application-form-input-radio-group,[data-field-entry-id],[data-automation-id*="formField" i],.application-question,fieldset,[role="group"],[role="radiogroup"],[class*="field" i]');};
 const titleFor=e=>{const wrapper=wrapperFor(e);return wrapper?.matches('.application-question')?wrapper.querySelector('.application-label'):wrapper?.querySelector(':scope > .ashby-application-form-question-title,:scope > legend,:scope > label');};
 const ids=value=>clean(value).split(/\s+/).map(id=>labelText(document.getElementById(id))).filter(Boolean).join(' ');
 // React Select (including Greenhouse) clears its search input after choosing
 // an option. Only the selected-value node is a committed answer; data-value
 // on select__input-container is merely the current search query.
 function selectedValue(e){
  const control=e.closest('[class*="select__control"]'),selected=control?.querySelector('[class*="single-value"],[class*="singleValue"]');
  const multiple=[...control?.querySelectorAll('[class*="multi-value__label"],[class*="multiValueLabel"]')||[]].map(text).filter(Boolean);if(multiple.length)return multiple.join('\n');
  const value=clean(text(selected)||e.getAttribute('aria-valuetext')||e.getAttribute('data-value')||(!e.matches('input')?text(e):control?'':e.dataset.applypilotCommittedValue&&e.value===e.dataset.applypilotCommittedValue?e.value:''));
  return /^(?:select|choose)(?:\b|\.{3}|…)/i.test(value)?'':value;
 }
 function leverLocation(e){return e.matches('input.location-input[name="location"]')&&!!e.parentElement?.querySelector('input[type="hidden"][name="selectedLocation"]')&&!!e.parentElement?.querySelector('.dropdown-results');}
 function leverLocationValue(e){
  try{const chosen=JSON.parse(e.parentElement.querySelector('input[name="selectedLocation"]').value),value=clean(e.value);return typeof chosen?.name==='string'&&clean(chosen.name)===value?value:'';}catch{return '';}
 }
 function describe(e){
  const wrapper=wrapperFor(e),title=titleFor(e),explicit=[...e.labels||[]].map(labelText).join(' '),labelled=ids(e.getAttribute('aria-labelledby')),aria=clean(e.getAttribute('aria-label'));
  const choice=e.type==='radio'||e.type==='checkbox'||['radio','checkbox'].includes(e.getAttribute('role'));
  const radio=e.type==='radio'||e.getAttribute('role')==='radio';
  const parentGroup=e.closest('fieldset,[role="group"]'),groupTitle=parentGroup&&(ids(parentGroup.getAttribute('aria-labelledby'))||clean(parentGroup.getAttribute('aria-label'))||labelText(parentGroup.querySelector(':scope > legend')));
  const group=radio?e.closest('fieldset,[role="radiogroup"],[role="group"]'):null;
  const groupQuestion=group&&(ids(group.getAttribute('aria-labelledby'))||clean(group.getAttribute('aria-label'))||labelText(group.querySelector(':scope > legend,:scope > .ashby-application-form-question-title')));
  let context='';if(wrapper){const clone=wrapper.cloneNode(true);clone.querySelectorAll('input,textarea,select,button,[role="option"],script,style').forEach(node=>node.remove());context=text(clone);}
  // Ashby marks required questions on the label, including unlabeled native
  // controls and a No button backed by an unchecked hidden checkbox.
  const ashbyRequired=title?.classList.contains('ashby-application-form-question-title')&&[...title.classList].some(c=>/^_required_/.test(c));
  const question=radio?(groupQuestion||labelText(title)||labelled||explicit||aria||context):(labelled||aria||explicit||labelText(title)||context);
  const requiredMark=/[✱*]\s*$|\(required\)\s*$/i.test(question)||!!title?.querySelector('abbr[title="required" i],[aria-label="required" i]');
  const selectRequired=e.getAttribute('role')==='combobox'&&!!e.closest('.select__container')?.querySelector('input[required]');
  return {label:clean(question).slice(0,4000),optionLabel:choice?clean(labelled||aria||explicit||text(e)):undefined,ariaLabel:aria,description:clean([ids(e.getAttribute('aria-describedby')),groupTitle&&groupTitle!==question?groupTitle:''].filter(Boolean).join(' ')).slice(0,4000),name:e.name||'',id:e.id||'',placeholder:e.placeholder||'',autocomplete:e.autocomplete||'',type:e.type||e.getAttribute('role')||'',...(e.getAttribute('role')==='combobox'?{selectedValue:selectedValue(e),populated:e.dataset.applypilotUncommittedSearch!=='true'&&e.dataset.applypilotIncompleteSelection!=='true'&&!!selectedValue(e)&&!(e.matches('input[aria-autocomplete]')&&e.getAttribute('aria-expanded')==='true'&&!e.getAttribute('aria-valuetext'))}:{}),required:!!(e.required||e.getAttribute('aria-required')==='true'||e.closest('[aria-required="true"]')||ashbyRequired||selectRequired||requiredMark)};
 }
 function descriptor(e){
  const result=describe(e),canonical=value=>clean(value).normalize('NFKC').toLowerCase().replace(/[?*✱]/g,'');
  const question=canonical(result.label||result.ariaLabel);
  result.contextRequired=!!result.description&&/^(?:additional (?:details|information)|details?|please (?:explain|specify|describe)|explain|description|answer|other|tell us more)[.:]?$/i.test(question);
  const peers=question?[...document.querySelectorAll('input:not([type="hidden"]),textarea,select,[role="combobox"],[role="radiogroup"],[role="checkbox"]')].filter(other=>other!==e&&visible(other)).map(describe).filter(other=>canonical(other.label||other.ariaLabel)===question):[];
  result.ambiguous=peers.some(other=>canonical(other.description)!==canonical(result.description));
  return result;
 }
 if(target?.nodeType===1)return descriptor(target);
 const all=[...document.querySelectorAll('input,textarea,select,[role="combobox"],[role="checkbox"],[role="radiogroup"],[role="radio"],[role="textbox"],.ashby-application-form-input-yesno')];
 const groups=new Map();
 for(const e of all){
  if(e.disabled||e.matches(':disabled')||e.closest('[aria-disabled="true"]'))continue;
  const yesno=e.closest('.ashby-application-form-input-yesno');if(yesno&&yesno!==e)continue;
  const role=e.getAttribute('role');if(role==='radio'&&e.closest('[role="radiogroup"]'))continue;
  if(role==='radiogroup'&&e.querySelector('input[type="radio"]'))continue;
  // File pickers may be visually clipped; their visible upload wrapper is
  // the actionable control. Other hidden inputs are not current questions.
  const file=e.type==='file',wrapper=wrapperFor(e),labelledChoice=['radio','checkbox'].includes(e.type)&&[...e.labels||[]].some(visible);
  if(!visible(e)&&!(file&&wrapper&&visible(wrapper))&&!labelledChoice)continue;
  if(e.type==='hidden'||['submit','button','reset'].includes(e.type))continue;
  const descriptor=describe(e),label=descriptor.label||descriptor.ariaLabel||descriptor.name||'Required field';
  // checkValidity() fires invalid events and can mutate React form state.
  // Inspection must be passive, including while diagnosing a previous click.
  const invalid=e.dataset.applypilotIncompleteSelection==='true'||e.getAttribute('aria-invalid')==='true'||[...wrapper?.querySelectorAll('[role="alert"][data-upload-error],.upload-error,.file-upload-error')||[]].some(visible)||(e.willValidate&&e.validity?.valid===false);
  let filled;
  if(yesno)filled=!!e.querySelector('button[aria-pressed="true"]');
  else if(file)filled=!!e.files?.length;
  else if(e.type==='radio')filled=e.name?[...document.querySelectorAll('input[type="radio"]')].some(other=>other.form===e.form&&other.name===e.name&&other.checked):e.checked;
  else if(e.tagName==='SELECT')filled=[...e.selectedOptions||[]].some(option=>!option.disabled&&!option.closest('optgroup[disabled]')&&clean(option.value)&&! /^(?:select|choose)(?:\b|\.{3})/i.test(text(option)));
  else if(e.type==='checkbox')filled=e.checked;
  else if(role==='checkbox'||role==='radio')filled=e.getAttribute('aria-checked')==='true';
  else if(role==='radiogroup')filled=!!e.querySelector('[role="radio"][aria-checked="true"]');
  else if(leverLocation(e))filled=e.dataset.applypilotUncommittedSearch!=='true'&&!!leverLocationValue(e);
  else if(role==='combobox')filled=descriptor.populated;
  else filled=!!clean(e.value||((role==='textbox')?e.textContent:''));
  filled=filled&&!invalid;
  const key=e.type==='radio'&&e.name?'radio:'+e.name+':'+[...document.forms].indexOf(e.form):e;
  const old=groups.get(key);
  groups.set(key,{label,identity:descriptor.id||descriptor.name||String(all.indexOf(e)),type:descriptor.type,required:descriptor.required||!!old?.required,filled:!!filled&&old?.filled!==false,invalid:invalid||!!old?.invalid});
 }
 const fields=[...groups.values()];
 let captcha=[...document.querySelectorAll('iframe[src*="captcha"],iframe[title*="challenge" i],.g-recaptcha,.h-captcha')].some(visible);
 if([...document.querySelectorAll('[name="g-recaptcha-response"],[name="h-captcha-response"]')].some(e=>e.value?.trim()))captcha=false;
 const pending=[...document.querySelectorAll('form[aria-busy="true"],input[aria-busy="true"],textarea[aria-busy="true"],select[aria-busy="true"],[role="form"][aria-busy="true"],.ashby-application-form-field-entry [aria-busy="true"],.ashby-application-form-field-entry [role="progressbar"],form [role="progressbar"],form [aria-busy="true"],form progress,[role="form"] [role="progressbar"],fieldset [aria-busy="true"],.application-question [aria-busy="true"]')].some(visible);
 const signature=JSON.stringify(fields.map(f=>[f.identity,f.label,f.type,f.required,f.filled,f.invalid]));
 return {signature,questions:fields.map(f=>f.label),captcha,signIn:[...document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"]')].some(visible),pending,missing:[...new Set(fields.filter(f=>f.invalid||f.required&&!f.filled).map(f=>f.label))],required:fields.filter(f=>f.required).length,filled:fields.filter(f=>f.required&&f.filled).length};
}
