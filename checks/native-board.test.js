import test from 'node:test';
import assert from 'node:assert/strict';
import '../local-policy.js';
import {canonicalJobURL} from '../form-policy.js';
import {normalizeSearchScope,scopedWorkEligibility,currentScopeAssessment} from '../search-scope.js';
import {assessNativePosting,compareNative,hiringSignals,nativePay,nativeSnapshot,freshNativeAssessment} from '../native-posting.js';
import {sameApplication as sameRole} from '../application-dedup.js';
import {applicationSource} from '../operation-evidence.js';
import {diversifyApplications} from '../application-diversity.js';

const P=globalThis.ApplyPilotPolicy;
const LI='https://www.linkedin.com/jobs/view/4012345678',IN='https://www.indeed.com/viewjob?jk=0123456789abcdef';
const scope=normalizeSearchScope({roles:['Site Reliability Engineer','DevOps Engineer','Platform Engineer','Cloud Engineer'],localPlaces:[],remotePlaces:['canada','thornhill'],remoteWorldwide:false,remoteFromCountry:'canada',authorizedCountries:['canada'],preferBusinessContract:true,allowEmploymentFallback:false,minimumAnnualCAD:60000});
const b2b='Engagement: B2B contract with an incorporated consultant. C2C accepted.';
const page=(over={})=>({url:LI+'/?trk=x',title:'Senior Site Reliability Engineer',company:'Acme Cloud',location:'Canada',workplace:'remote',description:'Remote within Canada. '+b2b,salaryText:'',postedText:'2 days ago',applicantsText:'18 applicants',signals:['Actively recruiting'],nativeApply:true,external:false,...over});
const job={url:LI,title:'',company:''};

test('native board identity uses the board job id and rejects search, lookalike and Indeed Apply pages as jobs',()=>{
 assert.equal(P.identity('https://www.linkedin.com/jobs/view/4012345678/apply/?openSDUIApplyFlow=true&trk=1'),LI);
 assert.equal(P.identity('https://ca.indeed.com/viewjob?jk=0123456789ABCDEF&from=serp&vjs=3'),IN);
 assert(P.sameApplication('https://uk.indeed.com/m/viewjob?jk=0123456789abcdef',IN));
 for(const bad of ['https://www.linkedin.com/jobs/search/?currentJobId=4012345678','https://linkedin.com.evil.test/jobs/view/4012345678','http://www.linkedin.com/jobs/view/4012345678','https://www.indeed.com/viewjob?jk=0123456789abcdef&jk=fedcba9876543210','https://smartapply.indeed.com/beta/indeedapply/form/review'])assert.equal(P.supported(bad),false,bad);
 assert.equal(canonicalJobURL('https://ca.indeed.com/viewjob?jk=0123456789ABCDEF&tk=abc'),IN);
 assert.equal(canonicalJobURL('https://www.linkedin.com/jobs/view/4012345678/?refId=a'),LI);
 // Indeed Apply is only a continuation of a bound Indeed job, and a different jk never matches.
 assert(P.continuationOf('https://smartapply.indeed.com/beta/indeedapply/form/questions/1',IN));
 assert(!P.continuationOf('https://smartapply.indeed.com/beta/indeedapply/form/review?jk=ffffffffffffffff',IN));
 assert(!P.continuationOf('https://smartapply.indeed.com/beta/indeedapply/form/review',LI));
 assert(!P.continuationOf('https://smartapply.indeed.com/other',IN));
});

test('only a fresh job-specific confirmation counts on native boards',()=>{
 const acme={company:'Acme Cloud Inc.',title:'Senior Site Reliability Engineer'};
 assert(P.nativeReceiptMatches('linkedin','Application sent\nYour application was sent to Acme Cloud!',acme));
 assert(!P.nativeReceiptMatches('linkedin','Your application was sent to Globex!',acme),'another employer');
 assert(!P.nativeReceiptMatches('linkedin','Your application was sent to Acme Cloud!',{}),'unknown company stays unconfirmed');
 assert(!P.nativeReceiptMatches('linkedin','Your application was not sent to Acme Cloud.',acme));
 assert(!P.nativeReceiptMatches('linkedin','Application submitted',acme),'generic wording is not LinkedIn’s receipt');
 assert(P.nativeReceiptMatches('indeed-apply','Your application has been submitted!\nSenior Site Reliability Engineer\nAcme Cloud',acme));
 assert(!P.nativeReceiptMatches('indeed-apply','Your application has been submitted!',acme),'receipt not attributable to the job');
 assert(P.nativeAlreadyApplied('Senior SRE\nApplied 3 days ago\nSee application'));
 assert.equal(P.nativeBlocker('You’ve reached the Easy Apply application limit for today.')?.kind,'rate-limit');
 assert.equal(P.nativeBlocker('Additional Verification Required')?.kind,'verification');
 assert.equal(P.nativeBlocker('Senior SRE at Acme. Apply now.'),null);
});

test('remote-only Cloud/DevOps/SRE/Platform scope with explicit permission to work from Thornhill, Canada',()=>{
 const ok=assessNativePosting(job,page(),scope,{date:Date.parse('2026-11-05T12:00:00Z')});
 assert.equal(ok.eligible,true,ok.blocker);assert.equal(ok.company,'Acme Cloud');
 const blocked=over=>assessNativePosting(job,page(over),scope).blocker;
 assert.match(blocked({title:'Senior Account Executive, Cloud'}),/role scope/);
 assert.match(blocked({title:'Data Scientist'}),/role scope/);
 assert.match(blocked({workplace:'hybrid'}),/remote/);
 assert.match(blocked({workplace:''}),/remote/,'unknown workplace is not remote');
 // Remote alone is not worldwide and not Canada.
 assert.match(blocked({location:'',description:'Fully remote role. '+b2b}),/Canada|location/);
 assert.match(blocked({location:'United States',description:'Remote (US). '+b2b}),/Canada|outside/);
 assert.match(blocked({description:'Remote within Canada. Must be authorized to work in the United States. '+b2b}),/foreign work authorization/);
 assert.match(blocked({description:'Remote within Canada. Full-time T4 employment.'}),/B2B|incorporated/);
 assert.match(blocked({external:true,nativeApply:false}),/employer’s site/);
 assert.match(assessNativePosting({...job,company:'Globex'},page(),scope).blocker,/company does not match/);
 assert.match(assessNativePosting(job,page({url:'https://www.linkedin.com/jobs/view/999999999'}),scope).blocker,/not the saved job/);
 assert.match(assessNativePosting(job,page(),null).blocker,/structured search scope/);
 // Thornhill is the saved location and is explicitly allowed.
 assert.equal(scopedWorkEligibility({title:'Platform Engineer',location:'Remote · Thornhill, ON',remote:true,description:'Remote. '+b2b},scope).eligible,true);
 // A generic benefit is not worldwide eligibility.
 assert.equal(scopedWorkEligibility({title:'Platform Engineer',location:'Remote',remote:true,description:'Work from anywhere for 4 weeks a year. '+b2b},scope).eligible,false);
});

test('CAD 60,000 floor applies only to known CAD pay; unknown pay stays unknown',()=>{
 const base={title:'Platform Engineer',location:'Remote, Canada',remote:true,description:'Remote in Canada. '+b2b};
 assert.equal(scopedWorkEligibility({...base,pay:[{currency:'CAD',annualMax:55000}]},scope).eligible,false);
 assert.equal(scopedWorkEligibility({...base,pay:[{currency:'CAD',annualMax:90000}]},scope).payFloor.status,'met');
 assert.equal(scopedWorkEligibility(base,scope).payFloor.status,'unknown');
 assert.equal(scopedWorkEligibility({...base,pay:[{currency:'USD',annualMax:40000}]},scope).payFloor.status,'unknown','no currency conversion is guessed');
 assert.equal(nativePay(nativeSnapshot(page({salaryText:'$90K/yr - $120K/yr'})))[0].currency,'CAD');
 assert.equal(nativePay(nativeSnapshot(page({location:'Remote',salaryText:'$90K/yr - $120K/yr'})))[0].currencySource,'unknown');
 assert.equal(nativePay(nativeSnapshot(page({salaryText:'$45 - $55 an hour'})))[0].annualMax,114400);
 const low=assessNativePosting(job,page({salaryText:'$40K/yr - $50K/yr'}),scope);
 assert.equal(low.eligible,false);assert.match(low.blocker,/CAD 60,000/);
});

test('ranking: pay, then evidenced fit, then hiring-speed signals; never a probability',()=>{
 const date=Date.parse('2026-11-05T12:00:00Z');
 const a=assessNativePosting(job,page({salaryText:'$150K/yr - $180K/yr',postedText:'30+ days ago',applicantsText:'Over 200 applicants',signals:[]}),scope,{date});
 const b=assessNativePosting(job,page({salaryText:'$110K/yr - $130K/yr'}),scope,{date});
 const c=assessNativePosting(job,page(),scope,{date});
 assert(compareNative(a,b)<0,'higher CAD pay first');assert(compareNative(b,c)<0,'known pay before unknown');
 const slow=assessNativePosting(job,page({postedText:'3 weeks ago',applicantsText:'Over 100 applicants',signals:[]}),scope,{date});
 assert(compareNative(c,slow)<0,'evidenced hiring speed breaks the tie');
 const h=hiringSignals(nativeSnapshot(page()),date);
 assert.deepEqual(h.signals.map(s=>s.kind),['posted','applicants','actively-recruiting']);
 assert(h.signals.every(s=>s.evidence));
 assert(!JSON.stringify(c).match(/probabilit|likelihood|chance/i));
 const ordered=diversifyApplications([{id:'c',url:LI,metadata:{native:c}},{id:'a',url:'https://www.linkedin.com/jobs/view/4012345679',metadata:{native:a}}]);
 assert.deepEqual(ordered.map(j=>j.id),['a','c']);
 assert(freshNativeAssessment({native:c},date+3600000));assert(!freshNativeAssessment({native:c},date+90000000));assert(!freshNativeAssessment({native:{...c,eligible:false}},date));
});

test('source attribution and cross-source duplicate detection',()=>{
 assert.equal(applicationSource({url:LI}),'linkedin');assert.equal(applicationSource({url:IN}),'indeed');
 assert.equal(applicationSource({url:'https://boards.greenhouse.io/acme/jobs/123'}),'direct');
 // Same employer role found on LinkedIn and on the employer's Greenhouse board.
 assert(sameRole({company:'Acme Cloud',title:'Senior Site Reliability Engineer',url:LI},{company:'Acme Cloud',title:'Senior Site Reliability Engineer',url:'https://boards.greenhouse.io/acme/jobs/123'}));
 assert(sameRole({company:'',title:'',url:LI+'/'},{company:'x',title:'y',url:LI}),'same LinkedIn job id');
 assert(!sameRole({company:'Acme Cloud',title:'Platform Engineer',url:LI},{company:'Acme Cloud',title:'Senior Site Reliability Engineer',url:IN}));
});

test('an unchecked native posting has unknown eligibility; a checked one uses its assessment',()=>{
 const db={prepare:sql=>({all:()=>/PRAGMA/.test(sql)?[{name:'scope_json'}]:[],get:()=>({scope_json:JSON.stringify(scope)})})};
 assert.equal(currentScopeAssessment(db,{url:LI,user_id:'u',applicant_id:'p',job_metadata_json:'{}'}),null);
 assert.equal(currentScopeAssessment(db,{url:LI,user_id:'u',applicant_id:'p',job_metadata_json:JSON.stringify({native:{eligible:false,blocker:'Not listed as a remote position.'}})}).eligibility.eligible,false);
});
