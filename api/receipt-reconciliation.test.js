import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {fixture} from '../database/test-fixture.js';
import {UncertainCommitError} from '../database/async-database.js';
import {syncLocalReceipt,syncHostedReceipt} from './receipt-reconciliation.js';

const url='https://jobs.lever.co/fictional/11111111-1111-1111-1111-111111111111',at='2026-10-13T12:00:00.000Z';
const schema=`CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,status TEXT,local_owner TEXT,local_attempt_at TEXT,url TEXT,confirmation TEXT,challenge TEXT,local_phase TEXT,updated_at TEXT);
 CREATE TABLE autonomous_attempts(job_id TEXT PRIMARY KEY REFERENCES jobs(id),owner TEXT,created_at TEXT);
 CREATE TABLE employer_receipts(job_id TEXT PRIMARY KEY REFERENCES jobs(id),user_id TEXT NOT NULL,owner TEXT NOT NULL,application_url TEXT,receipt_url TEXT,attempt_at TEXT,receipt_text TEXT,observed_at TEXT,synced_at TEXT,receipt_id TEXT);
 CREATE TABLE events(id INTEGER PRIMARY KEY,job_id TEXT REFERENCES jobs(id),at TEXT,type TEXT,message TEXT);
 INSERT INTO jobs VALUES('local','u','local_browser','browser','${at}','${url}',NULL,'Unconfirmed submission','uncertain','${at}');
 INSERT INTO jobs VALUES('hosted','u','needs_review',NULL,NULL,'${url}',NULL,'Unconfirmed submission','ready','${at}');
 INSERT INTO autonomous_attempts VALUES('hosted','hosted-worker','${at}');`;
const input=()=>({url,receipt:'Your application has been received.',afterSubmit:true,observedAt:at,receiptId:'synthetic-id'});
for(const kind of ['native','libsql'])for(const source of ['local','hosted']){
 const sync=(db,body=input(),uid='u')=>source==='local'?syncLocalReceipt(db,source,uid,'browser',body):syncHostedReceipt(db,source,uid,body);
 test(`${kind}/${source}: full receipt, outcome and event are atomic; replay preserves original evidence and later outcomes`,async t=>{
  const {db}=await fixture(t,kind,schema),body={...input(),receipt:'Your application has been received. '+ 'Thank you. '.repeat(60)};
  assert.deepEqual(await sync(db,body),{ok:true});
  const saved=await db.read(tx=>tx.get('SELECT * FROM employer_receipts WHERE job_id=?',source));assert.equal(saved.receipt_text,body.receipt);
  assert.equal((await db.read(tx=>tx.get('SELECT status FROM jobs WHERE id=?',source))).status,'submitted');
  await db.write(tx=>tx.run("UPDATE jobs SET status='offer',updated_at='later-outcome' WHERE id=?",source));
  assert.deepEqual(await sync(db,{...input(),observedAt:new Date().toISOString()}),{ok:true,alreadySynced:true});
  assert.deepEqual(await db.read(tx=>tx.get('SELECT * FROM employer_receipts WHERE job_id=?',source)),saved);
  assert.deepEqual(await db.read(tx=>tx.get('SELECT status,updated_at FROM jobs WHERE id=?',source)),{status:'offer',updated_at:'later-outcome'});
  assert.equal((await db.read(tx=>tx.get("SELECT count(*) n FROM events WHERE job_id=? AND type='submitted'",source))).n,1);
  await assert.rejects(sync(db,{...input(),receipt:body.receipt+' The application could not be submitted.'}));
 });
 test(`${kind}/${source}: wrong account, URL, missing attempt and late contradictory evidence fail without receipt writes`,async t=>{
  const {db}=await fixture(t,kind,schema);
  await assert.rejects(sync(db,input(),'other'));await assert.rejects(sync(db,{...input(),url:url+'?different=1'}));
  for(const receipt of ['Your application is pending.',input().receipt+' '.repeat(400)+' We could not submit your application.',input().receipt+' '.repeat(8192),input().receipt+'\u0000'])await assert.rejects(sync(db,{...input(),receipt}));
  if(source==='local')await db.write(tx=>tx.run("UPDATE jobs SET local_attempt_at=NULL WHERE id='local'"));else await db.write(tx=>tx.run('DELETE FROM autonomous_attempts'));
  await assert.rejects(sync(db));assert.equal((await db.read(tx=>tx.get('SELECT count(*) n FROM employer_receipts'))).n,0);
 });
 test(`${kind}/${source}: event failure rolls receipt/outcome back; lost acknowledgement never retries the write`,async t=>{
  const {db,path}=await fixture(t,kind,schema),raw=new DatabaseSync(path);raw.exec("CREATE TRIGGER synthetic_receipt_event_failure BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'synthetic_receipt_fault');END;");
  try{
   await assert.rejects(sync(db),/synthetic_receipt_fault/);assert.equal((await db.read(tx=>tx.get('SELECT count(*) n FROM employer_receipts'))).n,0);assert.equal((await db.read(tx=>tx.get('SELECT confirmation FROM jobs WHERE id=?',source))).confirmation,null);
   raw.exec('DROP TRIGGER synthetic_receipt_event_failure');let writes=0;
   const fault={async write(fn){writes++;await db.write(fn);throw new UncertainCommitError();}};await assert.rejects(sync(fault),UncertainCommitError);assert.equal(writes,1);assert.equal((await sync(db)).alreadySynced,true);
  }finally{raw.close();}
 });
}
