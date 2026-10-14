import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {runtimeFixture,fixtureJobId,fixtureURL,FIXTURE_OWNER} from '../database/runtime-fixture.js';
import {registerNativeFunctions} from '../database/native-functions.js';
import {installImportedHistory} from '../migration/install-imported-history.mjs';
import {hashFile} from '../migration/state-snapshot.mjs';

test('verified offline import reaches real authenticated APIs, duplicate fences, fresh preparation, Stop/consent checks and receipt reconciliation',{timeout:40000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'applypilot-import-e2e-')),f=runtimeFixture(root);
 f.add(1,{status:'local_browser',attempt:true});for(const n of [2,3,4,5])f.add(n);
 const snapshot=f.finish(),targetPath=join(f.dir,'target.sqlite');await installImportedHistory({...snapshot,targetPath});
 process.env.SESSION_SECRET=randomUUID()+randomUUID();const {issueToken}=await import('../auth.js');
 const raw=new DatabaseSync(targetPath);registerNativeFunctions(raw);raw.exec('PRAGMA foreign_keys=ON');
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['--import','./migration/test-network-guard.mjs','server.js'],{cwd:resolve('.'),env:{...process.env,DATABASE_PATH:targetPath,UPLOAD_DIR:f.dir,PORT:String(port),BIND_HOST:'127.0.0.1',PUBLIC_ORIGIN:base,APPLYPILOT_BACKGROUND_TASKS:'paused'},stdio:['ignore','pipe','pipe'],windowsHide:true});let log='';child.stdout.on('data',v=>log+=v);child.stderr.on('data',v=>log+=v);const exited=new Promise(r=>child.once('exit',r));
 const api=async(path,method='GET',body,uid='u',owner=FIXTURE_OWNER)=>{const response=await fetch(base+'/api'+path,{method,signal:AbortSignal.timeout(5000),headers:{...(uid?{authorization:'Bearer '+issueToken(uid)}:{}),'content-type':'application/json','x-applypilot-device':owner},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};};
 const local=(n,action,body={})=>api('/jobs/'+fixtureJobId(n)+'/local/'+action,'POST',body);
 try{
  let ready=false;for(let n=0;n<100;n++){try{if((await api('/health')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert(ready,log);
  assert.equal((await local(2,'claim')).status,409,'new imported accounts are stopped');
  // This is the explicit synthetic fixture operator, not runtime activation code.
  raw.exec("UPDATE guard_accounts SET stopped=0 WHERE user_id='u'");
  assert.equal((await local(1,'claim')).status,409,'old uncertain employer attempt cannot be reclaimed');
  assert.equal((await local(2,'claim')).status,200);assert.equal((await local(2,'step')).status,200);
  const imported=await api('/application-history','POST',{rows:[{company:'Fictional 2',title:'Engineer 2',status:'interview'},{company:'Fictional 3',title:'Engineer 3',status:'offer'}]});
  assert.equal(imported.status,200);assert.equal(imported.body.added,2);assert.equal(imported.body.blocked,1);assert.equal(imported.body.active.length,1);
  assert.equal((await local(2,'step')).status,409,'an already open form stops advancing after history import');assert.equal((await local(3,'claim')).status,409);
  const ledger=await api('/preparation-handoff/ledger');assert.equal(ledger.status,200);assert(ledger.body.records.some(r=>r.record_id.startsWith('imported:')));assert.doesNotMatch(JSON.stringify(ledger.body),/SYNTHETIC_PASSWORD_HASH|u@example.invalid|resume.pdf/);
  const reserve=await api('/preparation-handoff/reserve','POST',{schema_version:2,request_id:'integrated_reservation_0001',expected_revision:ledger.body.revision,identity:{url:fixtureURL(3),employer:'Fictional 3',title:'Engineer 3',location:'Canada'}});assert.equal(reserve.body.decision,'blocked');assert.equal(reserve.body.submission_allowed,false);
  assert.equal((await local(4,'claim')).status,200);
  raw.prepare("INSERT INTO preparation_campaigns VALUES('u','synthetic-campaign','p',20,20,'[]',1,?)").run(new Date().toISOString());raw.prepare("INSERT INTO preparation_members(campaign_id,job_id,user_id,position,title_group) VALUES('synthetic-campaign',?,'u',1,'Engineer')").run(fixtureJobId(4));
  assert.equal((await local(4,'step')).status,200);assert.equal((await api('/preparation-campaign','PUT',{enabled:false})).status,200);assert.equal((await local(4,'step')).status,409);
  assert.equal((await local(5,'claim')).status,200);assert.equal((await local(5,'step')).status,200);
  raw.exec("UPDATE applicants SET consent=0 WHERE id='p'");assert.equal((await local(5,'step')).status,403);
  assert.equal((await api('/jobs/'+fixtureJobId(5)+'/local/step','POST',{},'other')).status,404);assert.equal((await api('/jobs/'+fixtureJobId(5)+'/local/step','POST',{},null)).status,401);
  raw.exec("UPDATE guard_accounts SET stopped=1 WHERE user_id='u'");
  assert.equal(raw.prepare('SELECT count(*) n FROM employer_receipts').get().n,0);
  assert.equal((await local(1,'submitted',{url:fixtureURL(1),afterSubmit:true,receipt:'Your application has been received.'})).status,200,'receipt evidence survives Stop and revoked preparation consent');
  assert.equal(raw.prepare('SELECT count(*) n FROM employer_receipts').get().n,1);assert.equal(raw.prepare('SELECT count(*) n FROM guard_protections').get().n>0,true);
  assert.equal(hashFile(f.path),snapshot.manifest.database_sha256,'source image remains unchanged');
 }finally{
  child.kill();await exited;raw.close();const inside=relative(resolve(tmpdir()),resolve(root));if(!inside||inside.startsWith('..'))throw Error('invalid_fixture_cleanup');rmSync(root,{recursive:true,force:true});
 }
});
