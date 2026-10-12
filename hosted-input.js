// Some employer forms commit their model on keyboard events or blur. A visible
// value alone is not evidence that the application model received that value.
// Use real Playwright keyboard input from an empty control, then commit focus.
// Never repair a value by deleting/re-appending a character or overwrite a
// populated field: it may contain an applicant edit or employer autofill.
const TEXT_TYPES=new Set(['text','email','tel','url','search','number','textarea','date']);

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
  const error=new Error('The employer form did not retain the complete entered answer. Review the field before continuing.');
  error.code='HOSTED_INPUT_NOT_RETAINED';
  throw error;
 }
 return true;
}
