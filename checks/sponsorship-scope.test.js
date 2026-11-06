// Canada: remote, incorporated (B2B/C2C) only. Outside Canada: only roles whose
// posting explicitly offers visa sponsorship for that country. Authorization and
// sponsorship answers come from explicit saved facts per country, never inferred.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../local-policy.js';
import {normalizeSearchScope,scopedWorkEligibility,postingCountry,scopePriority,setSearchRemotePreference} from '../search-scope.js';
import {assessNativePosting} from '../native-posting.js';
import {employmentContext,approvedEmploymentAnswer,EMPLOYMENT_KEYS as K} from '../employment-answers.js';

const base={roles:['Site Reliability Engineer'],localPlaces:[],remotePlaces:['canada','thornhill'],remoteFromCountry:'canada',authorizedCountries:['canada'],preferBusinessContract:true,allowEmploymentFallback:false,preferRemote:true,minimumAnnualCAD:60000};
const everywhere=normalizeSearchScope({...base,foreignSponsorship:true,foreignWorkplaces:['remote','hybrid','on-site']});
const remoteAbroad=normalizeSearchScope({...base,foreignSponsorship:true});
const canadaOnly=normalizeSearchScope(base);
const job=(location,description,remote=false)=>({title:'Site Reliability Engineer',location,description,remote});
const SPONSOR='We offer visa sponsorship and relocation support.';

test('scope fields: sponsored roles abroad default to remote only and are validated',()=>{
 assert.deepEqual(remoteAbroad.foreignWorkplaces,['remote']);assert.equal(canadaOnly.foreignSponsorship,undefined);
 assert.throws(()=>normalizeSearchScope({...base,foreignSponsorship:true,foreignWorkplaces:['moon']}));
 assert.throws(()=>normalizeSearchScope({...base,foreignSponsorship:true,foreignWorkplaces:[]}));
});

test('Canada stays remote and incorporated-only, even when a posting mentions sponsorship',()=>{
 assert.equal(scopedWorkEligibility(job('Remote - Canada','Remote. B2B contract with an incorporated consultant welcome.',true),everywhere).kind,'business-contract');
 assert.match(scopedWorkEligibility(job('Remote - Canada','Remote. Full-time T4 employee. '+SPONSOR,true),everywhere).reason,/incorporated|B2B/);
 assert.equal(scopedWorkEligibility(job('Toronto, Ontario, Canada','On-site. Incorporated contractors welcome.'),everywhere).eligible,false,'no on-site in Canada');
});

test('outside Canada: explicit sponsorship for that country, an accepted workplace, and one named country',()=>{
 const uk=scopedWorkEligibility(job('London, United Kingdom',SPONSOR),everywhere);
 assert.equal(uk.eligible,true);assert.equal(uk.kind,'foreign-sponsorship');assert.equal(uk.country,'united kingdom');assert.equal(uk.workplace,'on-site');
 assert.equal(scopedWorkEligibility(job('Berlin, Germany (Remote)','Visa sponsorship is available.',true),remoteAbroad).eligible,true);
 assert.match(scopedWorkEligibility(job('London, United Kingdom',SPONSOR),remoteAbroad).reason,/accepts remote/);
 assert.match(scopedWorkEligibility(job('London, United Kingdom','Great team, great benefits.'),everywhere).reason,/does not explicitly offer visa sponsorship/,'remote is not sponsorship; silence is not sponsorship');
 assert.equal(scopedWorkEligibility(job('London, United Kingdom','We cannot provide visa sponsorship.'),everywhere).eligible,false);
 assert.equal(scopedWorkEligibility(job('Seattle, WA, USA','We offer visa sponsorship to Germany.'),everywhere).eligible,false,'sponsorship for another country');
 for(const location of ['EMEA (Remote)','US or UK','Remote','Europe'])assert.equal(scopedWorkEligibility(job(location,SPONSOR,true),everywhere).eligible,false,location);
 assert.equal(scopedWorkEligibility(job('London, United Kingdom',SPONSOR),canadaOnly).eligible,false,'not included unless enabled');
 assert.equal(postingCountry('Join us in London'),'united kingdom');assert.equal(postingCountry('Thornhill, ON'),'canada');assert.equal(postingCountry('Contact us remotely'),null);
});

test('ranking: remote first, then Canadian incorporated work ahead of sponsored roles abroad',()=>{
 const priority=(location,description,remote)=>scopePriority(everywhere,scopedWorkEligibility(job(location,description,remote),everywhere),job(location,description,remote));
 const canadaB2B=priority('Remote - Canada','Remote. Incorporated consultants (B2B) welcome.',true);
 const ukRemote=priority('London, United Kingdom (Remote)',SPONSOR,true);
 const ukOnsite=priority('London, United Kingdom',SPONSOR,false);
 assert(canadaB2B<ukRemote,'incorporated Canada first');assert(ukRemote<ukOnsite,'remote abroad before on-site abroad');
});

test('LinkedIn/Indeed posting check applies the same rule abroad',()=>{
 const LI='https://www.linkedin.com/jobs/view/4012345678';
 const page=over=>({url:LI,title:'Senior Site Reliability Engineer',company:'Acme',location:'London, England, United Kingdom',workplace:'on-site',description:'Senior SRE. '+SPONSOR,nativeApply:true,...over});
 const ok=assessNativePosting({url:LI},page(),everywhere);assert.equal(ok.eligible,true,ok.blocker);assert.equal(ok.country,'united kingdom');assert.equal(ok.workplace,'on-site');
 assert.match(assessNativePosting({url:LI},page(),remoteAbroad).blocker,/accepts remote/);
 assert.match(assessNativePosting({url:LI},page({description:'Senior SRE.'}),everywhere).blocker,/does not explicitly offer visa sponsorship/);
 assert.match(assessNativePosting({url:LI},page({location:'Toronto, Ontario, Canada',workplace:'hybrid',description:'Incorporated contractors welcome.'}),everywhere).blocker,/remote/,'Canada stays remote-only');
});

test('authorization and sponsorship answers use explicit saved facts for the job’s country',()=>{
 const facts={[K.canadaAuthorization]:'Yes',[K.canadaRestrictions]:'No restrictions',[K.canadaSponsorship]:'No',[K.foreignAuthorization]:'No',[K.foreignSponsorship]:'Yes'};
 const ask=(location,question,saved=facts)=>{const p={answers_json:JSON.stringify(saved)};return approvedEmploymentAnswer({label:question},{...p,employment_context:employmentContext(p,{job_metadata_json:JSON.stringify({location})})})?.answer??null;};
 assert.equal(ask('London, United Kingdom','Will you now or in the future require sponsorship?'),'Yes');
 assert.equal(ask('London, United Kingdom','Are you legally authorized to work in this country?'),'No');
 assert.equal(ask('Berlin, Germany','Do you require visa sponsorship?'),'Yes');
 assert.equal(ask('Toronto, Ontario, Canada','Will you now or in the future require sponsorship?'),'No');
 assert.equal(ask('Remote - Canada','Are you legally authorized to work in the United States?'),'No','a named foreign country uses the outside-Canada fact');
 assert.equal(ask('Remote - Canada','Will you now or in the future require sponsorship to work in the United Kingdom?'),'Yes');
 // Unknown stays unknown.
 assert.equal(ask('Remote','Will you now or in the future require sponsorship?'),null,'job country unknown');
 assert.equal(ask('US or UK','Will you now or in the future require sponsorship?'),null,'several countries');
 assert.equal(ask('London, United Kingdom','Will you now or in the future require sponsorship?',{[K.canadaSponsorship]:'No'}),null,'Canada fact never used abroad');
 assert.equal(ask('London, United Kingdom','Are you authorized to work in Canada?'),null);
 // An answer typed for this job earlier (e.g. while it looked Canadian) is not reused abroad.
 const p={answers_json:JSON.stringify({[K.canadaAuthorization]:'Yes'})},stale={job_metadata_json:JSON.stringify({location:'San Francisco, United States'}),answers_json:JSON.stringify({'Are you legally authorized to work in this country?':'Yes'})};
 assert.equal(approvedEmploymentAnswer({label:'Are you legally authorized to work in this country?'},{...p,employment_context:employmentContext(p,stale)}),null);
});

test('the abroad preference is saved through the existing search-preference endpoint',()=>{
 let stored=JSON.stringify(canadaOnly);
 const db={prepare:sql=>({get:()=>({scope_json:stored}),run:value=>{stored=value;}})};
 assert.deepEqual(setSearchRemotePreference(db,'u','s',{foreignSponsorship:true,foreignWorkplaces:['remote','on-site']}).scope.foreignWorkplaces,['remote','on-site']);
 assert.equal(JSON.parse(stored).foreignSponsorship,true);
 assert.equal(setSearchRemotePreference(db,'u','s',{foreignSponsorship:false}).scope.foreignSponsorship,undefined);
 assert.throws(()=>setSearchRemotePreference(db,'u','s',{foreignSponsorship:'yes'}));
 assert.throws(()=>setSearchRemotePreference(db,'u','s',{foreignSponsorship:true,foreignWorkplaces:['moon']}));
 assert.throws(()=>setSearchRemotePreference(db,'u','s',{authorizedCountries:['united kingdom']}),'work authorization is never changed from a preference');
 assert.equal(setSearchRemotePreference(db,'u','s',{preferRemote:false}).scope.preferRemote,false);
});
