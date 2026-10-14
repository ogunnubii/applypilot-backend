import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {installReceiptSync,syncHostedReceipt} from '../receipt-sync.js';
process.env.SESSION_SECRET||='0123456789abcdef0123456789abcdef';
const {Handoffs}=await import('../handoff.js');

function browser(id){
 const state={text:'Application form',url:`https://jobs.lever.co/example/${id}`,closed:0,reads:0};
 const frame={url:()=>state.frameURL||state.url,locator:()=>({innerText:async()=>{state.reads++;if(state.failRead)throw Error('Temporary read failure');if(state.redirectDuringRead)state.url='https://jobs.lever.co/example/other';return state.text;}})};
 const page={url:()=>state.url,isClosed:()=>false,frames:()=>[frame]};
 const context={pages:()=>[page],close:async()=>state.closed++};
 return {state,page,context,job:{id,user_id:'u',url:state.url,challenge:'Unconfirmed submission'}};
}

test('retained receipt monitor runs without a view or Submit and persists the matching reserved attempt once',async()=>{
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE jobs(id,user_id,local_owner,url,status,confirmation,challenge,updated_at);CREATE TABLE events(job_id,at,type,message);CREATE TABLE autonomous_attempts(job_id,owner,created_at);");installReceiptSync(db);
 const b=browser('j');db.prepare("INSERT INTO jobs VALUES('j','u',NULL,?,'needs_review',NULL,'Unconfirmed submission',NULL)").run(b.job.url);
 db.exec("INSERT INTO autonomous_attempts VALUES('j','hosted-worker','2026-01-01T00:00:00Z')");
 const h=new Handoffs({onSubmitted:(job,receipt,observed)=>syncHostedReceipt(db,job.id,job.user_id,{...observed,receipt})});
 await h.hold(b.job,b.context,b.page);await h.observeReceipts();assert.equal(b.state.closed,0);
 b.state.text='Your application has been received';
 db.exec("CREATE TRIGGER storage_failure BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'Temporary storage error'); END;");
 await h.observeReceipts();assert.equal(h.sessions.size,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM employer_receipts').get().n,0);
 assert.equal(b.state.closed,0);assert.equal(h.sessions.get('j').busy,false);
 db.exec('DROP TRIGGER storage_failure');await h.observeReceipts();await h.observeReceipts();
 const row=db.prepare('SELECT * FROM employer_receipts').get();assert.equal(row.job_id,'j');assert.equal(row.attempt_at,'2026-01-01T00:00:00Z');assert.equal(row.owner,'hosted-worker');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM autonomous_attempts').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n,1);
 assert.equal(db.prepare('SELECT status FROM jobs').get().status,'submitted');assert.equal(h.sessions.size,0);assert.equal(b.state.closed,1);db.close();
});

test('background observation rejects unattempted, preexisting, unrelated, changed and negative receipts',async()=>{
 for(const scenario of ['unattempted','preexisting','other-page','other-frame','changed','negative','busy']){
  const b=browser(scenario);let confirmed=0;
  if(scenario==='unattempted')b.job.challenge='Ready to submit';
  if(scenario==='preexisting')b.state.text='Your application has been received';
  const h=new Handoffs({onSubmitted:()=>confirmed++});await h.hold(b.job,b.context,b.page);
  b.state.text=scenario==='negative'?'No application received. Please try again.':'Your application has been received';
  if(scenario==='other-page')b.state.url='https://jobs.lever.co/example/other';
  if(scenario==='other-frame')b.state.frameURL='https://jobs.lever.co/example/other';
  if(scenario==='changed')b.state.redirectDuringRead=true;
  if(scenario==='busy')h.sessions.get(b.job.id).busy=true;
  await h.observeReceipts();assert.equal(confirmed,0,scenario);assert.equal(b.state.closed,0,scenario);assert.equal(h.sessions.size,1,scenario);
 }
});

test('a failed receipt callback does not stop another session and observer failures are retried safely',async()=>{
 const a=browser('a'),b=browser('b');let fail=true;const confirmed=[];
 const h=new Handoffs({onSubmitted:async job=>{if(job.id==='a'&&fail)throw Error('Storage busy');confirmed.push(job.id);}});
 for(const x of [a,b]){await h.hold(x.job,x.context,x.page);x.state.text='Your application has been received';}
 a.state.failRead=true;await h.observeReceipts();assert.deepEqual(confirmed,['b']);assert.equal(h.sessions.size,1);
 a.state.failRead=false;await h.observeReceipts();assert.deepEqual(confirmed,['b']);
 fail=false;await h.observeReceipts();assert.deepEqual(confirmed,['b','a']);assert.equal(h.sessions.size,0);
});

test('background observation records employer refusal once and never converts it to a receipt',async()=>{
 const b=browser('blocked');b.job.url=b.state.url='https://jobs.ashbyhq.com/example/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';let refused=0,confirmed=0;
 const h=new Handoffs({onRejection:()=>refused++,onSubmitted:()=>confirmed++});await h.hold(b.job,b.context,b.page);
 b.state.text="We couldn't submit your application. Your application submission was flagged as possible spam.";
 await h.observeReceipts();await h.observeReceipts();assert.equal(refused,1);assert.equal(confirmed,0);assert.equal(b.state.closed,0);
});

test('worker schedules background observation independently of dashboard requests',()=>{
 const worker=readFileSync(new URL('../worker.js',import.meta.url),'utf8');
 assert(worker.includes('await handoffs.observeReceipts()'));assert(worker.includes('setInterval(()=>receiptTick().catch(()=>{}),5000)'));
 assert(worker.includes('onSubmitted:async(job,receiptText,observed)=>'));
 assert(worker.includes('await syncHostedReceipt(asyncDatabase,job.id,job.user_id,{...observed,receipt:receiptText})'));
});

test('expiry checks one last receipt, retains persistence failures and protects unresolved attempts',async()=>{
 let time=0,fail=true;const notices=[],confirmed=[];
 const h=new Handoffs({clock:()=>time,onClose:(job,message)=>notices.push({id:job.id,message}),onSubmitted:job=>{if(fail)throw Error('Storage busy');confirmed.push(job.id);}});
 const late=browser('late'),unknown=browser('unknown');
 await h.hold(late.job,late.context,late.page);await h.hold(unknown.job,unknown.context,unknown.page);
 late.state.text='Your application has been received';time=16*60*1000;
 await h.expire();assert.equal(late.state.closed,0);assert.equal(unknown.state.closed,1);assert.match(notices[0].message,/attempt stays protected; do not submit it again/);
 fail=false;await h.expire();assert.deepEqual(confirmed,['late']);assert.equal(late.state.closed,1);assert.equal(h.sessions.size,0);
});
