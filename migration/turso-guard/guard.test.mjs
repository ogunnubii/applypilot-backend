import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createClient} from '@libsql/client';
import {createLibsqlDatabase} from '../../database/libsql.js';
import {UncertainCommitError} from '../../database/async-database.js';
import {installGuardSchema} from './guard-schema.mjs';
import {claimCandidate,reconcileClaim,recordReceipt} from './guard-repository.mjs';
import {exportPreparationLedger} from './preparation-ledger.mjs';

const candidate=(overrides={})=>({userId:'u',requestId:'fictional-request',applicantId:'applicant',owner:'browser',company:'Fictional Example Inc',title:'Engineer',url:'https://jobs.lever.co/fictional/11111111-1111-1111-1111-111111111111',kind:'submission',...overrides});
const evidence=(claimId,overrides={})=>({userId:'u',claimId,owner:'browser',url:candidate().url,receipt:'Your application has been received.',afterSubmit:true,receiptId:'fictional-receipt',...overrides});
async function fixture(t,{file=false}={}) {
 let url=':memory:';
 if(file){
  const root=process.env.APPLYPILOT_ASYNC_TEST_ROOT;
  if(!root||!relative(resolve(tmpdir()),resolve(root))||relative(resolve(tmpdir()),resolve(root)).startsWith('..'))throw Error('Run via checks/run-async-tests.mjs');
  url=pathToFileURL(join(mkdtempSync(join(root,'guard-')),'fixture.sqlite')).href;
 }
 const raw=createClient({url,intMode:'bigint'});
 await raw.executeMultiple('PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA busy_timeout=0;');
 await installGuardSchema(raw);
 await raw.execute("INSERT INTO guard_accounts VALUES('u',0)");
 const db=createLibsqlDatabase(raw); t.after(()=>db.close());
 return {db,raw,url};
}
async function count(raw,table){return Number((await raw.execute('SELECT COUNT(*) AS n FROM '+table)).rows[0].n);}
async function protect(raw,{id='old',user='u',company='Fictional Example',title='Engineer',url=null,kind='uncertain'}={}){
 await raw.execute({sql:'INSERT INTO guard_identities VALUES(?,?,?,?,?)',args:[id,user,company,title,url]});
 await raw.execute({sql:'INSERT INTO guard_protections VALUES(?,?,?,?,?)',args:[id,user,id,kind,'synthetic-import']});
}

test('one committed claim records durable protection, intent, and events; same request only reconciles',async t=>{
 const {db,raw}=await fixture(t),first=await claimCandidate(db,candidate());
 assert.equal(first.fresh,true);assert.equal(first.submission_allowed,false);assert.equal(first.state,'uncertain');
 assert.equal(await count(raw,'guard_claims'),1);assert.equal(await count(raw,'guard_protections'),1);assert.equal(await count(raw,'guard_intents'),1);assert.equal(await count(raw,'guard_events'),2);
 assert.deepEqual(await claimCandidate(db,candidate()),{...first,fresh:false});
 assert.deepEqual(await reconcileClaim(db,candidate()),{...first,fresh:false});
 await assert.rejects(claimCandidate(db,candidate({owner:'other'})),/request_identity_changed/);
 await assert.rejects(claimCandidate(db,candidate({requestId:'new-request'})),/application_already_protected/);
 assert.deepEqual(await reconcileClaim(db,{...candidate(),owner:'other'}),{found:false,submission_allowed:false});
});
test('uncertain/history protections match normalized company and role, while another role remains eligible',async t=>{
 const {db,raw}=await fixture(t);
 await protect(raw,{company:'Fictiónal Example Incorporated',title:'Engineer',url:null});
 await assert.rejects(claimCandidate(db,candidate({title:'Engineer — remote',url:'https://boards.greenhouse.io/other-tenant/jobs/123'})),/application_already_protected/);
 assert.equal((await claimCandidate(db,candidate({title:'Accountant',requestId:'accountant',url:'https://boards.greenhouse.io/fictional/jobs/321'}))).fresh,true);
});
test('same ATS posting across changed labels and US/EU Lever hosts stays protected',async t=>{
 const {db,raw}=await fixture(t);
 await protect(raw,{company:'Old Label',title:'Old Title',url:candidate().url});
 await assert.rejects(claimCandidate(db,candidate({company:'Completely Different',title:'Other role',url:candidate().url.replace('jobs.lever.co','jobs.eu.lever.co')})),/application_already_protected/);
});
test('unsupported protected identity blocks every claim for its account instead of disappearing',async t=>{
 const {db,raw}=await fixture(t);
 await protect(raw,{company:'Different',title:'Unrelated',url:'https://jobs.lever.co/fictional/%31'});
 await assert.rejects(claimCandidate(db,candidate()),/invalid_protected_identity_blocks_account/);
 await raw.execute("INSERT INTO guard_accounts VALUES('other',0)");
 assert.equal((await claimCandidate(db,candidate({userId:'other'}))).fresh,true);
});
test('preparation reservation cannot create a submission intent or receive an employer receipt',async t=>{
 const {db,raw}=await fixture(t),preparationSnapshot=await exportPreparationLedger(db,'u'),c=await claimCandidate(db,candidate({kind:'preparation',preparationSnapshot}));
 assert.equal(c.state,'reserved');assert.equal(c.submission_allowed,false);assert.equal(await count(raw,'guard_intents'),0);
 await assert.rejects(recordReceipt(db,evidence(c.claimId)),/attributable_attempt_required/);
 await assert.rejects(raw.execute({sql:'INSERT INTO guard_intents VALUES(?,?,?,?)',args:[c.claimId,'u','browser',new Date().toISOString()]}),/invalid_intent/);
});
test('two independent clients competing for the same identity cannot both claim, and restart keeps protection',async t=>{
 const {db,raw,url}=await fixture(t,{file:true});
 const secondRaw=createClient({url,intMode:'bigint'});await secondRaw.executeMultiple('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=0;');
 const second=createLibsqlDatabase(secondRaw);t.after(()=>second.close());
 const results=await Promise.allSettled([claimCandidate(db,candidate({requestId:'client-one'})),claimCandidate(second,candidate({requestId:'client-two'}))]);
 assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value.fresh).length,1);
 const denied=results.find(r=>r.status==='rejected');assert.ok(denied);assert.match(String(denied.reason),/already_protected|BUSY|locked/);
 assert.equal(await count(raw,'guard_claims'),1);assert.equal(await count(raw,'guard_intents'),1);
 await db.close();await second.close();
 const reopenedRaw=createClient({url,intMode:'bigint'});await reopenedRaw.execute('PRAGMA foreign_keys=ON');
 const reopened=createLibsqlDatabase(reopenedRaw);t.after(()=>reopened.close());
 await assert.rejects(claimCandidate(reopened,candidate({requestId:'after-restart'})),/application_already_protected/);
});
test('AP2-style preparation versus submission race leaves exactly one durable reservation',async t=>{
 const {db,raw,url}=await fixture(t,{file:true}),otherRaw=createClient({url,intMode:'bigint'});
 await otherRaw.executeMultiple('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=0;');const other=createLibsqlDatabase(otherRaw);t.after(()=>other.close());
 const preparationSnapshot=await exportPreparationLedger(db,'u');
 const results=await Promise.allSettled([claimCandidate(db,candidate({kind:'preparation',requestId:'ap2_request_00001',preparationSnapshot})),claimCandidate(other,candidate({requestId:'native'}))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(await count(raw,'guard_protections'),1);
 const row=(await raw.execute('SELECT kind FROM guard_claims')).rows[0];assert.equal(await count(raw,'guard_intents'),row.kind==='submission'?1:0);
});

// This fault wrapper uses the real local libSQL transaction and commits its
// effects before dropping the response. It never retries or invokes an action.
function dropCommitClient(raw,when='after') {
 let armed=true;
 return {close(){},async transaction(mode){
  const tx=await raw.transaction(mode);
  return {execute:s=>tx.execute(s),rollback:()=>tx.rollback(),close:()=>tx.close(),async commit(){
   if(armed&&mode==='write'){armed=false;if(when==='after')await tx.commit();else await tx.rollback();throw Error('synthetic_lost_commit_response');}
   await tx.commit();
  }};
 }};
}
test('lost response after committed intent is uncertain; retries and reconciliation never produce a fresh claim',async t=>{
 const {db,raw}=await fixture(t),fault=createLibsqlDatabase(dropCommitClient(raw));t.after(()=>fault.close());
 await assert.rejects(claimCandidate(fault,candidate()),UncertainCommitError);
 assert.equal(await count(raw,'guard_intents'),1);
 assert.equal((await reconcileClaim(db,candidate())).fresh,false);
 assert.equal((await claimCandidate(db,candidate())).fresh,false);
 await assert.rejects(claimCandidate(db,candidate({requestId:'retry-new-id'})),/application_already_protected/);
});
test('lost response without a commit produces no evidence or automatic retry',async t=>{
 const {db,raw}=await fixture(t),fault=createLibsqlDatabase(dropCommitClient(raw,'before'));t.after(()=>fault.close());
 await assert.rejects(claimCandidate(fault,candidate()),UncertainCommitError);
 for(const table of ['guard_claims','guard_intents','guard_protections','guard_events','guard_identities'])assert.equal(await count(raw,table),0);
 assert.deepEqual(await reconcileClaim(db,candidate()),{found:false,submission_allowed:false});
});
test('intent event failure rolls back the entire claim and every new identity',async t=>{
 const {db,raw}=await fixture(t);
 await raw.execute("CREATE TRIGGER synthetic_event_failure BEFORE INSERT ON guard_events WHEN NEW.type='submission_intent' BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END");
 await assert.rejects(claimCandidate(db,candidate()),/synthetic_failure/);
 for(const table of ['guard_claims','guard_intents','guard_protections','guard_events','guard_identities'])assert.equal(await count(raw,table),0);
});
test('receipt is attributable and atomic, preserves first evidence and later outcome, and cannot reopen a claim',async t=>{
 const {db,raw}=await fixture(t),c=await claimCandidate(db,candidate());
 for(const override of [{owner:'other'},{userId:'other'},{url:candidate().url.replace(/1/g,'2')},{afterSubmit:false},{receipt:'Your application was not received.'}])await assert.rejects(recordReceipt(db,evidence(c.claimId,override)));
 assert.equal(await count(raw,'guard_receipts'),0);
 assert.deepEqual(await recordReceipt(db,evidence(c.claimId)),{ok:true});
 const before=(await raw.execute('SELECT * FROM guard_receipts')).rows[0];
 await raw.execute({sql:'INSERT INTO guard_outcomes VALUES(?,?,?,?,?,?)',args:['interview',1,c.claimId,'u','interview',new Date().toISOString()]});
 assert.deepEqual(await recordReceipt(db,evidence(c.claimId,{receipt:'Thank you for applying.',observedAt:'2030-01-01T00:00:00Z'})),{ok:true,alreadySynced:true});
 assert.deepEqual((await raw.execute('SELECT * FROM guard_receipts')).rows[0],before);
 assert.equal((await reconcileClaim(db,candidate())).state,'interview');assert.equal(await count(raw,'guard_events'),3);
 await assert.rejects(claimCandidate(db,candidate({requestId:'after-receipt'})),/application_already_protected/);
});
test('receipt event failure rolls back evidence and status together',async t=>{
 const {db,raw}=await fixture(t),c=await claimCandidate(db,candidate());
 await raw.execute("CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON guard_events WHEN NEW.type='submitted' BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END");
 await assert.rejects(recordReceipt(db,evidence(c.claimId)),/synthetic_failure/);
 assert.equal(await count(raw,'guard_receipts'),0);assert.equal(await count(raw,'guard_identities'),1);
 assert.equal((await reconcileClaim(db,candidate())).state,'uncertain');
});

test('receipt validation covers full raw text before first write and idempotent reconciliation',async t=>{
 const {db,raw}=await fixture(t),c=await claimCandidate(db,candidate());
 const prefix='Your application has been received.'+' '.repeat(400);
 const invalid=[prefix+'Your application was not received.',prefix+'This is a test receipt.',prefix+'Your application is pending.',prefix+'You have reached your application limit.',prefix+' '.repeat(8192),prefix+'\0',prefix+'\ud800',null,42,{toString:()=> 'Your application has been received.'}];
 for(const receipt of invalid)await assert.rejects(recordReceipt(db,evidence(c.claimId,{receipt})),/affirmative_receipt_required|invalid_receipt_text/);
 assert.equal(await count(raw,'guard_receipts'),0);
 await recordReceipt(db,evidence(c.claimId));
 const before=(await raw.execute('SELECT * FROM guard_receipts')).rows[0];
 for(const receipt of invalid)await assert.rejects(recordReceipt(db,evidence(c.claimId,{receipt})),/affirmative_receipt_required|invalid_receipt_text/);
 assert.deepEqual((await raw.execute('SELECT * FROM guard_receipts')).rows[0],before);assert.equal(await count(raw,'guard_events'),3);
});

test('integrated receipt SQL accepts bounded native variants and preserves full evidence after character 300',async t=>{
 const {db,raw}=await fixture(t),c=await claimCandidate(db,candidate());
 const receipt='Applicant verified: YOUR APPLICATION HAS BEEN RECEIVED.\n'+'Please do not reply.\n'.repeat(20);
 assert(receipt.length>300);
 await raw.execute({sql:'INSERT INTO guard_identities VALUES(?,?,?,?,?)',args:['raw-evidence','u','Fictional Example Inc','Engineer',candidate().url]});
 const now=new Date().toISOString();
 for(const text of [receipt+'Your application could not be submitted.',receipt+'This is a placeholder.',receipt+'Your application submission was flagged as possible spam.']){
  await assert.rejects(raw.execute({sql:'INSERT INTO guard_receipts VALUES(?,?,?,?,?,?,?,?)',args:[c.claimId,'u','browser','raw-evidence',null,text,now,now]}),/unsupported_receipt_text/);
 }
 assert.equal(await count(raw,'guard_receipts'),0);
 await recordReceipt(db,evidence(c.claimId,{receipt}));
 assert.equal((await raw.execute('SELECT receipt_text FROM guard_receipts')).rows[0].receipt_text,receipt);
 assert.equal(await count(raw,'guard_events'),3);
});
test('receipt committed with lost response reconciles idempotently with one event',async t=>{
 const {db,raw}=await fixture(t),c=await claimCandidate(db,candidate()),fault=createLibsqlDatabase(dropCommitClient(raw));t.after(()=>fault.close());
 await assert.rejects(recordReceipt(fault,evidence(c.claimId)),UncertainCommitError);
 assert.deepEqual(await recordReceipt(db,evidence(c.claimId)),{ok:true,alreadySynced:true});
 assert.equal(await count(raw,'guard_receipts'),1);assert.equal(await count(raw,'guard_events'),3);
 assert.equal((await reconcileClaim(db,candidate())).state,'submitted');
});
