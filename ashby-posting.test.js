import test from 'node:test';
import assert from 'node:assert/strict';
import {ashbyPosting} from './ashby-posting.js';
import {normalizeSearchScope,scopedWorkEligibility} from './search-scope.js';
const scope=normalizeSearchScope({roles:['Platform Engineer'],remotePlaces:['Canada'],remoteFromCountry:'canada',authorizedCountries:['canada'],allowEmploymentFallback:true});
const posting=(extra={})=>ashbyPosting({title:'Platform Engineer',location:'Remote: United States',secondaryLocations:[{location:'Remote: Canada'}],isRemote:true,employmentType:'FullTime',descriptionPlain:'Build production cloud infrastructure with Kubernetes.',jobUrl:'https://jobs.ashbyhq.com/example/fixture',...extra},'Example');
test('Canada as a secondary Ashby location remains eligible under the saved remote Canada fallback',()=>{
 const job=posting();assert.equal(job.location,'Remote: United States; Remote: Canada');assert.equal(job.employmentType,'Full time');assert.equal(scopedWorkEligibility(job,scope).eligible,true);
 assert.equal(scopedWorkEligibility(job,{...scope,allowEmploymentFallback:false}).eligible,false);
});
test('secondary locations do not override explicit US-only or foreign authorization requirements',()=>{
 for(const descriptionPlain of ['US only.','Must be authorized to work in the United States.'])assert.equal(scopedWorkEligibility(posting({descriptionPlain}),scope).eligible,false);
 assert.equal(scopedWorkEligibility(posting({secondaryLocations:[]}),scope).eligible,false);
 assert.equal(scopedWorkEligibility(posting({isRemote:false,location:'New York',secondaryLocations:[{location:'Toronto'}]}),scope).eligible,false);
});
test('malformed or duplicate secondary locations do not invent locations or alter requisition identity',()=>{
 const job=posting({secondaryLocations:[null,{},'Canada',{location:42},{location:' Remote: Canada '},{location:'Remote: Canada'}],applyUrl:'https://jobs.ashbyhq.com/example/fixture/application'});
 assert.equal(job.location,'Remote: United States; Remote: Canada');assert.equal(job.url,'https://jobs.ashbyhq.com/example/fixture/application');
 assert.equal(posting({secondaryLocations:null}).location,'Remote: United States');
});
