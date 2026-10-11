import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeSearchScope,scopeIntent,searchInstruction,scopedWorkEligibility} from '../search-scope.js';
import {jobIntelligence,rankedJobs} from '../job-intelligence.js';
import {matches} from '../matching.js';
import {diversifyApplications} from '../application-diversity.js';
const scope=(extra={})=>normalizeSearchScope({roles:['Platform Engineer'],localPlaces:['Ontario'],remotePlaces:['Canada'],remoteWorldwide:true,remoteFromCountry:'canada',authorizedCountries:['canada'],preferBusinessContract:true,allowEmploymentFallback:true,preferRemote:true,preferSponsorship:true,...extra});
const job=(extra={})=>({title:'Platform Engineer',location:'Remote Canada',remote:true,description:'Full-time employment.',...extra});
test('structured titles preserve long lists, punctuation and case-insensitive deduplication without silent limits',()=>{
 const roles=Array.from({length:249},(_,i)=>`Platform Reliability and Operations Engineer ${i}`);
 roles.push(roles[0].toUpperCase());const s=scope({roles});assert.equal(s.roles.length,249);assert.equal(s.roles[248],roles[248]);
 const instruction=roles.join(', ');assert(instruction.length>5000);assert.equal(searchInstruction(instruction),instruction);
 assert.throws(()=>searchInstruction('x'.repeat(100001)),/nothing was saved/);
 assert.equal(scopeIntent(s).roles.length,249);
 assert.deepEqual(scope({roles:['Build and Release Engineer','Cloud / Infrastructure Engineer','R&D Engineer']}).roles,['Build and Release Engineer','Cloud / Infrastructure Engineer','R&D Engineer']);
});
test('Ontario onsite survives worldwide remote scope and foreign onsite never qualifies through sponsorship',()=>{
 const intent=scopeIntent(scope());
 for(const location of ['Toronto, Canada','Ontario, Canada','Ottawa, Canada','Kitchener, Canada','Richmond Hill','Whitby','London, ON'])assert(matches(job({location,remote:false}),intent),location);
 for(const location of ['Vancouver, Canada','New York, USA','London, UK','Ontario, CA','Ontario, California','Toronto, Ohio'])assert(!matches(job({location,remote:false,description:'We offer visa sponsorship.'}),intent),location);
 assert(matches(job({location:'Worldwide remote'}),intent));
 assert(!scopedWorkEligibility(job({location:'Remote USA',description:'C2C accepted. We offer visa sponsorship.'}),intent.scope).eligible);
 assert(!scopedWorkEligibility(job({location:'Worldwide remote',description:'US only. B2B contract.'}),intent.scope).eligible);
});
test('eligibility remains distinct from preference and configured applicant facts',()=>{
 assert(!scopedWorkEligibility(job(),scope({authorizedCountries:[]})).eligible);
 assert(!scopedWorkEligibility(job(),scope({allowEmploymentFallback:false})).eligible);
 assert.equal(scopedWorkEligibility(job(),scope()).kind,'canada-employment-fallback');
 assert.equal(scopedWorkEligibility(job({description:'We accept incorporated contractors.'}),scope()).kind,'business-contract');
 assert.notEqual(scopedWorkEligibility(job(),scope()).kind,'sponsorship');
 assert(!scopedWorkEligibility(job({description:'Must be a US citizen.'}),scope()).eligible);
});
test('business contracts precede T4 fallback despite lower fit and employer diversity, without dropping fallback',()=>{
 const row=(id,data,score)=>({id,company:id,url:`https://jobs.lever.co/${id}/${id}`,match_score:score,status:'saved',job_metadata_json:JSON.stringify(jobIntelligence(data,scopeIntent(scope())))});
 const b2b=row('contract',job({description:'We accept incorporated contractors.'}),60),t4=row('employee',job(),100);
 assert.deepEqual(rankedJobs([t4,b2b]).map(x=>x.id),['contract','employee']);
 assert.deepEqual(diversifyApplications([t4,b2b],[{...b2b,id:'old',title:'Other',status:'submitted'}]).map(x=>x.id),['contract','employee']);
});

test('remote-first outranks onsite contracts, with B2B first among Canada and worldwide remote matches',()=>{
 const row=(id,data,score,s=scope())=>({id,company:id,title:data.title,url:`https://jobs.lever.co/${id}/${id}`,match_score:score,status:'saved',job_metadata_json:JSON.stringify(jobIntelligence(data,scopeIntent(s)))});
 const rows=[row('onsite-contract',job({location:'Toronto, Canada',remote:false,description:'We accept incorporated contractors.'}),100),row('remote-employee',job(),65),row('global-contract',job({location:'Worldwide remote',description:'We accept incorporated contractors. Work remotely from anywhere in the world.'}),60),row('canada-contract',job({description:'We accept incorporated contractors.'}),70)];
 const ranked=rankedJobs(rows).map(x=>x.id);assert.deepEqual(ranked,['canada-contract','global-contract','remote-employee','onsite-contract']);
 const diversified=diversifyApplications(rows,[{...rows[2],id:'prior',title:'Different role',status:'submitted'}]).map(x=>x.id);
 assert(diversified.indexOf('global-contract')<diversified.indexOf('remote-employee'));assert(diversified.indexOf('remote-employee')<diversified.indexOf('onsite-contract'));
 const noPreference=scope({preferRemote:false});assert.equal(rankedJobs([row('onsite',job({location:'Toronto, Canada',remote:false,description:'We accept incorporated contractors.'}),100,noPreference),row('remote',job(),65,noPreference)])[0].id,'onsite');
 for(const data of [job({location:'Worldwide remote',description:'Must be authorized to work in the United States.'}),job({location:'London, UK',remote:false,description:'We offer visa sponsorship.'})])assert(!scopedWorkEligibility(data,scope()).eligible,'ranking never broadens eligibility');
});

test('remote ranking changes apply to untouched queue entries without rewriting application history',async()=>{
 const {DatabaseSync}=await import('node:sqlite'),{prioritizeApplications}=await import('../application-diversity.js'),{setSearchRemotePreference}=await import('../search-scope.js');
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE searches(id,user_id,applicant_id,enabled,scope_json,created_at);CREATE TABLE jobs(id,company,title,url,normalized_url,status,attempts,local_attempt_at,confirmation,user_id);CREATE TABLE external_application_history(id,company,title,status,user_id);');
 db.prepare('INSERT INTO searches VALUES(?,?,?,?,?,?)').run('s','u','p',1,JSON.stringify(scope({preferRemote:false})),'2026');
 const make=(id,data)=>({id,user_id:'u',applicant_id:'p',title:'Platform Engineer',company:id,url:`https://jobs.lever.co/${id}/${id}`,status:'queued',attempts:0,job_metadata_json:JSON.stringify(jobIntelligence(data,scopeIntent(scope({preferRemote:false}))))});
 const rows=[make('office',job({location:'Toronto, Canada',remote:false,description:'We accept incorporated contractors.'})),make('remote',job()),{...make('attempted',job()),attempts:1,status:'needs_review',local_attempt_at:'2026',challenge:'Unconfirmed submission'},{...make('confirmed',job()),attempts:1,status:'submitted',confirmation:'Employer receipt'}],before=JSON.stringify(rows);
 setSearchRemotePreference(db,'u','s',{preferRemote:true});const result=prioritizeApplications(db,'u',rows);
 assert(result.findIndex(x=>x.id==='remote')<result.findIndex(x=>x.id==='office'));assert.deepEqual(result.find(x=>x.id==='attempted'),rows[2]);assert.deepEqual(result.find(x=>x.id==='confirmed'),rows[3]);assert.equal(JSON.stringify(rows),before);db.close();
});
test('legacy text parsing no longer drops roles after 80 or instructions after 5000 characters',async()=>{
 const source=readFileSync(new URL('../discovery.js',import.meta.url),'utf8'),s=await import('../support-career.js');
 const part=source.slice(source.indexOf('const placeWords='),source.indexOf('export function profileSearchInstruction')).replace(/export /g,'');
 const parse=new Function('supportIntent','remoteCanadaIntent','worldwideTechIntent','t4FallbackIntent',part+';return parseIntent;')(s.supportIntent,s.remoteCanadaIntent,()=>false,s.t4FallbackIntent);
 const roles=Array.from({length:249},(_,i)=>`Reliability Infrastructure Platform Specialist ${i}`);const intent=parse(roles.join(', '));assert.equal(intent.roles.length,249);assert.equal(intent.roles[248],roles[248].toLowerCase());
});

test('global remote labels do not override foreign work authorization or mandatory foreign offices',()=>{
 for(const description of ['Must be authorized to work in the United States.','US work authorization required.','Must be authorized to work in the U.S.','Work from anywhere in the US.','B2B contract. Must attend on-site.'])assert(!scopedWorkEligibility(job({location:'Worldwide remote',description}),scope()).eligible,description);
 for(const location of ['Richmond Hill','Whitby'])assert(scopedWorkEligibility(job({location,remote:false}),scope()).eligible);
 const sponsored=jobIntelligence(job({description:'Full time. We offer visa sponsorship.'}),scopeIntent(scope()));
 const ordinary=jobIntelligence(job(),scopeIntent(scope()));assert(sponsored.eligibility.sponsorshipAvailable);assert(sponsored.searchPriority<ordinary.searchPriority);
 assert(!jobIntelligence(job({description:'Visa sponsorship is not available.'}),scopeIntent(scope())).eligibility.sponsorshipAvailable);
});
test('new scope rechecks untouched pending jobs while preserving all attempted and confirmed records',async()=>{
 const {DatabaseSync}=await import('node:sqlite'),{prioritizeApplications}=await import('../application-diversity.js');
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE searches(id,user_id,applicant_id,enabled,scope_json,created_at);CREATE TABLE jobs(id,company,title,url,normalized_url,status,attempts,local_attempt_at,confirmation,user_id);CREATE TABLE external_application_history(id,company,title,status,user_id);");
 db.prepare('INSERT INTO searches VALUES(?,?,?,?,?,?)').run('s','u','p',1,JSON.stringify(scope()),new Date().toISOString());
 const base={user_id:'u',applicant_id:'p',title:'Platform Engineer',company:'Fixture',url:'https://jobs.lever.co/fixture/a',job_metadata_json:JSON.stringify({location:'Remote USA',remote:true,description:'C2C accepted',eligibility:{eligible:true}})};
 const rows=[{...base,id:'new',status:'queued',attempts:0},{...base,id:'uncertain',status:'needs_review',attempts:1,local_attempt_at:'yesterday',challenge:'Unconfirmed submission'},{...base,id:'done',status:'submitted',attempts:1,confirmation:'Employer receipt'}];
 const before=JSON.stringify(rows);const result=prioritizeApplications(db,'u',rows);
 assert.equal(result.length,3);assert.equal(result.find(x=>x.id==='new').metadata.eligibility.eligible,false);
 assert.deepEqual(result.find(x=>x.id==='uncertain'),rows[1]);assert.deepEqual(result.find(x=>x.id==='done'),rows[2]);assert.equal(JSON.stringify(rows),before);db.close();
});
test('out-of-scope queued work cannot starve another applicant in hosted claim selection',()=>{
 const source=readFileSync(new URL('../worker.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('function claim(){'),source.indexOf('\nasync function pageIssue'));
 const rows=[{id:'blocked',user_id:'one',metadata:{eligibility:{eligible:false}}},{id:'allowed',user_id:'two',metadata:{eligibility:{eligible:true}}}],updates=[];
 const db={exec(){},prepare(sql){return {all:()=>sql.startsWith('SELECT user_id FROM work_focus')?[]:rows,run:(...args)=>updates.push(args)}}};
 const claim=new Function('handoffs','db','ensureFocusedJob','prioritizeApplications','now','event','savedSearchClaimProblem',code+';return claim;')({full:()=>false},db,()=>{},(_db,_user,jobs)=>jobs,()=>new Date().toISOString(),()=>{},()=> '');
 assert.equal(claim().id,'allowed');assert.equal(updates.length,1);assert.equal(updates[0][2],'allowed');
});
test('Setup imports structured scope through the existing signed-in form and rejects invalid JSON before any request',async()=>{
 const {JSDOM}=await import('jsdom');
 const dom=new JSDOM('<select id="profiles"><option value="p">Profile</option></select><form id="search"><input name="instruction" value="Grouped targets"><textarea name="scope_json"></textarea><input name="auto_queue" type="checkbox" checked><button>Save</button></form>',{runScripts:'outside-only'}),w=dom.window;
 const calls=[],notices=[];w.$=selector=>w.document.querySelector(selector);w.api=async(...args)=>{calls.push(args);return {id:'new-search'}};w.notice=text=>notices.push(text);
 const source=readFileSync(new URL('../web/setup.js',import.meta.url),'utf8'),start=source.indexOf("for(const name of ['job','search'])"),end=source.indexOf('\n};',start)+4;
 w.eval(source.slice(start,end));const form=w.document.querySelector('form');form.elements.scope_json.value=JSON.stringify({scope:scope()});
 await form.onsubmit({preventDefault(){},target:form});assert.equal(calls[0][0],'/searches');assert.equal(calls[0][2].scope.roles[0],'Platform Engineer');assert.equal(calls[0][2].scope_json,undefined);assert.equal(calls[1][0],'/searches/new-search/run');
 calls.length=0;form.elements.scope_json.value='{invalid';await form.onsubmit({preventDefault(){},target:form});assert.equal(calls.length,0);assert.match(notices.at(-1),/Nothing was saved/);assert.equal(form.querySelector('button').disabled,false);dom.window.close();
});
