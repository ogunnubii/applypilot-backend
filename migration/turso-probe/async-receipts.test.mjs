import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createClient} from '@libsql/client';
import {installReceiptSync,syncLocalReceipt as originalLocal,syncHostedReceipt as originalHosted} from '../../receipt-sync.js';
import {syncLocalReceipt,syncHostedReceipt} from './receipt-repository.mjs';
import {writeTransaction,UncertainCommitError} from './async-transactions.mjs';

const schema=`CREATE TABLE users(id TEXT PRIMARY KEY);
CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),local_owner TEXT,local_attempt_at TEXT,url TEXT,status TEXT,confirmation TEXT,challenge TEXT,local_phase TEXT,updated_at TEXT);
CREATE TABLE events(id INTEGER PRIMARY KEY,job_id TEXT REFERENCES jobs(id),at TEXT,type TEXT,message TEXT);
CREATE TABLE autonomous_attempts(job_id TEXT PRIMARY KEY REFERENCES jobs(id),owner TEXT,created_at TEXT);
INSERT INTO users VALUES('u');
INSERT INTO jobs VALUES('j','u','owner','2026-01-01T00:00:00Z','https://jobs.lever.co/org/role','local_browser',NULL,'Submission in progress','verifying',NULL);`;
const input={url:'https://jobs.lever.co/org/role',receipt:'Your application has been received.',afterSubmit:true,observedAt:'2026-01-01T00:01:00.000Z',receiptId:'fictional-receipt'};
async function fixture(t){
 const source=new DatabaseSync(':memory:');source.exec(schema);installReceiptSync(source);
 const client=createClient({url:':memory:',intMode:'bigint'});t.after(()=>{source.close();client.close()});
 await client.executeMultiple('PRAGMA foreign_keys=ON;'+schema);
 await client.execute(source.prepare("SELECT sql FROM sqlite_master WHERE name='employer_receipts'").get().sql);
 return {source,client};
}
async function state(client){
 const result={};for(const table of ['jobs','events','employer_receipts'])result[table]=(await client.execute('SELECT * FROM '+table)).rows.map(r=>{
  const item=Object.fromEntries(Object.entries(r).filter(([k])=>!/^\d+$/.test(k)));delete item.updated_at;delete item.synced_at;
  if(item.id!==undefined&&typeof item.id==='bigint')item.id=Number(item.id);return item;
 });return result;
}
function originalState(db){
 const result={};for(const table of ['jobs','events','employer_receipts'])result[table]=db.prepare('SELECT * FROM '+table).all().map(r=>{const item={...r};delete item.updated_at;delete item.synced_at;return item});return result;
}

test('async local receipt has the same persisted evidence and idempotent later-outcome behavior',async t=>{
 const {client,source}=await fixture(t);
 assert.deepEqual(await syncLocalReceipt(client,'j','u','owner',input),originalLocal(source,'j','u','owner',input));
 await client.execute("UPDATE jobs SET status='interview'");source.exec("UPDATE jobs SET status='interview'");
 assert.deepEqual(await syncLocalReceipt(client,'j','u','owner',{...input,observedAt:new Date().toISOString()}),originalLocal(source,'j','u','owner',input));
 assert.deepEqual(await state(client),originalState(source));
});
test('async receipt rejects owner, tenant, URL, missing attempt and nonreceipt without changing state',async t=>{
 const {client}=await fixture(t),before=await state(client);
 for(const [uid,owner,value] of [['u','wrong',input],['other','owner',input],['u','owner',{...input,url:'https://jobs.lever.co/org/other'}],['u','owner',{...input,afterSubmit:false}],['u','owner',{...input,receipt:'Click Submit'}]])await assert.rejects(syncLocalReceipt(client,'j',uid,owner,value));
 assert.deepEqual(await state(client),before);
 await client.execute('UPDATE jobs SET local_attempt_at=NULL');
 await assert.rejects(syncLocalReceipt(client,'j','u','owner',input));
 assert.equal((await client.execute('SELECT COUNT(*) n FROM employer_receipts')).rows[0].n,0n);
});
test('event insertion failure rolls back receipt, outcome and event together',async t=>{
 const {client}=await fixture(t),before=await state(client);
 await client.execute("CREATE TRIGGER fictional_failure BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'synthetic_event_failure'); END");
 await assert.rejects(syncLocalReceipt(client,'j','u','owner',input),/synthetic_event_failure/);
 assert.deepEqual(await state(client),before);
});
test('hosted receipt requires a preexisting reservation and preserves later outcomes',async t=>{
 const {client,source}=await fixture(t);
 await client.execute("UPDATE jobs SET local_owner=NULL,status='needs_review'");source.exec("UPDATE jobs SET local_owner=NULL,status='needs_review'");
 await assert.rejects(syncHostedReceipt(client,'j','u',input));assert.throws(()=>originalHosted(source,'j','u',input));
 const insert="INSERT INTO autonomous_attempts VALUES('j','hosted-worker','2026-01-01T00:00:00Z')";await client.execute(insert);source.exec(insert);
 assert.deepEqual(await syncHostedReceipt(client,'j','u',input),originalHosted(source,'j','u',input));
 await client.execute("UPDATE jobs SET status='offer'");source.exec("UPDATE jobs SET status='offer'");
 assert.deepEqual(await syncHostedReceipt(client,'j','u',input),originalHosted(source,'j','u',input));
 assert.deepEqual(await state(client),originalState(source));
});
test('foreign keys are enforced and disabled enforcement fails closed',async t=>{
 const {client}=await fixture(t);
 await assert.rejects(writeTransaction(client,tx=>tx.run("INSERT INTO events(job_id) VALUES('missing')")),/FOREIGN KEY/);
 await client.execute('PRAGMA foreign_keys=OFF');
 let called=false;await assert.rejects(writeTransaction(client,async()=>{called=true}),/foreign_keys_must_be_enabled/);assert.equal(called,false);
});
test('a lost commit response is uncertain and is never automatically retried',async()=>{
 let starts=0,commits=0,rollbacks=0,closed=0,actions=0;
 const client={async transaction(){starts++;return {async execute(){return {rows:[{foreign_keys:1n}]}},async commit(){commits++;throw Error('synthetic lost response')},async rollback(){rollbacks++},close(){closed++}}}};
 await assert.rejects(writeTransaction(client,async()=>{actions++;return {ok:true}}),error=>error instanceof UncertainCommitError);
 assert.deepEqual({starts,commits,rollbacks,closed,actions},{starts:1,commits:1,rollbacks:0,closed:1,actions:1});
});
test('callback failure rolls back once and escaped transaction handles cannot be reused',async()=>{
 let commits=0,rollbacks=0,closed=0,escaped;
 const client={async transaction(){return {async execute(){return {rows:[{foreign_keys:1n}]}},async commit(){commits++},async rollback(){rollbacks++},close(){closed++}}}};
 await assert.rejects(writeTransaction(client,async tx=>{escaped=tx;throw Error('fictional_failure')}),/fictional_failure/);
 await assert.rejects(escaped.get('SELECT 1'),/already_finished/);
 assert.deepEqual({commits,rollbacks,closed},{commits:0,rollbacks:1,closed:1});
});
test('integer conversion refuses silent precision loss',async t=>{
 const {client}=await fixture(t);
 await assert.rejects(writeTransaction(client,tx=>tx.get('SELECT 9007199254740993 AS unsafe')),/integer_out_of_safe_range/);
});

for(const mode of ['local','hosted'])test(`async ${mode} receipt validates full text and matches native storage/replay`,async t=>{
 const {client,source}=await fixture(t);
 if(mode==='hosted'){
  const setup="UPDATE jobs SET local_owner=NULL,status='needs_review'; INSERT INTO autonomous_attempts VALUES('j','hosted-worker','2026-01-01T00:00:00Z')";
  await client.executeMultiple(setup);source.exec(setup);
 }
 const original=value=>mode==='local'?originalLocal(source,'j','u','owner',value):originalHosted(source,'j','u',value);
 const migrated=value=>mode==='local'?syncLocalReceipt(client,'j','u','owner',value):syncHostedReceipt(client,'j','u',value);
 const receipt='Your application has been received. '+'Additional details. '.repeat(30),before=await state(client);
 const invalid=[receipt+'Your application was not submitted.',receipt+'Application limit has been reached.',receipt+'Placeholder confirmation.',receipt+'Your application is pending.',receipt+'\0',receipt+'\ud800',receipt+'é'.repeat(4096),null,3,{}];
 for(const text of invalid){assert.throws(()=>original({...input,receipt:text}));await assert.rejects(migrated({...input,receipt:text}));}
 assert.deepEqual(await state(client),before);assert.deepEqual(await state(client),originalState(source));
 assert.deepEqual(await migrated({...input,receipt}),original({...input,receipt}));
 assert.equal((await state(client)).employer_receipts[0].receipt_text,receipt);
 await client.execute("UPDATE jobs SET status='offer'");source.exec("UPDATE jobs SET status='offer'");
 const recorded=await state(client);
 for(const text of invalid){assert.throws(()=>original({...input,receipt:text}));await assert.rejects(migrated({...input,receipt:text}));}
 assert.equal((await migrated({...input,receipt,receiptId:'changed'})).alreadySynced,true);
 assert.equal(original({...input,receipt,receiptId:'changed'}).alreadySynced,true);
 assert.deepEqual(await state(client),recorded);assert.deepEqual(await state(client),originalState(source));
});
