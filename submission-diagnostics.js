import {hostedFormState} from './hosted-form-state.js';

// Observe only the selected final-click window. Never retain URLs, request
// bodies, headers, response bodies, answers or credentials. HTTP success alone
// is not an employer receipt.
export function watchSubmission(page){
 const networkPage=typeof page.page==='function'?page.page():page;
 let active=false,posts=0,failed=0;const statuses=[],requests=new Set();
 const eligible=request=>{try{return active&&request.method()==='POST'&&new URL(request.url()).origin===new URL(page.url()).origin;}catch{return false;}};
 const request=value=>{if(eligible(value)){posts++;requests.add(value);}};
 const response=value=>{if(requests.has(value.request())){const code=value.status();if(Number.isInteger(code)&&statuses.length<20)statuses.push(code);requests.delete(value.request());}};
 const failure=value=>{if(requests.delete(value))failed++;};
 networkPage.on?.('request',request);networkPage.on?.('response',response);networkPage.on?.('requestfailed',failure);
 return {
  start(){if(!active){active=true;posts=0;failed=0;statuses.length=0;requests.clear();}},
  async describe(){
   if(!active)return '';
   let state;try{state=await page.evaluate(hostedFormState);}catch{}
   const notes=['Submission diagnostic (not a receipt): '+posts+' employer POST request(s) observed; response status '+(statuses.length?statuses.join(', '):'none observed')+'; '+failed+' network failure(s).'];
   if(state?.captcha)notes.push('Employer verification is visible.');
   if(state?.signIn)notes.push('Employer sign-in is visible.');
   if(state?.pending)notes.push('Employer form validation is pending.');
   if(state?.missing?.length)notes.push(state.missing.length+' field(s) are missing or invalid after Submit.');
   if(state&&!state.captcha&&!state.signIn&&!state.pending&&!state.missing?.length)notes.push('No visible missing-field or verification blocker detected.');
   notes.push('Only an employer receipt can confirm acceptance; no retry is authorized by this diagnostic.');
   return notes.join(' ');
  },
  stop(){networkPage.off?.('request',request);networkPage.off?.('response',response);networkPage.off?.('requestfailed',failure);requests.clear();}
 };
}
