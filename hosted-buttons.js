import {hostedFormState} from './hosted-form-state.js';
import {approvedHostedRadioIndex} from './hosted-form.js';

// Ashby's Yes/No controls are buttons around a hidden checkbox. "No" is a
// completed answer even though that checkbox stays unchecked. Never toggle a
// completed group, or mistake ordinary submit/navigation buttons for answers.
export async function fillHostedButtonGroups(page,profile,answers={}){
 const groups=page.locator('.ashby-application-form-input-yesno:visible');let filled=0;
 for(let i=0;i<await groups.count();i++){
  const group=groups.nth(i),descriptor=await group.evaluate(hostedFormState);
  const buttons=group.locator('button:visible');
  const read=()=>buttons.evaluateAll(xs=>xs.map(e=>({label:(e.innerText||e.textContent||'').trim(),checked:e.getAttribute('aria-pressed')==='true',disabled:e.disabled||e.getAttribute('aria-disabled')==='true'})));
  const options=await read();if(options.length!==2||options.some(o=>o.checked)||new Set(options.map(o=>o.label.toLowerCase())).size!==2||options.some(o=>!/^yes$|^no$/i.test(o.label)))continue;
  const choice=approvedHostedRadioIndex(options.map(o=>({...o,question:descriptor.label||descriptor.ariaLabel,description:descriptor.description})),answers,profile);
  if(choice<0||JSON.stringify(await read())!==JSON.stringify(options))continue;
  await buttons.nth(choice).click();
  if((await read())[choice]?.checked)filled++;
 }
 return filled;
}
