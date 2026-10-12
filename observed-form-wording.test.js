import test from 'node:test';
import assert from 'node:assert/strict';
import {hostedFieldAnswer,hostedOptionChoice} from './hosted-form.js';
import {employmentContext,EMPLOYMENT_KEYS as K} from './employment-answers.js';
import {canDraftProfessional} from './answer-drafts.js';

test('legal-name suffix uses the same saved applicant name without accepting declarations or third-party names',()=>{
 const profile={name:'Fixture Applicant'};
 assert.deepEqual(hostedFieldAnswer({label:'Full Name (Legal)'},profile),{kind:'name',answer:'Fixture Applicant'});
 for(const label of ['Reference Full Name (Legal)','Full Name (Legal) and electronic signature','I certify my full name legal'])assert.equal(hostedFieldAnswer({label},profile),null);
 assert.equal(hostedFieldAnswer({label:'Full Name (Legal)'},profile,{'Full name':'Different Applicant'}),null);
});

test('observed Canadian restriction and sponsorship wording requires explicit country-scoped facts',()=>{
 const options=[{label:'Yes'},{label:'No'}],auth='Are you authorized to work in Canada without restriction?';
 const sponsorship=['Will you now or in the future require sponsorship to work within Canada','Will you now or in the future require sponsorship in order to begin or continue employment in the Canada?✱'];
 const facts={[K.canadaAuthorization]:'Yes',[K.canadaRestrictions]:'No restrictions',[K.canadaSponsorship]:'No'};
 const make=(location='Remote - Canada',saved=facts)=>{const p={answers_json:JSON.stringify(saved)},j={job_metadata_json:JSON.stringify({location}),answers_json:'{}'};return {...p,employment_context:employmentContext(p,j)};};
 assert.equal(hostedOptionChoice({label:auth},options,make())?.label,'Yes');
 for(const label of sponsorship)assert.equal(hostedOptionChoice({label},options,make())?.label,'No');
 for(const label of [auth,...sponsorship]){
  assert.equal(hostedOptionChoice({label},options,make('United States')),null);
  assert.equal(hostedOptionChoice({label:label+' and I certify this is accurate'},options,make()),null);
  assert.equal(hostedOptionChoice({label,description:'I accept employer terms'},options,make()),null);
  assert.equal(hostedOptionChoice({label},options,make('Canada',{})),null);
 }
 assert.equal(hostedOptionChoice({label:auth},options,make('Canada',{...facts,[K.canadaRestrictions]:'Restrictions apply'})),null);
 assert.equal(hostedOptionChoice({label:auth},options,make('Canada',{[K.canadaAuthorization]:'Yes'})),null);
 assert.equal(hostedFieldAnswer({label:'What are your salary expectations?'},make()),null);
});

test('opportunity-interest wording may request a grounded professional draft while commitments and private attraction stay excluded',()=>{
 assert(canDraftProfessional('What attracts you to this opportunity at Kindred?'));
 for(const q of ['Who attracts you?','What attracts you to this opportunity and are you willing to relocate?','What attracts you to this opportunity? I agree to the terms','What attracts you to this opportunity and what are your salary expectations?'])assert(!canDraftProfessional(q),q);
 assert(!canDraftProfessional('What attracts you to this opportunity at Kindred?','Are you willing to work weekends?'));
});
