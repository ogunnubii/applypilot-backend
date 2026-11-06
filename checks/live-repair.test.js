// Regression tests for the live report on Anthropic Mobile Client Platform /
// macOS / ChromeOS forms, imported-history protections and Gemini on LinkedIn/Indeed.
// Synthetic data and a temporary SQLite file only; no network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const dir=mkdtempSync(join(tmpdir(),'applypilot-repair-'));process.env.DATABASE_PATH=join(dir,'t.sqlite');process.env.SESSION_SECRET=randomUUID()+randomUUID();
const {db}=await import('../db.js');
await import('../local-policy.js');
(await import('../answer-library.js')).installLibrary(db);(await import('../answer-drafts.js')).installDrafts(db);(await import('../google-research.js')).installResearch(db);
const {companyKey,importHistory,historyEmployerHolds,releaseHistoryEmployerHold}=await import('../application-history.js');
const {employerHold}=await import('../employer-limits.js');
const {normalizeSearchScope,remoteContradiction,isScopeRemote,roleFit,currentScopeAssessment}=await import('../search-scope.js');
const {prepareFormAnswer}=await import('../form-answer.js');
const {draftForJob,draftBackoff,resetDraftBackoff,jobIndependentQuestion}=await import('../answer-drafts.js');

db.exec("INSERT INTO users VALUES('u','fixture@example.test','fixture','2026')");
db.prepare("INSERT INTO applicants(id,user_id,name,email,phone,location,consent,execution_mode,focus,answers_json,created_at,gemini_facts_consent) VALUES('p','u','Fixture','fixture@example.test','','Thornhill, Ontario, Canada',1,'local','SRE',?,'2026',1)").run(JSON.stringify({'Professional background':'Ten years running Kubernetes platforms and on-call SRE.'}));
const scope=normalizeSearchScope({roles:['Site Reliability Engineer','DevOps Engineer','Platform Engineer','Cloud Engineer'],localPlaces:[],remotePlaces:['canada','thornhill'],remoteFromCountry:'canada',authorizedCountries:['canada'],preferBusinessContract:true,allowEmploymentFallback:false,includeRelatedRoles:true});
db.prepare("INSERT INTO searches(id,user_id,applicant_id,instruction,scope_json,boards_json,enabled,created_at) VALUES('s','u','p','Fixture',?,'[]',1,'2026')").run(JSON.stringify(scope));
const job=(id,{title,company='Anthropic',url,status='saved',meta={}})=>{db.prepare('INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,job_metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,'u','p',title,company,url,url,status,JSON.stringify(meta),'2026','2026');return db.prepare('SELECT * FROM jobs WHERE id=?').get(id);};
const ANTHROPIC_TEXT='Location-based hybrid policy: Currently, we expect all staff to be in one of our offices at least 25% of the time. Visa sponsorship: We do sponsor visas.';

test('companyKey never resolves employer names to Object.prototype members (history import bind failure)',()=>{
 for(const name of ['Constructor','toString','__proto__','hasOwnProperty','valueOf'])assert.equal(typeof companyKey(name),'string',name);
 assert.equal(companyKey('Constructor'),'constructor');
 assert.equal(companyKey('PricewaterhouseCoopers'),'pwc');
 const rows=[...Array(40)].map((_,i)=>({company:i%2?'Constructor':'toString',title:'Engineer '+i,status:'applied'}));
 const r=importHistory(db,'u',rows);assert.equal(r.added,40);
});

test('remote contradictions: required office attendance or travel is not remote',()=>{
 assert.equal(remoteContradiction({location:'Remote-Friendly (Travel-Required) | San Francisco, CA',description:'x'}),'The posting requires travel');
 assert.equal(remoteContradiction({location:'Remote',description:ANTHROPIC_TEXT}),'The posting requires office attendance');
 assert.equal(remoteContradiction({location:'Remote',description:'Expected to work 3 days a week in the office.'}),'The posting requires office attendance');
 assert.equal(remoteContradiction({location:'Remote',description:'100% remote. Occasional optional team offsites.'}),'');
 assert.equal(isScopeRemote({location:'Remote - Canada',description:ANTHROPIC_TEXT}),false);
});

test('role fit: client-application roles are not Cloud/DevOps/SRE/Platform even when titled "Platform"',()=>{
 for(const t of ['Software Engineer, Mobile Client Platform','Software Engineer, macOS','Software Engineer, ChromeOS'])assert.equal(roleFit(t,scope).fit,false,t);
 for(const t of ['Senior Site Reliability Engineer','Platform Engineer, Infrastructure','Staff SRE','DevOps Engineer'])assert.equal(roleFit(t,scope).fit,true,t);
 // The three reported jobs are blocked before any form opens.
 for(const [id,title] of [['mobile','Software Engineer, Mobile Client Platform'],['macos','Software Engineer, macOS'],['chromeos','Software Engineer, ChromeOS']]){
  const j=job(id,{title,url:'https://job-boards.greenhouse.io/anthropic/jobs/'+id,meta:{location:'Remote-Friendly (Travel-Required) | Canada',remote:true,description:ANTHROPIC_TEXT}});
  const a=currentScopeAssessment(db,j);assert.equal(a.eligibility.eligible,false);assert.match(a.eligibility.reason,/^Weak role fit/);
 }
});

test('imported history: provenance, URL aliases and durable employer holds; never counted as submissions',()=>{
 const r=importHistory(db,'u',[{company:'Anthropic',title:'Software Engineer, Mobile Client Platform',status:'uncertain',source_status:'Attempted (AP2 retained ledger)',source:'AP2',urls:['https://job-boards.greenhouse.io/anthropic/jobs/5396384008','https://www.linkedin.com/jobs/view/4012345678/?trk=x']},
  {company:'Anthropic',title:'Software Engineer, macOS',status:'applied',source_status:'Employer acknowledgement (Tsenta)',source:'Tsenta',url:'https://job-boards.greenhouse.io/anthropic/jobs/5445625008'}]);
 assert.equal(r.added,2);assert.equal(r.holds,0,'an uncertain role is not an employer-wide hold (AP2 ledger v2)');
 // The uncertain role itself stays protected by title and by every URL alias.
 assert.equal(job('same-role',{title:'Software Engineer, Mobile Client Platform',url:'https://job-boards.greenhouse.io/anthropic/jobs/5396384999'}).status,'duplicate');
 assert.equal(employerHold(db,job('unrelated',{title:'Site Reliability Engineer, Inference',url:'https://job-boards.greenhouse.io/anthropic/jobs/777'})),null,'unrelated role not held');
 // An explicit employer-level hold (limit/exclusion) holds every role there.
 const e=importHistory(db,'u',[{company:'Anthropic',title:'Employer-level limit',status:'uncertain',employer_hold:true,source:'AP2',urls:['https://job-boards.greenhouse.io/anthropic/jobs/1']}]);assert(e.holds>=2,'company and ATS board held');
 const h=db.prepare("SELECT source_status FROM external_application_history WHERE title='Software Engineer, macOS'").get();assert.equal(h.source_status,'Employer acknowledgement (Tsenta)');
 // Alias: the same posting under its LinkedIn link is a duplicate.
 const viaLinkedIn=job('li-alias',{title:'Mobile Platform Engineer',url:'https://www.linkedin.com/jobs/view/4012345678'});assert.equal(viaLinkedIn.status,'duplicate');
 // Employer hold: any other Anthropic role is held, on its board or by name.
 const other=job('other',{title:'Site Reliability Engineer',url:'https://job-boards.greenhouse.io/anthropic/jobs/999'});
 const hold=employerHold(db,other);assert.equal(hold.kind,'history');assert.match(hold.message,/unknown outcome/);
 assert.equal(employerHold(db,{...other,id:'x',company:'Globex',url:'https://boards.greenhouse.io/globex/jobs/1'}),null);
 // Release is the applicant's decision; a re-import does not resurrect it.
 for(const key of historyEmployerHolds(db,'u').filter(x=>!x.released_at).map(x=>x.employer_key))assert(releaseHistoryEmployerHold(db,'u',key));
 assert.equal(employerHold(db,other),null);
 importHistory(db,'u',[{company:'Anthropic',title:'Software Engineer, Mobile Client Platform',status:'uncertain'}]);
 assert.equal(employerHold(db,other),null,'released hold stays released');
 // Protections are not submissions.
 assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='submitted'").get().n,0);
});

test('Gemini on LinkedIn/Indeed: saved facts first, Gemini only for routine required professional questions, protected questions held',async()=>{
 process.env.GEMINI_API_KEY='test-only-not-a-key';
 const li=job('li',{title:'Senior Site Reliability Engineer',company:'Globex',url:'https://www.linkedin.com/jobs/view/4012345690',status:'local_browser'});void li;
 const calls=[];const draft=async(_db,_uid,id,question)=>{calls.push(question);return {answer:'I have run production Kubernetes platforms for ten years.',provider:'gemini',sources:['Professional background']};};
 const research=async()=>{throw Error('web research must not run on LinkedIn/Indeed');};
 const pro=await prepareFormAnswer(db,'u','li','Describe your experience operating Kubernetes in production.',{draft,research});
 assert.equal(pro.answer,'I have run production Kubernetes platforms for ten years.');assert.equal(pro.source,'approved_facts');assert.deepEqual(calls,['Describe your experience operating Kubernetes in production.']);
 for(const q of ['Will you now or in the future require visa sponsorship?','What are your salary expectations?','What is your gender?']){
  const r=await prepareFormAnswer(db,'u','li',q,{draft,research});assert.equal(r.answer,'',q);
 }
 assert.equal(calls.length,1,'protected questions never reach Gemini');
 db.prepare("UPDATE applicants SET gemini_facts_consent=0 WHERE id='p'").run();
 const off=await prepareFormAnswer(db,'u','li','Describe a production incident you led.',{draft,research});assert.equal(off.answer,'');assert.match(off.reason,/Gemini/);
 db.prepare("UPDATE applicants SET gemini_facts_consent=1 WHERE id='p'").run();
 delete process.env.GEMINI_API_KEY;
});

test('Gemini cost control: cross-job cache only for employer-independent questions, and backoff after rate limits',async()=>{
 assert.equal(jobIndependentQuestion('Describe your experience with Terraform.',{company:'Globex'}),true);
 for(const q of ['Why do you want to work at Globex?','What interests you about this role?','How would you contribute to our team?'])assert.equal(jobIndependentQuestion(q,{company:'Globex'}),false,q);
 job('d1',{title:'Senior Site Reliability Engineer',company:'Initech',url:'https://boards.greenhouse.io/initech/jobs/1',status:'local_browser'});
 resetDraftBackoff('u');let fetched=0;
 const env={GEMINI_API_KEY:'test-only-not-a-key'};
 const opts={env,context:async()=>({}),fetchImpl:async()=>{fetched++;return {ok:false,status:429,json:async()=>({})};}};
 await assert.rejects(draftForJob(db,'u','d1','Describe your experience with Terraform.',opts),/HTTP 429/);
 assert(draftBackoff('u'),'backoff recorded');
 await assert.rejects(draftForJob(db,'u','d1','Describe your experience with Ansible.',opts),/temporarily unavailable/);
 assert.equal(fetched,1,'no provider call during backoff');
 resetDraftBackoff('u');
});
