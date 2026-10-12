// Some employer forms commit their model on keyboard events or blur. A visible
// value alone is not evidence that the application model received that value.
// Use real Playwright keyboard input from an empty control, then commit focus.
// Never repair a value by deleting/re-appending a character or overwrite a
// populated field: it may contain an applicant edit or employer autofill.
const TEXT_TYPES=new Set(['text','email','tel','url','search','number','textarea','date']);

// Lever's location search is a plain text input, not an ARIA combobox. Blur
// clears an unselected query. Only the employer's option handler may populate
// selectedLocation; never manufacture that payload or accept a query as proof.
async function fillLeverLocation(locator,value){
 const clean=value=>String(value||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
 const untouched=()=>locator.evaluate(e=>!e.parentElement.querySelector('input[name="selectedLocation"]').value&&(!e.value||e.dataset.applypilotUncommittedSearch==='true'));
 if(!await locator.isEditable()||!await untouched())return false;
 const prior=await locator.inputValue();if(prior&&prior!==value)return false;
 if(!prior){
  await locator.click();if(!await untouched()||await locator.inputValue()!=='')return false;
  await locator.evaluate(e=>e.dataset.applypilotUncommittedSearch='true');
  await locator.pressSequentially(value,{delay:8,timeout:Math.min(60000,Math.max(5000,value.length*30+2000))});
 }
 if(await locator.inputValue()!==value)return false;
 const options=locator.locator('..').locator('.dropdown-results .dropdown-location:visible');
 let choice=null;
 for(let retry=0;retry<20;retry++){
  const labels=await options.allTextContents(),matches=labels.map((label,index)=>({label,index})).filter(o=>clean(o.label)===clean(value));
  if(matches.length>1)return false;
  if(matches.length===1){choice=matches[0];break;}
  await locator.page().waitForTimeout(250);
 }
 if(!choice||!await untouched()||await locator.inputValue()!==value)return false;
 const current=await options.allTextContents();
 if(current.filter(label=>clean(label)===clean(value)).length!==1||current[choice.index]!==choice.label)return false;
 await options.nth(choice.index).click();await locator.blur();await locator.page().waitForTimeout(150);
 const retained=await locator.evaluate(e=>{try{const chosen=JSON.parse(e.parentElement.querySelector('input[name="selectedLocation"]').value);return {name:chosen?.name,value:e.value};}catch{return null;}});
 if(!retained||clean(retained.name)!==clean(value)||clean(retained.value)!==clean(value)){
  const error=Error('The employer form did not retain the selected current location. Review that field before continuing.');error.code='HOSTED_INPUT_NOT_RETAINED';throw error;
 }
 await locator.evaluate(e=>delete e.dataset.applypilotUncommittedSearch);
 return true;
}

// A searchable combobox must keep focus while its remote suggestions load.
// The query is preparation, not a selected answer, until the exact option is
// clicked. Final review treats this marker as incomplete if selection fails.
export async function typeHostedSearch(locator,answer){
 const value=String(answer??'');
 if(!value||!await locator.evaluate(e=>e.matches('input[role="combobox"]')&&['text','search'].includes(e.type)))return false;
 if(!await locator.isEditable())return false;
 if(await locator.inputValue()!==''){
  // Resume only our own uncommitted, unchanged search. Never rewrite a
  // selected value or a user's edit while waiting for remote suggestions.
  return await locator.inputValue()===value&&await locator.evaluate(e=>e.dataset.applypilotUncommittedSearch==='true');
 }
 await locator.click();
 if(!await locator.isEditable()||await locator.inputValue()!=='')return false;
 await locator.evaluate(e=>e.dataset.applypilotUncommittedSearch='true');
 await locator.pressSequentially(value,{delay:8,timeout:Math.min(60000,Math.max(5000,value.length*30+2000))});
 return await locator.inputValue()===value;
}

export function sameHostedInputValue(actual,expected,{type,kind}={}){
 const normalize=value=>String(value).replace(/\r\n/g,'\n');
 if(normalize(actual)===normalize(expected))return true;
 // Permit only presentation punctuation added by a telephone mask. Keep every
 // digit, the international + prefix, extensions and other content significant.
 if(type==='tel'||kind==='phone'){
  const phone=value=>normalize(value).replace(/[\s().-]/g,'');
  return phone(actual)===phone(expected);
 }
 return false;
}

export async function fillHostedText(locator,answer,{kind}={}){
 const value=String(answer??'');
 if(value&&await locator.evaluate(e=>e.matches('input.location-input[name="location"]')&&!!e.parentElement?.querySelector('input[type="hidden"][name="selectedLocation"]')&&!!e.parentElement?.querySelector('.dropdown-results'))){
  // Only a saved current-location fact can drive a location search.
  return kind==='location'?fillLeverLocation(locator,value):false;
 }
 if(!value||!await locator.isEditable()||await locator.inputValue()!=='')return false;
 // Ashby renders dates as text inputs backed by a calendar. The word
 // Immediately is not a date: select its explicit Today option instead.
 if(kind==='employment'&&await locator.evaluate(e=>e.classList.contains('ashby-application-form-input-date'))){
  if(!/^immediately$/i.test(value.trim()))return false;
  await locator.click();
  if(await locator.inputValue()!=='')return false;
  const today=locator.page().locator('.react-datepicker:visible [role="option"][aria-current="date"]:not([aria-disabled="true"]):visible');
  if(await today.count()!==1)return false;
  await today.click();await locator.blur();await locator.page().waitForTimeout(150);
  return !!await locator.inputValue();
 }
 const type=await locator.evaluate(e=>e.tagName==='TEXTAREA'?'textarea':e.type);
 if(!TEXT_TYPES.has(type))return false;
 // Native date controls accept ISO dates. Do not interpret locale-dependent
 // strings, durations, or availability wording as a calendar date.
 if(type==='date'){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.slice(0,4)==='0000')return false;
  const date=new Date(value+'T00:00:00Z');if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)return false;
  if(!await locator.evaluate((e,v)=>(!e.min||v>=e.min)&&(!e.max||v<=e.max),value))return false;
 }
 // click() retains Playwright's visibility/overlay/actionability checks, which
 // focus()/pressSequentially() alone do not provide.
 await locator.click();
 if(!await locator.isEditable()||await locator.inputValue()!=='')return false;
 if(type==='date')await locator.fill(value);
 else await locator.pressSequentially(value,{delay:8,timeout:Math.min(60000,Math.max(5000,value.length*30+2000))});
 // Non-ASCII characters may use native insertText without character keyup.
 // End commits keyboard-driven models without changing any applicant data.
 await locator.press('End');
 await locator.blur();
 // Allow framework renders and short debounced validation to settle before
 // checking readback. Longer validation remains subject to final form review.
 await locator.page().waitForTimeout(150);
 const actual=await locator.inputValue();
 if(!sameHostedInputValue(actual,value,{type,kind})){
  const field=await locator.evaluate(e=>e.getAttribute('aria-label')||[...e.labels||[]].map(l=>l.textContent).join(' ')||e.name||e.id||'field');
  const error=new Error('The employer form did not retain the complete entered answer for '+String(field).replace(/\s+/g,' ').trim().slice(0,160)+'. Review the field before continuing.');
  error.code='HOSTED_INPUT_NOT_RETAINED';
  throw error;
 }
 return true;
}
