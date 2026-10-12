import test from 'node:test';
import assert from 'node:assert/strict';
import {fieldKind,knownAnswer,optionMatches} from './local-policy.js';
import {hostedFieldAnswer,hostedFieldKind,hostedOptionChoice} from './hosted-form.js';

const locationQuestion='Location: (Please confirm your work/residency location)';
const timezoneQuestion='Which time zone do you primarily work in?';
const profile={location:'Thornhill, Ontario, Canada'};

test('Greenhouse work/residency location wording maps only explicit profile facts',()=>{
 for(const label of [locationQuestion,`${locationQuestion} *`,`${locationQuestion} (City and Country)`,'Location (City & Country)']){
  assert.equal(fieldKind(label),'location',label);
  assert.equal(knownAnswer(label,profile,{}),profile.location,label);
  assert.deepEqual(hostedFieldAnswer({label,description:'(City and Country)'},profile),{kind:'location',answer:profile.location});
 }
 assert.equal(knownAnswer(locationQuestion,{},{}),null);
 assert.equal(hostedFieldAnswer({label:locationQuestion},{},{}),null);
 assert.equal(hostedFieldAnswer({label:locationQuestion},{},{'Current location':profile.location})?.answer,profile.location);
 assert.equal(hostedFieldAnswer({label:'Current location'},{},{[locationQuestion]:profile.location})?.answer,profile.location);
 assert.equal(hostedFieldAnswer({label:locationQuestion},profile,{'Current location':'Ottawa, Ontario, Canada'}),null);
 assert.equal(hostedFieldAnswer({label:locationQuestion},{},{'Current location':profile.location,Location:'Ottawa, Ontario, Canada'}),null);
});

test('timezone needs an explicit saved fact, not an inferred city or current clock offset',()=>{
 for(const p of [profile,{location:'Toronto, Ontario, Canada'},{city:'Toronto',country:'Canada'},{location:'Vancouver, British Columbia, Canada'}]){
  assert.equal(knownAnswer(timezoneQuestion,p,{}),null);
  assert.equal(hostedFieldAnswer({label:timezoneQuestion},p),null);
  assert.equal(knownAnswer('What country and time zone are you based in?',p,{}),null);
 }
 for(const key of ['Time zone','Timezone','Your time zone','Primary time zone','Work time zone','What is your time zone?',timezoneQuestion]){
  const answers={[key]:'America/Toronto'};
  assert.equal(fieldKind(key),'timezone',key);
  assert.equal(knownAnswer(timezoneQuestion,profile,answers),'America/Toronto',key);
  assert.deepEqual(hostedFieldAnswer({label:timezoneQuestion},profile,answers),{kind:'timezone',answer:'America/Toronto'},key);
 }
 for(const key of ['timezone','timeZone','time_zone']){
  assert.equal(hostedFieldAnswer({label:timezoneQuestion},{...profile,[key]:'America/Toronto'})?.answer,'America/Toronto',key);
 }
 assert.equal(hostedFieldAnswer({label:timezoneQuestion},profile,{'Time zone':{value:'America/Toronto'}}),null);
 const combined='Canada — Eastern Time (America/Toronto)';
 assert.equal(knownAnswer('What country and time zone are you based in?',profile,{'What country and time zone are you based in?':combined}),combined);
});

test('timezone aliases reconcile only matching explicit facts and reject conflicts',()=>{
 const p={...profile,timezone:'America/Toronto'};
 for(const alias of ['Canada/Eastern','Eastern Time (America/Toronto)','Eastern Time (US & Canada)','Eastern Time (EST/EDT)']){
  assert.equal(knownAnswer(timezoneQuestion,p,{'Time zone':alias}),'America/Toronto',alias);
  assert.equal(hostedFieldAnswer({label:timezoneQuestion},p,{'Time zone':alias})?.answer,'America/Toronto',alias);
 }
 for(const answer of ['America/Vancouver','America/New_York','EST','UTC-05:00','Pacific Time']){
  assert.equal(knownAnswer(timezoneQuestion,p,{[timezoneQuestion]:answer}),null,answer);
  assert.equal(hostedFieldAnswer({label:timezoneQuestion},p,{[timezoneQuestion]:answer}),null,answer);
  assert.equal(hostedOptionChoice({label:timezoneQuestion},[{label:answer,value:'conflict'}],p,{[timezoneQuestion]:answer}),null,answer);
 }
 assert.equal(knownAnswer(timezoneQuestion,{timezone:'America/Toronto',timeZone:'America/Vancouver'},{}),null);
 assert.equal(hostedFieldAnswer({label:timezoneQuestion},{timezone:'America/Toronto',timeZone:'America/Vancouver'},{'Time zone':'America/Toronto'}),null);
 assert.equal(knownAnswer(timezoneQuestion,{}, {'Time zone':'Eastern Time','Your time zone':'America/Toronto','Primary time zone':'America/New_York'}),null);
});

test('timezone option choices use exact zones or bounded display aliases, never just offsets',()=>{
 const p={...profile,timezone:'America/Toronto'},field={label:timezoneQuestion};
 const matches=['America/Toronto','Canada/Eastern','Eastern Time','Eastern Time (ET)','Eastern Time (EST/EDT)','Eastern Time (US & Canada)','(UTC-05:00) Eastern Time (US & Canada)','Eastern Time (America/Toronto)'];
 for(const label of matches){
  assert.equal(optionMatches(timezoneQuestion,label,p.timezone,p),true,label);
  assert.equal(hostedOptionChoice(field,[{label:'Pacific Time',value:'wrong'},{label,value:'right'}],p)?.value,'right',label);
 }
 for(const label of ['America/New_York','America/Panama','America/Vancouver','EST','EDT','UTC-05:00','(UTC-04:00) Eastern Time (US & Canada)','Australian Eastern Time','Pacific Time (America/Toronto)','Eastern Time (America/Vancouver)','Available to work Eastern Time']){
  assert.equal(optionMatches(timezoneQuestion,label,p.timezone,p),false,label);
  assert.equal(hostedOptionChoice(field,[{label,value:'wrong'}],p),null,label);
 }
 assert.equal(hostedOptionChoice(field,[{label:'America/Toronto',value:'one'},{label:'Canada/Eastern',value:'two'}],p),null);
 assert.equal(hostedOptionChoice(field,[{label:'America/Toronto',value:'disabled',disabled:true}],p),null);
 assert.equal(hostedOptionChoice(field,[{label:'Eastern Time',value:'eastern'}],profile),null);
 assert.equal(optionMatches('Preferred office','Eastern Time','America/Toronto',p),false);
 assert.equal(optionMatches(timezoneQuestion,'Canada/Pacific','America/Vancouver',{}),true);
 assert.equal(optionMatches(timezoneQuestion,'Pacific Time (US & Canada)','America/Vancouver',{}),true);
 assert.equal(optionMatches(timezoneQuestion,'Mountain Time','America/Phoenix',{}),false);
 assert.equal(optionMatches(timezoneQuestion,'UTC','Etc/UTC',{}),true);
});

test('location and timezone mapping preserve third-party, relocation, legal and experience boundaries',()=>{
 const p={...profile,timezone:'America/Toronto'},answers={'Time zone':'America/Toronto','Current location':profile.location};
 for(const label of [
  'Where would you like to be located?',
  'Please confirm your preferred work/residency location',
  'Which time zone are you willing to work in?',
  'Which time zone can you overlap with?',
  'Which time zone does your manager primarily work in?',
  'Are you authorized to work in your location?',
  'I certify my work/residency location',
  'Have you used Kubernetes or ArgoCD in production?',
 ]){
  assert.equal(knownAnswer(label,p,answers),null,label);
  assert.equal(hostedFieldAnswer({label},p,answers),null,label);
 }
 for(const field of [
  {label:'Location',description:'Enter your emergency contact location'},
  {label:'Time zone',description:'Enter the timezone of your manager'},
  {label:'Location',description:'Where are you willing to relocate?'},
  {label:'Time zone',description:'Select your preferred work schedule'},
  {label:'Time zone',description:'Confirm availability to overlap with our team'},
  {label:timezoneQuestion,description:'I agree to work in the selected timezone'},
 ]){
  assert.equal(hostedFieldKind(field),null,JSON.stringify(field));
  assert.equal(hostedFieldAnswer(field,p,answers),null,JSON.stringify(field));
  assert.equal(hostedOptionChoice(field,[{label:'America/Toronto',value:'timezone'},{label:profile.location,value:'location'}],p,{...answers,Location:profile.location}),null,JSON.stringify(field));
 }
});


test('exact professional dropdown answers containing company or manager are preserved',()=>{
 for(const question of ['Have you worked at a software company?','Have you worked as a support manager?']){
  assert.equal(hostedOptionChoice({label:question},[{label:'Yes',value:'yes'},{label:'No',value:'no'}],{},{[question]:'No'})?.value,'no');
 }
});
