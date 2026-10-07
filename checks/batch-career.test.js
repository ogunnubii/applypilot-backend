import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {supportRole,supportAssessment,salaryTarget,SUPPORT_INSTRUCTION} from '../support-career.js';
import {workEligibility} from '../work-eligibility.js';
const root=process.env.APPLYPILOT_TEST_TMP||'data/test-tmp';mkdirSync(root,{recursive:true});process.env.DATABASE_PATH=join(mkdtempSync(join(root,'batch-')),'test.sqlite');
const {db}=await import('../db.js');const {parseIntent,mergeProfileRoles}=await import('../discovery.js');
const {installArchive}=await import('../application-archive.js');const {installFunnel}=await import('../job-funnel.js');const {installContinuations}=await import('../continuation-queue.js');
const {resetSupportBatch,populateBatch,batchSnapshot,inActiveBatch,nextBatch}=await import('../application-batches.js');
installArchive(db);installFunnel(db);installContinuations(db);
db.exec("INSERT INTO users VALUES('u','test@example.test','fixture','2026'),('other','other@example.test','fixture','2026');INSERT INTO applicants(id,user_id,name,created_at) VALUES('p','u','Test','2026'),('p2','other','Other','2026')");
after(()=>db.close());
function job(id,status='saved',user='u',metadata={available:true,supportCareer:{strong:true},salaryTarget:{eligible:true,minimum:120000},eligibility:{eligible:true}}){db.prepare('INSERT INTO jobs(id,user_id,applicant_id,company,title,url,normalized_url,status,created_at,updated_at,job_metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,user,user==='u'?'p':'p2',id,'AI Support Engineer','https://jobs.lever.co/'+id+'/role','https://jobs.lever.co/'+id+'/role',status,'2026','2026',JSON.stringify(metadata));}
test('reset is recoverable, owner scoped, preserves outcomes and uncertain-attempt evidence',()=>{
 job('old');job('uncertain','local_browser');job('receipt','submitted');job('interview','interview');job('other','queued','other');
 db.exec("UPDATE jobs SET local_attempt_at='2026',challenge='Unconfirmed submission' WHERE id='uncertain';INSERT INTO events(job_id,at,type,message) VALUES('uncertain','2026','submission_started','Attempt')");
 assert.throws(()=>resetSupportBatch(db,'other',{applicant_id:'p'}),/profile/);
 const result=resetSupportBatch(db,'u',{applicant_id:'p',degree:'Electrical and Computer Engineering'});assert.equal(result.archived,2);
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id='receipt'").get().status,'submitted');assert.equal(db.prepare("SELECT status FROM jobs WHERE id='interview'").get().status,'interview');assert.equal(db.prepare("SELECT status FROM jobs WHERE id='other'").get().status,'queued');
 assert.equal(db.prepare("SELECT status,local_attempt_at FROM jobs WHERE id='uncertain'").get().local_attempt_at,'2026');assert.equal(db.prepare('SELECT COUNT(*) n FROM application_archive').get().n,2);assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type='submission_started'").get().n,1);
 assert.equal(JSON.parse(db.prepare("SELECT answers_json FROM applicants WHERE id='p'").get().answers_json)['Field of study'],'Electrical and Computer Engineering');
});
test('batch admits only 20 verified matches, does not silently refill completions, and protects other accounts',()=>{
 for(let i=0;i<27;i++)job('fresh'+i);
 job('unverified','saved','u',{available:true,supportCareer:{strong:true},salaryTarget:{eligible:false},eligibility:{eligible:true}});
 const b=populateBatch(db,'u');assert.equal(b.selected,20);assert.equal(populateBatch(db,'u').selected,20);assert(!b.job_ids.includes('unverified'));assert(!b.job_ids.includes('other'));assert(!inActiveBatch(db,db.prepare("SELECT * FROM jobs WHERE id='old'").get()));
 db.prepare("UPDATE jobs SET status='submitted' WHERE id=?").run(b.job_ids[0]);assert.equal(populateBatch(db,'u').selected,20);assert.equal(batchSnapshot(db,'u').completed,1);assert.throws(()=>nextBatch(db,'u'),/Finish/);
 for(const id of b.job_ids)db.prepare("UPDATE jobs SET status='submitted' WHERE id=?").run(id);const next=nextBatch(db,'u');assert.equal(next.selected,7);assert(!next.job_ids.some(id=>b.job_ids.includes(id)));
});
test('support search remains narrow despite an older staff engineering profile',()=>{
 assert(supportRole('AI Support Engineer'));assert(supportRole('Technical Account Manager'));assert(!supportRole('Staff Platform Engineer'));assert(!supportRole('Senior Software Engineer, iOS'));assert(!supportRole('Support Engineering Manager'));
 const intent=mergeProfileRoles(parseIntent(SUPPORT_INSTRUCTION),'Staff Platform Engineer');assert(intent.supportCareer);assert(!intent.roles.includes('staff platform engineer'));
 const normal=supportAssessment({title:'Cloud Support Engineer',description:'Troubleshoot APIs and Linux; electrical engineering degree preferred'}),heavy=supportAssessment({title:'Cloud Support Engineer',description:'Expert Kubernetes. On-call rotation.'});assert(normal.strong&&normal.pathway&&normal.degreeRelevant);assert(!heavy.strong);assert(heavy.demands.length===2);
});
test('Canada requires incorporated engagement and salary comparisons disclose conversion uncertainty',()=>{
 assert(!workEligibility({location:'Toronto Canada',description:'Independent contractor, T4 only'}).eligible);assert(workEligibility({location:'Toronto Canada',description:'Incorporated consultants accepted. B2B contract.'}).eligible);
 assert(!workEligibility({location:'Remote Canada',description:'Full time, CAD 180000'}).eligible);
 assert(!workEligibility({location:'Worldwide remote',description:'Full time employee'}, {incorporatedFromCanada:true}).eligible);
 assert(workEligibility({location:'Worldwide remote',description:'B2B contract for incorporated consultants'}, {incorporatedFromCanada:true}).eligible);
 assert(!workEligibility({location:'United States',description:'We can sponsor visas to Germany; for any other country, you need existing right to work.'}).eligible);
 const pay=[{currency:'USD',annualMin:90000,annualMax:100000}];assert(!salaryTarget(pay,120000,{}).eligible);const p=salaryTarget(pay,120000,{USD:1.35},'2026-10-05');assert(p.eligible);assert.equal(p.range.cadMin,121500);assert.equal(p.rateDate,'2026-10-05');
});
