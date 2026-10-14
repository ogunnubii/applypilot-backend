import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installReceiptSync,syncLocalReceipt,syncHostedReceipt} from './receipt-sync.js';
test('receipt retry persists original evidence exactly once and preserves later interview status',()=>{
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE jobs(id,user_id,local_owner,local_attempt_at,url,status,confirmation,challenge,local_phase,updated_at);CREATE TABLE events(job_id,at,type,message);INSERT INTO jobs VALUES('j','u','owner','2026-01-01T00:00:00Z','https://jobs.lever.co/org/role','local_browser',NULL,'Submission in progress','verifying',NULL);`);installReceiptSync(db);
 const input={url:'https://jobs.lever.co/org/role',receipt:'Your application has been received.',afterSubmit:true,observedAt:'2026-01-01T00:01:00.000Z',receiptId:'r'};
 for(const x of [{...input,url:'https://jobs.lever.co/org/other'},{...input,afterSubmit:false},{...input,receipt:'Click Submit'}])assert.throws(()=>syncLocalReceipt(db,'j','u','owner',x));
 assert.throws(()=>syncLocalReceipt(db,'j','u','wrong',input));
 syncLocalReceipt(db,'j','u','owner',input);db.exec("UPDATE jobs SET status='interview'");
 assert(syncLocalReceipt(db,'j','u','owner',{...input,observedAt:new Date().toISOString()}).alreadySynced);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n,1);assert.equal(db.prepare('SELECT at FROM events').get().at,input.observedAt);
 assert.equal(db.prepare('SELECT status FROM jobs').get().status,'interview');assert.equal(db.prepare('SELECT observed_at FROM employer_receipts').get().observed_at,input.observedAt);db.close();
});

test('hosted receipt requires its reserved attempt, is atomic and reconciles exactly once after a restart',()=>{
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE jobs(id,user_id,local_owner,url,status,confirmation,challenge,updated_at);CREATE TABLE events(job_id,at,type,message);CREATE TABLE autonomous_attempts(job_id,owner,created_at);INSERT INTO jobs VALUES('j','u',NULL,'https://jobs.lever.co/org/role','needs_review',NULL,'Unconfirmed submission',NULL);`);installReceiptSync(db);
 const input={url:'https://jobs.lever.co/org/role',receipt:'Your application has been received.',observedAt:'2026-01-01T00:01:00.000Z'};
 assert.throws(()=>syncHostedReceipt(db,'j','u',input));db.exec("INSERT INTO autonomous_attempts VALUES('j','hosted-worker','2026-01-01T00:00:00Z')");
 assert.throws(()=>syncHostedReceipt(db,'j','other',input));assert.throws(()=>syncHostedReceipt(db,'j','u',{...input,url:'https://jobs.lever.co/org/else'}));
 db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'Synthetic storage failure'); END;");
 assert.throws(()=>syncHostedReceipt(db,'j','u',input),/storage failure/);assert.equal(db.prepare('SELECT COUNT(*) n FROM employer_receipts').get().n,0);assert.equal(db.prepare('SELECT status FROM jobs').get().status,'needs_review');
 db.exec('DROP TRIGGER reject_receipt');syncHostedReceipt(db,'j','u',input);assert.equal(db.prepare('SELECT status FROM jobs').get().status,'submitted');
 db.exec("UPDATE jobs SET status='interview'");assert.equal(syncHostedReceipt(db,'j','u',input).alreadySynced,true);assert.equal(db.prepare('SELECT status FROM jobs').get().status,'interview');assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n,1);assert.equal(db.prepare('SELECT observed_at FROM employer_receipts').get().observed_at,input.observedAt);db.close();
});

function receiptFixture(t,mode,status){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE jobs(id,user_id,local_owner,local_attempt_at,url,status,confirmation,challenge,local_phase,updated_at);
 CREATE TABLE events(job_id,at,type,message);
 CREATE TABLE autonomous_attempts(job_id,owner,created_at);
 CREATE TABLE preparation_handoff_protections(user_id,job_id,company,title,url,protection);`);
 const url='https://jobs.lever.co/org/role';
 db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)').run('j','u',mode==='local'?'owner':null,'2026-01-01T00:00:00.000Z',url,status??(mode==='local'?'local_browser':'needs_review'),null,'Unconfirmed submission','uncertain','2026-01-01T00:00:00.000Z');
 db.prepare('INSERT INTO autonomous_attempts VALUES(?,?,?)').run('j','hosted-worker','2026-01-01T00:00:00.000Z');
 db.prepare('INSERT INTO preparation_handoff_protections VALUES(?,?,?,?,?,?)').run('u','j','Org','Role',url,'uncertain');
 installReceiptSync(db);
 const input={url,receipt:'Your application has been received.',afterSubmit:true,observedAt:'2026-01-01T00:01:00.000Z',receiptId:'original'};
 const sync=value=>mode==='local'?syncLocalReceipt(db,'j','u','owner',value):syncHostedReceipt(db,'j','u',value);
 const state=()=>Object.fromEntries(['jobs','events','autonomous_attempts','preparation_handoff_protections','employer_receipts'].map(table=>[table,db.prepare('SELECT * FROM '+table).all()]));
 return {db,input,sync,state};
}

for(const mode of ['local','hosted']){
 test(`${mode}: full receipt validation rejects late contradictions before first write and replay`,t=>{
  const {input,sync,state}=receiptFixture(t,mode),before=state();
  const prefix='Your application has been received. '+ 'Informational details. '.repeat(25);
  assert(prefix.length>300);
  const invalid=[
   ...['Your application was not submitted.','Submission failed.','Your application is pending.','Your application submission was flagged as possible spam.','Application limit has been reached.','Placeholder confirmation.','Unconfirmed result.','Simulated response.','See example.com for details.'].map(suffix=>prefix+suffix),
   prefix+'x'.repeat(8192),prefix+'\0',prefix+'\ud800',prefix+'\udfff',null,undefined,1,{},['Your application has been received.']
  ];
  for(const receipt of invalid){assert.throws(()=>sync({...input,receipt}));assert.deepEqual(state(),before);}
  sync(input);const recorded=state();
  for(const receipt of invalid){assert.throws(()=>sync({...input,receipt}));assert.deepEqual(state(),recorded);}
 });

 test(`${mode}: long valid evidence is retained exactly and later outcomes survive safe replay`,t=>{
  for(const outcome of ['interview','rejected','offer']){
   const {db,input,sync,state}=receiptFixture(t,mode,outcome);
   const receipt='Your application has been received. '+ 'Informations supplémentaires. '.repeat(110);
   assert(receipt.length>300);assert(Buffer.byteLength(receipt,'utf8')<8192);
   const protection=state().preparation_handoff_protections,attempts=state().autonomous_attempts;
   sync({...input,receipt});const recorded=state();
   assert.equal(recorded.employer_receipts[0].receipt_text,receipt);
   assert.equal(recorded.events.length,1);assert(recorded.events[0].message.endsWith(receipt));
   assert.equal(recorded.jobs[0].status,outcome);assert.equal(recorded.jobs[0].local_attempt_at,'2026-01-01T00:00:00.000Z');
   assert.deepEqual(recorded.preparation_handoff_protections,protection);assert.deepEqual(recorded.autonomous_attempts,attempts);
   assert.equal(sync({...input,receipt,observedAt:'2026-01-01T00:02:00.000Z',receiptId:'replacement'}).alreadySynced,true);
   assert.deepEqual(state(),recorded);
   assert.equal(db.prepare('SELECT receipt_text FROM employer_receipts').get().receipt_text,receipt);
  }
 });

 test(`${mode}: input cap uses UTF-8 bytes and rejects invalid encodings without truncation`,t=>{
  const {input,sync,state}=receiptFixture(t,mode),prefix='Your application has been received. ';
  const valid=prefix+'é'.repeat(Math.floor((8192-Buffer.byteLength(prefix))/2));
  assert(Buffer.byteLength(valid)<=8192);assert(Buffer.byteLength(valid)>8190);
  assert.throws(()=>sync({...input,receipt:valid+'é'}));assert.equal(state().employer_receipts.length,0);
  sync({...input,receipt:valid});assert.equal(state().employer_receipts[0].receipt_text,valid);
 });

 test(`${mode}: full receipt, outcome and event roll back together on storage failure`,t=>{
  const {db,input,sync,state}=receiptFixture(t,mode),before=state();
  const receipt='Your application has been received. '+ 'Details. '.repeat(70);
  db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'synthetic_event_failure'); END");
  assert.throws(()=>sync({...input,receipt}),/synthetic_event_failure/);assert.deepEqual(state(),before);
  db.exec('DROP TRIGGER fail_event');sync({...input,receipt});
  assert.equal(state().employer_receipts[0].receipt_text,receipt);assert.equal(state().events.length,1);
 });
}
