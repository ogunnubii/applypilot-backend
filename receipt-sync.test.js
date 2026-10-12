import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installReceiptSync,syncLocalReceipt} from './receipt-sync.js';
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
