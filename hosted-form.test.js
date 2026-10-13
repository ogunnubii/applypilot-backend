import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {approvedHostedCheckbox,approvedHostedRadioIndex,hostedFieldAnswer,hostedOptionChoice,protectedHostedQuestion,scopedHostedComboboxOptions} from './hosted-form.js';

test('Canadian phone formatting agrees while different numbers, extensions and unscoped country changes pause',()=>{
 const field={label:'Phone Number',type:'tel'},profile={phone:'+1 (416) 555-0132',location:'Toronto, Ontario, Canada'};
 for(const phone of ['4165550132','+14165550132','1-416-555-0132'])assert.equal(hostedFieldAnswer(field,profile,{'Phone number':phone})?.answer,profile.phone);
 for(const phone of ['4165550133','4165550132 ext 4','+44165550132'])assert.equal(hostedFieldAnswer(field,profile,{'Phone number':phone}),null);
 assert.equal(hostedFieldAnswer(field,{phone:'+14165550132'},{Phone:'4165550132'}),null);
 assert.equal(hostedFieldAnswer(field,{phone:'+44 (20) 1234-5678'},{Phone:'+442012345678'})?.answer,'+44 (20) 1234-5678');
});

test('hosted personal name and current-location wording resolve saved profile facts',()=>{
 const profile={name:'Fixture Applicant',location:'Toronto, Ontario, Canada'};
 for(const label of ['Legal Name','Full Legal Name','Your legal full name','Please enter your legal name','candidateLegalName'])assert.equal(hostedFieldAnswer({label},profile)?.answer,profile.name,label);
 assert.equal(hostedFieldAnswer({label:'Legal first name'},profile)?.answer,'Fixture');
 assert.equal(hostedFieldAnswer({label:'Legal last name'},profile)?.answer,'Applicant');
 for(const label of ['Where are you currently located?','Where are you based?','What is your current location?','Please provide your current location'])assert.equal(hostedFieldAnswer({label},profile)?.answer,profile.location,label);
 const descriptor={label:'Where are you currently located?',type:'combobox'};
 assert.equal(hostedOptionChoice(descriptor,[{label:profile.location,value:'toronto'},{label:'Toronto, Ohio, United States',value:'ohio'}],profile)?.value,'toronto');
 assert.equal(hostedOptionChoice(descriptor,[{label:'Toronto',value:'ambiguous'}],profile),null);
});

test('personal-profile aliases reject different subjects, declarations and conflicting saved facts',()=>{
 const profile={name:'Fixture Applicant',location:'Toronto, Ontario, Canada'};
 for(const label of ['Legal name of your employer','Emergency contact legal name','I certify my legal name','Where would you like to be located?','Where are you authorized to work?','Country of origin'])assert.equal(hostedFieldAnswer({label},profile),null,label);
 assert.equal(hostedFieldAnswer({label:'Name',description:'Enter the name of your supervisor'},profile),null);
 assert.equal(hostedFieldAnswer({label:'Legal Name'},profile,{'Full name':'Different Applicant'}),null);
 assert.equal(hostedFieldAnswer({label:'Full name'},profile,{'Legal Name':'Different Applicant'}),null);
 assert.equal(hostedFieldAnswer({label:'Where are you currently located?'},profile,{'Current location':'Vancouver, British Columbia, Canada'}),null);
 assert.equal(hostedFieldAnswer({label:'Current location'},profile,{'Where are you currently located?':'Vancouver, British Columbia, Canada'}),null);
 assert.equal(hostedFieldAnswer({label:'Legal Name'},{},{}),null);
});

test('hosted routine controls require one exact saved answer',()=>{
 const answers={'Preferred office':'Toronto','Email me job updates':'Yes','Work schedule':'Hybrid'};
 const choice=hostedOptionChoice({label:'Preferred office'},[
  {index:0,label:'Vancouver',value:'van'},
  {index:1,label:'Toronto',value:'tor'}
 ],{},answers);
 assert.equal(choice?.index,1);
 assert.equal(approvedHostedCheckbox('Email me job updates',answers),true);
 assert.equal(approvedHostedRadioIndex([
  {question:'Work schedule',label:'Remote'},
  {question:'Work schedule',label:'Hybrid'}
 ],answers),1);
 assert.equal(hostedOptionChoice({label:'Preferred office'},[
  {index:0,label:'Toronto',value:'one'},
  {index:1,label:'Toronto',value:'two'}
 ],{},answers),null);
});

test('hosted controls never approve protected legal or demographic answers',()=>{
 for(const question of ['I certify this application is accurate','Gender','Work authorization','I agree to arbitration']){
  assert.equal(protectedHostedQuestion(question),true);
  assert.equal(approvedHostedCheckbox(question,{[question]:'Yes'}),null);
 }
});

test('hosted combobox options stay within an explicit ARIA relationship',()=>{
 const options=[
  {index:0,label:'Unrelated Toronto',scopeIds:['other-list'],newlyVisible:true,group:'other'},
  {index:1,label:'Toronto',scopeIds:['office-list'],newlyVisible:true,group:'office'}
 ];
 assert.deepEqual(scopedHostedComboboxOptions(options,{scopeIds:['office-list'],opened:true}).map(x=>x.index),[1]);
 assert.deepEqual(scopedHostedComboboxOptions(options,{scopeIds:['missing-list'],opened:true}),[]);
 assert.deepEqual(scopedHostedComboboxOptions(options,{scopeIds:['office-list'],opened:false}),[]);
});

test('hosted combobox fallback requires newly visible options in one container',()=>{
 const safe=[
  {index:0,label:'Old option',newlyVisible:false,group:'old'},
  {index:1,label:'Toronto',newlyVisible:true,group:'opened-list'},
  {index:2,label:'Vancouver',newlyVisible:true,group:'opened-list'}
 ];
 assert.deepEqual(scopedHostedComboboxOptions(safe,{opened:true}).map(x=>x.index),[1,2]);
 assert.deepEqual(scopedHostedComboboxOptions([...safe,{index:3,label:'Remote',newlyVisible:true,group:'second-list'}],{opened:true}),[]);
 assert.deepEqual(scopedHostedComboboxOptions(safe,{opened:false}),[]);
});

test('structured setup answers use the canonical hosted profile keys',()=>{
 const answers={City:'Toronto','Province / State':'Ontario',Country:'Canada','Postal code':'M5V 2T6',LinkedIn:'https://linkedin.com/in/example',GitHub:'https://github.com/example',School:'Example University',Degree:'BSc','Field of study':'Computer Science'};
 for(const [label,key] of [['City','City'],['State','Province / State'],['Country','Country'],['ZIP code','Postal code'],['LinkedIn profile','LinkedIn'],['GitHub URL','GitHub'],['University','School'],['Degree type','Degree'],['Major','Field of study']])assert.equal(hostedFieldAnswer({label},{},answers)?.answer,answers[key]);
});

test('setup captures each structured profile field under its canonical answer key',()=>{
 const html=fs.readFileSync(new URL('./web/setup.html',import.meta.url),'utf8'),source=fs.readFileSync(new URL('./web/setup.js',import.meta.url),'utf8');
 for(const name of ['city','region','country','postal','linkedin','github','school','degree','discipline'])assert.match(html,new RegExp(`name=["']${name}["']`));
 for(const [name,key] of [['city','City'],['region','Province / State'],['country','Country'],['postal','Postal code'],['linkedin','LinkedIn'],['github','GitHub'],['school','School'],['degree','Degree'],['discipline','Field of study']])assert.match(source,new RegExp(`${name}:["']${key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}["']`));
 assert.match(html,/Automatically prepare strong matches/);
 assert.doesNotMatch(html,/Automatically apply to strong matches/);
});

test('hosted worker preserves manual default and gates automatic submission behind focused authorization',()=>{
 const source=fs.readFileSync(new URL('./worker.js',import.meta.url),'utf8');
 assert.match(source,/Ready to submit — review the filled application and click Submit/);
 assert.match(source,/if\(focusAllowsSubmit\(db,job\)\)/);assert.match(source,/reserve:\(\)=>reserveAutonomousAttempt\(db,job.id,job.user_id,'hosted-worker'\)/);
 const submission=fs.readFileSync(new URL('./hosted-submission.js',import.meta.url),'utf8');assert.match(submission,/reserve\(\);[\s\S]*await submit.click\(/);
 assert.doesNotMatch(source,/event\([^\n]+['"]automatic_submission['"]/);
 assert.doesNotMatch(source,/requiresHumanReview\(await page\.locator\(['"]body['"]\)/);
 assert.match(source,/if\(requiredMissing\.length\)/);
 assert.match(source,/!handoffs\?\.full\(\)\|\|automaticMember\(db,job\)/);
});

test('equivalent LinkedIn profile URLs agree without accepting different accounts',()=>{
 const field={label:'LinkedIn'};
 const profile={linkedin:'https://www.linkedin.com/in/fixture'};
 assert.equal(hostedFieldAnswer(field,profile,{'LinkedIn URL':'https://linkedin.com/in/fixture/'})?.answer,profile.linkedin);
 assert.equal(hostedFieldAnswer(field,profile,{'LinkedIn URL':'https://linkedin.com/in/different'}),null);
 assert.equal(hostedFieldAnswer(field,profile,{'LinkedIn URL':'https://www.linkedin.com.evil.test/in/fixture'}),null);
 assert(protectedHostedQuestion('Do you require sponorship to work in the country you currently reside in?'));
});

test('observed Linkedln spelling uses only the saved applicant link and retains conflict/declaration guards',()=>{
 const profile={linkedin:'https://www.linkedin.com/in/fictional-applicant'};
 for(const label of ['Linkedln','Linkedln profile URL','Your Linkedln link'])assert.equal(hostedFieldAnswer({label},profile)?.answer,profile.linkedin,label);
 assert.equal(hostedFieldAnswer({label:'Linkedln'},{},{LinkedIn:profile.linkedin})?.answer,profile.linkedin);
 assert.equal(hostedFieldAnswer({label:'Linkedln'},{},{}),null);
 assert.equal(hostedFieldAnswer({label:'Linkedln'},profile,{LinkedIn:'https://linkedin.com/in/another-applicant'}),null);
 for(const field of [{label:'Supervisor Linkedln'},{label:'Linkedln',description:'Your emergency contact profile'},{label:'I certify my Linkedln information is accurate'},{label:'Linkedln',ambiguous:true}])assert.equal(hostedFieldAnswer(field,profile),null);
});
