import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {installEmployerLimits} from './employer-limits.js';
import {installCompanyApplicationPolicy,companyApplicationPolicy,isCompanyApplicationPolicyError} from './company-application-policy.js';
import {installPreparationHandoff,exportPreparationLedger,reservePreparation,externalPreparationProblem,handoffIdentity} from './preparation-handoff.js';

function fixture(path=':memory:'){
 const db=new DatabaseSync(path);db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
 CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,title TEXT,company TEXT,url TEXT,normalized_url TEXT,status TEXT DEFAULT 'saved',attempts INTEGER DEFAULT 0,local_attempt_at TEXT,confirmation TEXT,local_phase TEXT DEFAULT 'ready',notes TEXT DEFAULT '',challenge TEXT,created_at TEXT DEFAULT '2026',updated_at TEXT DEFAULT '2026');
 CREATE TABLE events(id INTEGER PRIMARY KEY,job_id TEXT,at TEXT,type TEXT,message TEXT);
 CREATE TABLE external_application_history(id TEXT,user_id TEXT,company TEXT,title TEXT,notes TEXT);
 `);installEmployerLimits(db);installCompanyApplicationPolicy(db);installPreparationHandoff(db);return db;
}
const identity=(id='1234',employer='Example Labs',title='Platform Engineer')=>({url:`https://job-boards.greenhouse.io/example/jobs/${id}`,employer,title,location:'Canada'});
const request=(revision,id='request_example_0001',job=identity())=>({schema_version:2,request_id:id,expected_revision:revision,identity:job});
function add(db,id,{job=identity(),user='u',status='saved',attempts=0,confirmation=null}={}){db.prepare('INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,attempts,confirmation) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,user,user+'-profile',job.title,job.employer,job.url,job.url,status,attempts,confirmation);}

test('minimal export retains URL-less history, exclusions, attempts and deleted tombstones; no personal content',()=>{
 const db=fixture();try{
  add(db,'excluded',{status:'archived'});add(db,'attempt',{job:identity('9999','Other Employer','SRE'),status:'paused',attempts:1,confirmation:'SECRET RECEIPT'});
  db.exec("UPDATE jobs SET notes='SECRET ANSWER'; INSERT INTO external_application_history VALUES('history','u','History Employer','Engineer','SECRET HISTORY'); INSERT INTO external_application_history VALUES('other','foreign','FOREIGN EMPLOYER','Private','SECRET FOREIGN'); DELETE FROM jobs WHERE id='attempt'");
  const value=exportPreparationLedger(db,'u');assert.equal(value.schema_version,2);assert.equal(value.complete,true);assert.equal(value.records.length,3);
  assert.equal(value.records.find(x=>x.record_id==='job:excluded').status,'excluded');assert.equal(value.records.find(x=>x.record_id==='job:attempt').status,'uncertain');assert.equal(value.records.find(x=>x.record_id==='history:history').identity.url,null);
  assert.doesNotMatch(JSON.stringify(value),/SECRET|FOREIGN|notes|confirmation|answers|credentials/);
  const other=exportPreparationLedger(db,'foreign');assert.equal(other.records.length,1);
 }finally{db.close();}
});
test('atomic reservation fences original queue/attempt paths and survives restart with no release or expiry',()=>{
 const dir=mkdtempSync(join(tmpdir(),'preparation-guard-')),path=join(dir,'test.sqlite');let db=fixture(path);
 try{
  add(db,'candidate');let s=exportPreparationLedger(db,'u');const r=reservePreparation(db,'u',request(s.revision));assert.equal(r.decision,'reserved');assert.equal(r.submission_allowed,false);
  assert.throws(()=>db.exec("UPDATE jobs SET status='queued' WHERE id='candidate'"),/reserved by ApplyPilot 2/);
  assert.equal(isCompanyApplicationPolicyError(Error('Application reserved by ApplyPilot 2')),true,'a discovery/queue race is handled as a per-job hold, not a failed search');
  assert.throws(()=>db.exec("UPDATE jobs SET local_attempt_at='2026' WHERE id='candidate'"),/reserved by ApplyPilot 2/);
  assert.match(externalPreparationProblem(db,db.prepare('SELECT * FROM jobs').get()),/reserved/);
  assert.equal(companyApplicationPolicy(db,'u-profile',db.prepare('SELECT * FROM jobs').get()).allowed,false);
  add(db,'other',{job:identity('4321','Example Labs','Product Engineer')});assert.doesNotThrow(()=>db.exec("UPDATE jobs SET status='queued' WHERE id='other'"));
  s=exportPreparationLedger(db,'u');const again=reservePreparation(db,'u',request(s.revision));assert.equal(again.decision,'rechecked');assert.equal(again.reservation_id,r.reservation_id);
  assert.throws(()=>reservePreparation(db,'u',request(s.revision,'request_example_0001',identity('8888'))),/request_identity_conflict/);
  db.close();db=new DatabaseSync(path);installEmployerLimits(db);installCompanyApplicationPolicy(db);installPreparationHandoff(db);
  assert.throws(()=>db.exec("UPDATE jobs SET status='running' WHERE id='candidate'"),/reserved by ApplyPilot 2/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM preparation_handoff_reservations').get().n,1);
  const future='2035-01-01T00:00:00.000Z';s=exportPreparationLedger(db,'u',{at:future});assert.equal(reservePreparation(db,'u',request(s.revision),{at:future}).reservation_id,r.reservation_id);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('stale/missing snapshots and changed protected state fail closed; valid replay needs fresh recheck',()=>{
 const db=fixture();try{
  assert.throws(()=>reservePreparation(db,'u',request(1)),/fresh_snapshot_required/);
  const at='2026-01-01T00:00:00.000Z',s=exportPreparationLedger(db,'u',{at});
  assert.throws(()=>reservePreparation(db,'u',request(s.revision),{at:'2026-01-01T00:06:00.000Z'}),/fresh_snapshot_required/);
  assert.throws(()=>reservePreparation(db,'u',request(s.revision+1),{at}),/snapshot_changed/);
  add(db,'prior',{status:'queued'});assert.throws(()=>reservePreparation(db,'u',request(s.revision),{at}),/snapshot_changed/);
  const fresh=exportPreparationLedger(db,'u',{at});assert.equal(reservePreparation(db,'u',request(fresh.revision),{at}).decision,'blocked');assert.equal(db.prepare('SELECT COUNT(*) n FROM preparation_handoff_reservations').get().n,0);
 }finally{db.close();}
});
test('company/title history and ATS aliases block reposts, but employer limits never block all platforms',()=>{
 const db=fixture();try{
  db.exec("INSERT INTO external_application_history VALUES('old','u','Example Labs Inc.','Platform Engineer','private')");
  let s=exportPreparationLedger(db,'u');assert.equal(reservePreparation(db,'u',request(s.revision)).decision,'blocked');
  const held=identity('8888','Held Employer','Other Role');held.url='https://job-boards.greenhouse.io/held/jobs/8888';
  db.prepare('INSERT INTO employer_security_holds VALUES(?,?,?,?,?,?,?,?)').run('u','u-profile','greenhouse:held','Held Employer','prior',new Date().toISOString(),'SECRET SECURITY MESSAGE','fixture');
  s=exportPreparationLedger(db,'u');assert.equal(reservePreparation(db,'u',request(s.revision,'request_held_0001',held)).reason_code,'employer_hold');
  assert.doesNotMatch(JSON.stringify(s),/SECRET SECURITY/);
  const safe=identity('8888','Unrelated Employer','Other Role');safe.url='https://job-boards.greenhouse.io/unrelated/jobs/8888';assert.equal(reservePreparation(db,'u',request(s.revision,'request_safe_0001',safe)).decision,'reserved');
  // A later employer hold also blocks a previously accepted reservation.
  db.prepare('INSERT INTO employer_security_holds VALUES(?,?,?,?,?,?,?,?)').run('u','u-profile','greenhouse:unrelated','Unrelated Employer','prior2',new Date().toISOString(),'security','fixture');
  s=exportPreparationLedger(db,'u');assert.equal(reservePreparation(db,'u',request(s.revision,'request_safe_0001',safe)).decision,'blocked');
 }finally{db.close();}
});
test('candidate URLs are real supported identities and cannot smuggle credentials or claim another requisition',()=>{
 for(const url of [null,'http://example.test/job','https://user:password@example.test/job','https://127.0.0.1/job','https://example.test/job','https://jobs.lever.co/example/not-a-posting'])assert.throws(()=>handoffIdentity({...identity(),url},{candidate:true}));
 assert.throws(()=>handoffIdentity({...identity(),ats:'greenhouse',tenant:'other',requisition_id:'1234'},{candidate:true}),/conflicting_identity/);
 assert.equal(handoffIdentity({...identity(),url:'https://boards.greenhouse.io/example/jobs/1234/?utm_source=example#form'},{candidate:true}).url,identity().url);
 assert.throws(()=>handoffIdentity({...identity(),url:identity().url+'?session=private'},{candidate:true}),/private_url_parameter/);
});
test('uncertain phases, independent attempt events and edited then deleted identities remain protected',()=>{
 const db=fixture();try{
  add(db,'phase');db.exec("UPDATE jobs SET local_phase='uncertain' WHERE id='phase'");
  add(db,'event',{job:identity('2345','Second Example','Infrastructure Engineer')});db.exec("INSERT INTO events VALUES(1,'event','2026','submission_started','PRIVATE EVENT'); DELETE FROM jobs WHERE id='event'");
  add(db,'edit',{job:identity('3456','Third Example','Network Engineer'),status:'paused'});
  db.exec("UPDATE jobs SET url='https://job-boards.greenhouse.io/third/jobs/4567',title='Security Engineer' WHERE id='edit'; DELETE FROM jobs WHERE id='edit'");
  const s=exportPreparationLedger(db,'u');assert(s.records.some(x=>x.identity.url.endsWith('/1234')&&x.status==='uncertain'));assert(s.records.some(x=>x.identity.url.endsWith('/2345')));assert(s.records.some(x=>x.identity.url.endsWith('/3456')));assert(s.records.some(x=>x.identity.url.endsWith('/4567')));
  assert.doesNotMatch(JSON.stringify(s),/PRIVATE EVENT/);
 }finally{db.close();}
});
test('an unexportable protected record fails the whole snapshot rather than silently omitting protection',()=>{
 const db=fixture();try{add(db,'private',{job:{...identity(),url:identity().url+'?access_token=private'},status:'archived'});assert.throws(()=>exportPreparationLedger(db,'u'),/private_url_parameter/);assert.equal(db.prepare('SELECT COUNT(*) n FROM preparation_handoff_snapshots').get().n,0);}finally{db.close();}
});
test('two simultaneous preparations sharing one snapshot produce one durable reservation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'preparation-race-')),path=join(dir,'test.sqlite'),db=fixture(path);
 try{
  const s=exportPreparationLedger(db,'u'),moduleURL=new URL('./preparation-handoff.js',import.meta.url).href,gate=new SharedArrayBuffer(4),flag=new Int32Array(gate);
  const code=`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {DatabaseSync}=await import('node:sqlite');const {registerPreparationHandoffFunctions,reservePreparation}=await import(workerData.moduleURL);const db=new DatabaseSync(workerData.path);db.exec('PRAGMA busy_timeout=5000');registerPreparationHandoffFunctions(db);parentPort.postMessage('ready');Atomics.wait(new Int32Array(workerData.gate),0,0);try{parentPort.postMessage(reservePreparation(db,'u',workerData.request));}catch(e){parentPort.postMessage({error:e.message});}finally{db.close();}})();`;
  let ready=0;const workers=[1,2].map(n=>new Worker(code,{eval:true,workerData:{path,moduleURL,gate,request:request(s.revision,'concurrent_request_'+n)}}));
  const results=await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',value=>{if(value==='ready'){if(++ready===2){Atomics.store(flag,0,1);Atomics.notify(flag,0);}}else resolve(value);});})));
  assert.equal(results.filter(x=>x.decision==='reserved').length,1);assert.equal(results.filter(x=>x.error==='snapshot_changed').length,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM preparation_handoff_reservations').get().n,1);
  await Promise.all(workers.map(w=>w.terminate()));
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
