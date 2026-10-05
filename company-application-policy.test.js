import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {
 companyApplicationKeys,
 companyApplicationPolicy,
 installCompanyApplicationPolicy,
} from './company-application-policy.js';
import {installEmployerLimits} from './employer-limits.js';
import {installPipeline,queueFoundApplications} from './application-pipeline.js';
const recent=(offset=0)=>new Date(Date.now()+offset).toISOString();

function schema(db){
 db.exec(`
  CREATE TABLE applicants(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,consent INTEGER NOT NULL DEFAULT 1,email TEXT NOT NULL DEFAULT '',resume_path TEXT,google_research_consent INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE jobs(
   id TEXT PRIMARY KEY,user_id TEXT NOT NULL,applicant_id TEXT NOT NULL,title TEXT NOT NULL,company TEXT NOT NULL,
   url TEXT NOT NULL,normalized_url TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'saved',notes TEXT NOT NULL DEFAULT '',
   attempts INTEGER NOT NULL DEFAULT 0,lease_at TEXT,confirmation TEXT,challenge TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
   handoff_available INTEGER NOT NULL DEFAULT 0,local_attempt_at TEXT,match_score INTEGER NOT NULL DEFAULT 0,
   job_metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,at TEXT NOT NULL,type TEXT NOT NULL,message TEXT NOT NULL);
  CREATE TABLE external_application_history(user_id TEXT NOT NULL,company_key TEXT NOT NULL,title_key TEXT NOT NULL);
  CREATE TABLE research_draft_usage(job_id TEXT NOT NULL);
 `);
}
function memory({install=true,env={SAME_COMPANY_APPLICATION_LIMIT:'5',SAME_COMPANY_WINDOW_DAYS:'60'}}={}){
 const db=new DatabaseSync(':memory:');schema(db);
 if(install)installCompanyApplicationPolicy(db,{env});
 return db;
}
function add(db,id,{company='Acme',applicant='a',status='saved',url=`https://jobs.ashbyhq.com/acme/${id}`,created=`2026-01-${String(Number(id.replace(/\D/g,''))||1).padStart(2,'0')}T00:00:00.000Z`,attempts=0,localAttempt=null,confirmation=null}={}){
 db.prepare('INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,notes,attempts,local_attempt_at,confirmation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(id,'u',applicant,'Role '+id,company,url,url,status,'',attempts,localAttempt,confirmation,created,created);
 return db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
}

test('distinct roles at the same company are not subject to a blanket quota',()=>{
 const db=memory({env:{SAME_COMPANY_APPLICATION_LIMIT:'1',SAME_COMPANY_WINDOW_DAYS:'365'}});
 for(let n=1;n<=12;n++){
  const role=add(db,String(n));assert.equal(companyApplicationPolicy(db,'a',role).allowed,true);
  db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(String(n));
 }
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='queued'").get().n,12);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM company_application_activity').get().n,12);db.close();
});

test('upgrade removes legacy quota triggers while preserving exact duplicate and employer limit enforcement',()=>{
 const db=memory();installEmployerLimits(db);
 add(db,'old',{status:'running',created:recent(-60000)});
 db.exec("CREATE TRIGGER company_policy_update_limit BEFORE UPDATE OF status ON jobs WHEN NEW.status='queued' BEGIN SELECT RAISE(ABORT,'Same-company application limit reached'); END;");
 const restored=add(db,'new');assert.throws(()=>db.prepare("UPDATE jobs SET status='queued' WHERE id='new'").run(),/Same-company/);
 installCompanyApplicationPolicy(db);
 assert.doesNotThrow(()=>db.prepare("UPDATE jobs SET status='queued' WHERE id='new'").run());
 const duplicate=add(db,'duplicate',{url:'https://jobs.ashbyhq.com/acme/old'});
 assert.equal(companyApplicationPolicy(db,'a',duplicate).duplicate,true);
 assert.throws(()=>db.prepare("UPDATE jobs SET status='queued' WHERE id='duplicate'").run(),/Exact requisition/);
 db.prepare('INSERT INTO employer_limits VALUES(?,?,?,?,?,?,?,?,?,?)').run('u','a','ashby:ashby','Ashby',recent(),recent(60*86400000),3,60,'Employer application limit reached','Employer page');
 add(db,'blocked',{company:'Ashby',url:'https://jobs.ashbyhq.com/ashby/blocked'});
 assert.throws(()=>db.prepare("UPDATE jobs SET status='queued' WHERE id='blocked'").run(),/Employer application limit/);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM company_application_activity').get().n,2);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM employer_limits').get().n,1);db.close();
});

test('pipeline restores all unaffected distinct jobs and holds only the reported employer',()=>{
 const db=memory({install:false});
 db.exec("INSERT INTO applicants(id,user_id,consent,email,resume_path) VALUES('a','u',1,'person@example.test','resume.pdf')");
 installPipeline(db);installEmployerLimits(db);installCompanyApplicationPolicy(db);
 for(let n=1;n<=6;n++)add(db,String(n),{created:recent(-n*60000)});
 db.prepare('INSERT INTO employer_limits VALUES(?,?,?,?,?,?,?,?,?,?)').run('u','a','ashby:ashby','Ashby',recent(),recent(60*86400000),3,60,'Employer application limit reached','Employer page');
 add(db,'blocked',{company:'Ashby',url:'https://jobs.ashbyhq.com/ashby/blocked'});
 const result=queueFoundApplications(db,'u');assert.equal(result.queued,6);assert.equal(result.held,1);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='queued'").get().n,6);
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id='blocked'").get().status,'needs_review');db.close();
});

test('pipeline marks a rediscovered exact requisition duplicate after its started job was deleted',()=>{
 const db=memory({install:false});
 db.exec("INSERT INTO applicants(id,user_id,consent,email,resume_path) VALUES('a','u',1,'person@example.test','resume.pdf')");
 installPipeline(db);installEmployerLimits(db);installCompanyApplicationPolicy(db);
 const url='https://jobs.ashbyhq.com/acme/once-only';
 add(db,'old',{url,status:'running',created:'2026-10-01T00:00:00.000Z'});
 db.prepare("DELETE FROM jobs WHERE id='old'").run();
 add(db,'rediscovered',{url,created:'2026-10-01T01:00:00.000Z'});
 const result=queueFoundApplications(db,'u');
 assert.equal(result.queued,0);assert.equal(result.duplicates,1);
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id='rediscovered'").get().status,'duplicate');
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id='rediscovered' AND type='duplicate'").get().n,1);
 db.close();
});

test('legacy queue reconciliation keeps every distinct role and marks an exact alias duplicate',()=>{
 const db=memory({install:false});
 for(let n=1;n<=6;n++)add(db,String(n),{status:'queued',created:`2026-01-0${n}T00:00:00.000Z`});
 const alias='https://boards.greenhouse.io/acme/jobs/42';
 add(db,'7',{company:'Other',status:'queued',url:alias,created:'2026-01-07T00:00:00.000Z'});
 add(db,'8',{company:'Other',status:'queued',url:alias,created:'2026-01-08T00:00:00.000Z'});
 installCompanyApplicationPolicy(db);
 assert.deepEqual(db.prepare("SELECT id FROM jobs WHERE status='queued' ORDER BY created_at").all().map(row=>row.id),['1','2','3','4','5','6','7']);
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id='6'").get().status,'queued');
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id='8'").get().status,'duplicate');
 assert.match(db.prepare("SELECT challenge FROM jobs WHERE id='8'").get().challenge,/exact requisition/i);
 db.close();
});

test('legacy started work and untouched distinct reservations are both retained',()=>{
 const db=memory({install:false});
 for(let n=1;n<=5;n++)add(db,'q'+n,{status:'queued',created:recent(-7*86400000+n*60000)});
 add(db,'s1',{status:'running',created:recent(-2*86400000)});
 add(db,'s2',{status:'running',created:recent(-86400000)});
 installCompanyApplicationPolicy(db);
 assert.deepEqual(db.prepare("SELECT id FROM jobs WHERE status='queued' ORDER BY created_at").all().map(row=>row.id),['q1','q2','q3','q4','q5']);
 assert.deepEqual(db.prepare("SELECT id FROM jobs WHERE status='saved' ORDER BY created_at").all().map(row=>row.id),[]);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM company_application_activity").get().n,7);
 db.close();
});

test('a manually confirmed application immediately enters durable history and survives deletion',()=>{
 const db=memory(),url='https://jobs.ashbyhq.com/acme/manual-confirmed';
 add(db,'confirmed',{url,created:recent(-60000)});
 db.prepare("UPDATE jobs SET status='submitted',confirmation='Employer receipt' WHERE id='confirmed'").run();
 const activity=db.prepare("SELECT * FROM company_application_activity WHERE job_id='confirmed'").get();
 assert(activity.started_at);
 db.prepare("DELETE FROM jobs WHERE id='confirmed'").run();
 assert(db.prepare("SELECT * FROM company_application_activity WHERE job_id='confirmed'").get());
 const same=add(db,'same',{url});
 const exact=companyApplicationPolicy(db,'a',same);
 assert.equal(exact.allowed,false);assert.equal(exact.duplicate,true);
 const other=add(db,'other',{url:'https://jobs.ashbyhq.com/acme/other'});
 assert.equal(companyApplicationPolicy(db,'a',other).allowed,true);
 db.close();
});

test('recording a manual confirmation retains its durable identity alongside queued work',()=>{
 const db=memory({env:{SAME_COMPANY_APPLICATION_LIMIT:'1',SAME_COMPANY_WINDOW_DAYS:'60'}});
 add(db,'reserved',{status:'queued',created:'2026-10-01T00:00:00.000Z'});
 add(db,'confirmed',{created:'2026-10-01T01:00:00.000Z'});
 assert.doesNotThrow(()=>db.prepare("UPDATE jobs SET status='submitted',confirmation='Employer receipt' WHERE id='confirmed'").run());
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM company_application_activity").get().n,2);
 assert(db.prepare("SELECT started_at FROM company_application_activity WHERE job_id='confirmed'").get().started_at);
 db.close();
});

test('a started application cannot be repointed to a different requisition',()=>{
 const db=memory(),oldUrl='https://jobs.ashbyhq.com/acme/original';
 add(db,'started',{url:oldUrl,status:'running',created:'2026-10-01T00:00:00.000Z'});
 db.prepare("UPDATE jobs SET status='needs_review' WHERE id='started'").run();
 assert.throws(()=>db.prepare("UPDATE jobs SET url=?,normalized_url=? WHERE id='started'").run('https://jobs.ashbyhq.com/acme/replacement','https://jobs.ashbyhq.com/acme/replacement'),/Started application identity cannot change/);
 assert.equal(db.prepare("SELECT normalized_url FROM jobs WHERE id='started'").get().normalized_url,oldUrl);
 assert.equal(db.prepare("SELECT normalized_url FROM company_application_activity WHERE job_id='started'").get().normalized_url,oldUrl);
 db.close();
});

test('an old requisition remains deduplicated while distinct roles stay available',()=>{
 const db=memory({env:{SAME_COMPANY_APPLICATION_LIMIT:'1',SAME_COMPANY_WINDOW_DAYS:'60'}}),url='https://jobs.ashbyhq.com/acme/old';
 add(db,'old',{url,status:'running'});
 db.prepare("UPDATE company_application_activity SET started_at='2020-01-01T00:00:00.000Z' WHERE job_id='old'").run();
 const fresh=add(db,'fresh',{url:'https://jobs.ashbyhq.com/acme/fresh'});
 assert.equal(companyApplicationPolicy(db,'a',fresh,{env:{SAME_COMPANY_APPLICATION_LIMIT:'1',SAME_COMPANY_WINDOW_DAYS:'60'},now:Date.parse('2026-10-01T00:00:00Z')}).allowed,true);
 const exact=add(db,'exact',{url});
 assert.equal(companyApplicationPolicy(db,'a',exact,{env:{SAME_COMPANY_APPLICATION_LIMIT:'1',SAME_COMPANY_WINDOW_DAYS:'60'},now:Date.parse('2026-10-01T00:00:00Z')}).duplicate,true);
 db.close();
});

test('deleting an untouched reservation preserves separation between different ATS tenants',()=>{
 const db=memory({env:{SAME_COMPANY_APPLICATION_LIMIT:'1',SAME_COMPANY_WINDOW_DAYS:'60'}});
 add(db,'reserved',{status:'queued'});
 assert(db.prepare("SELECT 1 FROM company_application_activity WHERE job_id='reserved'").get());
 db.prepare("DELETE FROM jobs WHERE id='reserved'").run();
 assert.equal(db.prepare("SELECT 1 FROM company_application_activity WHERE job_id='reserved'").get(),undefined);
 const bamboo=add(db,'bamboo',{company:'Alpha',url:'https://shared.bamboohr.com/careers/1'});
 db.prepare("UPDATE jobs SET status='queued' WHERE id='bamboo'").run();
 const recruitee=add(db,'recruitee',{company:'Beta',url:'https://shared.recruitee.com/o/2'});
 assert.equal(companyApplicationPolicy(db,'a',recruitee,{env:{SAME_COMPANY_APPLICATION_LIMIT:'1',SAME_COMPANY_WINDOW_DAYS:'60'}}).allowed,true);
 assert.deepEqual(companyApplicationKeys(bamboo).filter(key=>key.includes('shared')),['bamboohr:shared']);
 assert.deepEqual(companyApplicationKeys(recruitee).filter(key=>key.includes('shared')),['recruitee:shared']);
 db.close();
});
