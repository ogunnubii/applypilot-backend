import test from 'node:test';
import assert from 'node:assert/strict';
import {employmentContext,EMPLOYMENT_KEYS as K} from './employment-answers.js';
import {hostedFieldAnswer,hostedOptionChoice,approvedHostedRadioIndex} from './hosted-form.js';

const facts={[K.availability]:'Immediately',[K.canadaAuthorization]:'Yes',[K.canadaSponsorship]:'No'};
const auth='Are you authorized to work in the country where the job is located?';
const visa='Will you now or in the future require sponsorship for employment visa status in this country?';
function profile(location='Toronto, Ontario, Canada',saved=facts,application={}){const p={answers_json:JSON.stringify(saved)},j={job_metadata_json:JSON.stringify({location}),answers_json:JSON.stringify(application)};return {...p,employment_context:employmentContext(p,j)};}
const options=[{label:'Yes',value:'yes'},{label:'No',value:'no'}];

test('Canadian residence and unrestricted authorization jointly answer the observed any-employer question',()=>{
 const label='Are you physically located in Canada and legally authorized to work in Canada for any employer?';
 const saved={...facts,Country:'Canada',[K.canadaRestrictions]:'No restrictions'};
 assert.equal(hostedOptionChoice({label},options,profile('Toronto, Canada',saved))?.value,'yes');
 assert.equal(approvedHostedRadioIndex(options.map(o=>({...o,question:label})),{},profile('Toronto, Canada',saved)),0);
 for(const missing of ['Country',K.canadaRestrictions,K.canadaAuthorization]){const partial={...saved};delete partial[missing];assert.equal(hostedOptionChoice({label},options,profile('Toronto, Canada',partial)),null,missing);}
 for(const change of [{Country:'United States'},{[K.canadaRestrictions]:'Restrictions apply'},{[K.canadaAuthorization]:'No'}])assert.equal(hostedOptionChoice({label},options,profile('Toronto, Canada',{...saved,...change})),null);
 assert.equal(hostedOptionChoice({label:label.replace('Canada for any employer','Canada and willing to relocate')},options,profile('Toronto, Canada',saved)),null);
 assert.equal(hostedOptionChoice({label,description:'I accept the terms'},options,profile('Toronto, Canada',saved)),null);
});

test('qualified Canadian authorization requires an explicit restrictions fact or exact application answer',()=>{
 const label='Are you legally eligible to work in Canada?',choices=[{label:'Yes, with no restrictions'},{label:'Yes, with restrictions (details to be provided later)'},{label:'No'}];
 assert.equal(hostedOptionChoice({label},choices,profile()),null);
 const p=profile('Canada',{...facts,[K.canadaRestrictions]:'No restrictions'});
 assert.equal(hostedOptionChoice({label},choices,p)?.label,choices[0].label);
 assert.equal(hostedOptionChoice({label},options,p)?.value,'yes');
 assert.equal(hostedOptionChoice({label},choices,profile('United States',{...facts,[K.canadaRestrictions]:'No restrictions'})),null);
 assert.equal(hostedOptionChoice({label},choices,profile('Canada',facts,{[label]:choices[1].label}))?.label,choices[1].label);
 assert.equal(hostedOptionChoice({label},[...choices,{label:'Yes'}],p),null,'two supported answers are ambiguous');
});

test('startup answers use an explicit approved fact and salary text uses only a saved CAD annual floor',()=>{
 const startup='Do you have experience working in a start-up environment?';
 assert.equal(hostedFieldAnswer({label:startup},profile()),null);
 assert.equal(hostedFieldAnswer({label:startup},profile('Canada',{[K.startup]:'No'}))?.answer,'No');
 const label='What are your salary expectations?',p={answers_json:'{}'},job={job_metadata_json:JSON.stringify({location:'Canada'}),answers_json:'{}'};
 const withTarget={...p,employment_context:employmentContext(p,job,null,{annualSalaryTargetCAD:120000})};
 assert.equal(hostedFieldAnswer({label,type:'text'},withTarget)?.answer,'At least CAD 120,000 per year, depending on the role and total compensation.');
 for(const type of ['number','select','combobox','radio'])assert.equal(hostedFieldAnswer({label,type},withTarget),null);
 assert.equal(hostedFieldAnswer({label},profile()),null);
 for(const label of ['What is your current salary?','What are your hourly rate expectations?','Expected salary in USD','I agree to a salary of CAD 120000'])assert.equal(hostedFieldAnswer({label},withTarget),null);
});

test('observed alternative professional links and residence wording use saved profile facts',()=>{
 const p={location:'Toronto, Ontario, Canada',answers_json:'{}'},answers={LinkedIn:'https://www.linkedin.com/in/example'};
 for(const label of ['LinkedIn Profile or Website','LinkedIn, Portfolio, Personal Website, Github'])assert.equal(hostedFieldAnswer({label},p,answers)?.answer,answers.LinkedIn);
 assert.equal(hostedFieldAnswer({label:'Where do you live?'},p)?.answer,p.location);
 assert.equal(hostedFieldAnswer({label:'Your manager LinkedIn Profile or Website'},p,answers),null);
});

test('current employer and title use explicit current facts, never old employer captures or desired roles',()=>{
 const saved={[K.currentEmployer]:'Fixture Company',[K.currentTitle]:'Senior Cloud Engineer'};
 for(const label of ['Current employer','Current/Most Recent Company Name','Your current or most recent employer'])assert.equal(hostedFieldAnswer({label},profile('Canada',saved))?.answer,saved[K.currentEmployer],label);
 for(const label of ['Current job title','Current/Most Recent Job Title'])assert.equal(hostedFieldAnswer({label},profile('Canada',saved))?.answer,saved[K.currentTitle],label);
 for(const label of ['Previous employer','Desired job title','Current employer phone number','Your supervisor current job title','I certify my current job title'])assert.equal(hostedFieldAnswer({label},profile('Canada',saved)),null,label);
 assert.equal(hostedFieldAnswer({label:'Current employer',description:'Provide the employer of your reference'},profile('Canada',saved)),null);
 assert.equal(hostedFieldAnswer({label:'Current employer'},profile('Canada',{}, {'Employer':'Old Company'})),null);
 assert.equal(hostedFieldAnswer({label:'Current employer'},profile('Canada',saved,{'Current employer':'Other Company'})),null);
 assert.equal(hostedFieldAnswer({label:'Current employer'},profile('Canada',{}, {'Current employer':'Approved Company'}))?.answer,'Approved Company');
});

test('observed location-based eligibility wording uses only approved country facts',()=>{
 const authorization='Are you legally authorized to work in the location where this role is based?';
 const sponsorship='Will you now or in the future require visa sponsorship?';
 assert.equal(hostedOptionChoice({label:authorization},options,profile())?.value,'yes');
 assert.equal(hostedOptionChoice({label:sponsorship},options,profile())?.value,'no');
 for(const label of [authorization,sponsorship]){
  assert.equal(hostedOptionChoice({label},options,profile('Remote U.S.; Remote - Canada')),null);
  assert.equal(hostedOptionChoice({label},options,profile('Canada',{})),null);
  assert.equal(hostedOptionChoice({label:label+' I certify this is true'},options,profile()),null);
 }
});

test('explicit Canadian remote search selects Canada among advertised locations without asserting US eligibility',()=>{
 const scope={roles:['Senior Platform Engineer'],aliases:[],localPlaces:[],remotePlaces:['canada'],remoteWorldwide:true,remoteFromCountry:'canada',authorizedCountries:['canada'],allowEmploymentFallback:true};
 const metadata={location:'Remote U.S.; Remote - Canada',remote:true,description:'Build CI/CD and deployment infrastructure for our remote engineering team.',employmentType:'Full time'};
 const make=(changes={},choice=scope,saved=facts)=>{
  const p={location:'Toronto, Canada',answers_json:JSON.stringify(saved)};
  const job={title:'Senior Platform Engineer',job_metadata_json:JSON.stringify({...metadata,...changes}),answers_json:'{}'};
  return {...p,employment_context:employmentContext(p,job,choice)};
 };
 const authorization='Are you legally authorized to work in the location where this role is based?';
 const sponsorship='Will you now or in the future require visa sponsorship?';
 assert.equal(hostedOptionChoice({label:authorization},options,make())?.value,'yes');
 assert.equal(approvedHostedRadioIndex(options.map(o=>({...o,question:sponsorship})),{},make()),1);
 for(const p of [
  make({},null),make({}, {...scope,authorizedCountries:[]}),
  make({location:'Remote U.S.'}),make({location:'Global'}),
  make({remote:false}),make({location:'Hybrid U.S.; Canada'}),
  make({description:'Must be authorized to work in the United States.'}),
  make({description:''}),make({},scope,{})
 ])assert.equal(hostedOptionChoice({label:authorization},options,p),null);
 for(const label of ['Are you legally authorized to work in the United States?','Will you now or in the future require visa sponsorship in the United States?']){
  assert.equal(hostedOptionChoice({label},options,make()),null);
 }
 assert.equal(hostedOptionChoice({label:authorization,description:'This question is about our US location.'},options,make()),null);
});
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

test('confirmed over-18 fact fills exact age thresholds and never expands into declarations or other ages',()=>{
 const yes=profile('Remote, Global',{[K.over18]:'Yes'}),no=profile('Remote, Global',{[K.over18]:'No'});
 for(const label of ['Are you over the age of 18?','Are you over 18 years old?','Are you at least eighteen years of age?']){
  assert.equal(hostedOptionChoice({label},options,yes)?.value,'yes');
  assert.equal(approvedHostedRadioIndex(options.map(o=>({...o,question:label})),{},yes),0);
  assert.equal(hostedOptionChoice({label},options,profile('Remote, Global',{})),null);
 }
 assert.equal(hostedOptionChoice({label:'Are you over 18?'},options,no)?.value,'no');
 assert.equal(hostedOptionChoice({label:'Are you at least 18?'},options,no),null);
 for(const label of ['Are you over 21?','What is your date of birth?','I certify I am over 18','Are you over 18 and authorized to work here?','Are you at least 18 at the start date?'])assert.equal(hostedOptionChoice({label},options,yes),null,label);
 assert.equal(hostedOptionChoice({label:'Are you over 18?',description:'By choosing Yes, I accept the terms'},options,yes),null);
 const conflicting=profile('Global',{[K.over18]:'Yes'},{'Are you over 18?':'No','are you over 18':'Yes'});
 assert.equal(hostedOptionChoice({label:'Are you over 18?'},options,conflicting),null);
 assert.equal(hostedOptionChoice({label:'Are you over 18?'},options,profile('Global',{'Professional background':'I have 20 years of work experience.','Are you over 18?':'Yes'})),null);
});
