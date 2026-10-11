import test from 'node:test';
import assert from 'node:assert/strict';
import {employmentContext,EMPLOYMENT_KEYS as K} from './employment-answers.js';
import {hostedFieldAnswer,hostedOptionChoice,approvedHostedRadioIndex} from './hosted-form.js';

const facts={[K.availability]:'Immediately',[K.canadaAuthorization]:'Yes',[K.canadaSponsorship]:'No'};
const auth='Are you authorized to work in the country where the job is located?';
const visa='Will you now or in the future require sponsorship for employment visa status in this country?';
function profile(location='Toronto, Ontario, Canada',saved=facts,application={}){const p={answers_json:JSON.stringify(saved)},j={job_metadata_json:JSON.stringify({location}),answers_json:JSON.stringify(application)};return {...p,employment_context:employmentContext(p,j)};}
const options=[{label:'Yes',value:'yes'},{label:'No',value:'no'}];
test('explicit scoped profile answers fill text, menus and yes/no controls without AI',()=>{
 const p=profile();
 assert.equal(hostedFieldAnswer({label:'When can you start a new role?'},p)?.answer,'Immediately');
 assert.equal(hostedOptionChoice({label:auth},options,p)?.value,'yes');
 assert.equal(hostedOptionChoice({label:visa},options,p)?.value,'no');
 assert.equal(approvedHostedRadioIndex(options.map(o=>({...o,question:visa})),{},p),1);
 assert.equal(hostedFieldAnswer({label:'Notice period'},p),null);
});
test('foreign, missing and mixed job locations never inherit Canadian eligibility',()=>{
 for(const location of ['', 'San Francisco, United States','Toronto, Canada / London, UK','Remote worldwide','Ontario, CA']){
  const p=profile(location);
  assert.equal(hostedOptionChoice({label:auth},options,p),null,location);
  assert.equal(hostedOptionChoice({label:visa},options,p),null,location);
 }
 assert.equal(hostedOptionChoice({label:'Are you authorized to work in the United States?'},options,profile()),null);
});
test('Canadian province locations are scoped while Ontario California stays blocked',()=>{
 assert.equal(hostedOptionChoice({label:auth},options,profile('Ontario - Remote'))?.value,'yes');
 assert.equal(hostedOptionChoice({label:auth},options,profile('Ontario, CA')),null);
 assert.equal(hostedOptionChoice({label:auth},options,profile('Canada / US')),null);
});
test('unapproved history, generic saved answers and resume prose do not become eligibility facts',()=>{
 const p=profile('Toronto, Canada',{'Are you authorized to work in Canada?':'Yes','Professional background':'I can work in Canada','Sponsorship':'No'});
 assert.equal(hostedOptionChoice({label:auth},options,p),null);
 assert.equal(hostedOptionChoice({label:visa},options,p),null);
 assert.equal(hostedFieldAnswer({label:'When can you start a new role?'},p),null);
 assert.equal(hostedOptionChoice({label:auth},options,{...p,employment_context:undefined}),null);
});
test('exact application answers override scoped defaults but ambiguity and compound declarations pause',()=>{
 const p=profile('Toronto, Canada',facts,{[visa]:'Yes'});
 assert.equal(hostedOptionChoice({label:visa},options,p)?.value,'yes');
 const conflicting=profile('Toronto, Canada',facts,{[visa]:'Yes',[visa.toLowerCase()]:'No'});
 assert.equal(hostedOptionChoice({label:visa},options,conflicting),null);
 for(const question of ['I certify that I am authorized to work in Canada','Are you authorized to work in Canada and willing to relocate?','Are you a Canadian citizen?','Are you able to work from a local office three days per week?'])assert.equal(hostedOptionChoice({label:question},options,profile()),null,question);
 assert.equal(hostedOptionChoice({label:auth,description:'I certify this answer is true and accept the terms'},options,profile()),null);
 assert.equal(hostedOptionChoice({label:auth},[{label:'Yes, I agree to the terms'},{label:'No'}],profile()),null);
 assert.equal(hostedOptionChoice({label:auth},[...options,{label:'Yes'}],profile()),null);
 assert.equal(approvedHostedRadioIndex(options.map(o=>({...o,question:auth,disabled:true})),{},profile()),-1);
});
