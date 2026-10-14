import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@libsql/client';
import {createLibsqlDatabase} from '../../database/libsql.js';
import {installGuardSchema} from './guard-schema.mjs';
import {claimCandidate, recordReceipt} from './guard-repository.mjs';
import {exportPreparationLedger} from './preparation-ledger.mjs';

const posting = number => `https://job-boards.greenhouse.io/fictional/jobs/${number}`;
const candidate = (overrides={}) => ({userId:'u',requestId:'first-request',applicantId:'p',owner:'browser',company:'Fictional',title:'Platform Engineer',url:posting(1234),kind:'submission',...overrides});
async function fixture(t) {
 const raw=createClient({url:':memory:',intMode:'number'});
 await raw.execute('PRAGMA foreign_keys=ON');
 await raw.execute('PRAGMA recursive_triggers=OFF');
 await installGuardSchema(raw);
 await raw.execute("INSERT INTO guard_accounts VALUES('u',0),('other',0)");
 const db=createLibsqlDatabase(raw);t.after(()=>db.close());
 // Raw access is deliberate only in this adversarial fixture, to model a
 // different runtime SQL writer bypassing repository validation.
 const run=(sql,args=[])=>raw.execute({sql,args});
 const one=async(sql,args=[])=>[...(await run(sql,args)).rows][0];
 return {db,run,one};
}
async function submission(t){const f=await fixture(t);f.claim=await claimCandidate(f.db,candidate());return f;}
const immutableError=/immutable_|application_already_protected/;

test('raw DML cannot mutate or replace durable guards with recursive triggers disabled',async t=>{
 const f=await submission(t),{claimId}=f.claim;
 await f.run("INSERT INTO guard_identities VALUES('held','u','Held Employer','Different Role',NULL)");
 await f.run("INSERT INTO guard_holds VALUES('hold','u','held',NULL,'security')");
 await recordReceipt(f.db,{userId:'u',claimId,owner:'browser',afterSubmit:true,url:posting(1234),receipt:'Thank you for applying.'});
 await f.run("INSERT INTO guard_outcomes VALUES('outcome',1,?,'u','interview','2026-10-14T00:00:00Z')",[claimId]);
 assert.equal((await f.one('PRAGMA recursive_triggers')).recursive_triggers,0);
 const tables=['guard_identities','guard_protections','guard_holds','guard_claims','guard_intents','guard_events','guard_receipts','guard_outcomes'];
 for(const table of tables){
  const columns=[...(await f.run(`PRAGMA table_info(${table})`)).rows].map(row=>row.name);
  const row=await f.one(`SELECT * FROM ${table} LIMIT 1`),values=columns.map(column=>row[column]);
  const insert=`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`;
  await assert.rejects(f.run(`UPDATE ${table} SET ${columns[0]}=${columns[0]}`),immutableError,table+' UPDATE');
  await assert.rejects(f.run(`DELETE FROM ${table}`),immutableError,table+' DELETE');
  await assert.rejects(f.run(insert.replace('INSERT INTO','INSERT OR REPLACE INTO'),values),immutableError,table+' REPLACE');
  await assert.rejects(f.run(insert+` ON CONFLICT DO UPDATE SET ${columns[0]}=excluded.${columns[0]}`,values),immutableError,table+' UPSERT');
 }
 assert.equal((await f.one('SELECT COUNT(*) n FROM guard_receipts')).n,1);
 assert.equal((await f.one("SELECT COUNT(*) n FROM guard_events WHERE type='submitted'")).n,1);
});

test('account replacement cannot clear Stop and a stopped account cannot claim',async t=>{
 const {db,run,one}=await fixture(t);
 await run("UPDATE guard_accounts SET stopped=1 WHERE user_id='u'");
 await assert.rejects(run("INSERT OR REPLACE INTO guard_accounts VALUES('u',0)"),/immutable_account/);
 await assert.rejects(run("INSERT INTO guard_accounts VALUES('u',0) ON CONFLICT DO UPDATE SET stopped=0"),/immutable_account/);
 await assert.rejects(run("UPDATE guard_accounts SET user_id='renamed' WHERE user_id='u'"),/immutable_account/);
 await assert.rejects(run("DELETE FROM guard_accounts WHERE user_id='u'"),/immutable_account/);
 await assert.rejects(claimCandidate(db,candidate()),/account_stopped_or_missing/);
 assert.equal((await one('SELECT COUNT(*) n FROM guard_claims')).n,0);
 assert.equal((await one('SELECT COUNT(*) n FROM guard_identities')).n,0,'rejected claim rolls identity back');
});

test('old claim replay after Stop never becomes a fresh claim or click permission',async t=>{
 const {db,run,claim}=await submission(t);
 await run("UPDATE guard_accounts SET stopped=1 WHERE user_id='u'");
 assert.deepEqual(await claimCandidate(db,candidate()),{claimId:claim.claimId,fresh:false,state:'uncertain',submission_allowed:false});
 await assert.rejects(claimCandidate(db,candidate({requestId:'new-request',url:posting(9876),title:'Different Role'})),/account_stopped_or_missing/);
});

test('cross-account identities cannot be smuggled into protections, holds, claims or receipts',async t=>{
 const {db,run,one,claim}=await submission(t);
 await run("INSERT INTO guard_identities VALUES('foreign','other','Fictional','Platform Engineer',?)",[posting(1234)]);
 await assert.rejects(run("INSERT INTO guard_protections VALUES('bad','u','foreign','excluded','fixture')"),/FOREIGN KEY/);
 await assert.rejects(run("INSERT INTO guard_holds VALUES('bad','u','foreign',NULL,'security')"),/FOREIGN KEY/);
 await assert.rejects(run("INSERT INTO guard_claims VALUES('bad','u','bad-request','foreign','p','browser','submission','2026-10-14T00:00:00Z')"),/invalid_candidate_identity|FOREIGN KEY/);
 await assert.rejects(run("INSERT INTO guard_receipts VALUES(?,'u','browser','foreign',NULL,'Thank you for applying.','2026-10-14T00:00:00Z','2026-10-14T00:00:00Z')",[claim.claimId]),/unattributable_receipt|FOREIGN KEY/);
 const other=await claimCandidate(db,candidate({userId:'other',applicantId:'other-p'}));
 assert.equal(other.fresh,true,'unrelated account retains its own queue');
 assert.equal((await one('SELECT COUNT(*) n FROM guard_claims')).n,2);
});

test('an immutable old identity stays protected when an edited display identity is appended',async t=>{
 const {db,run,one,claim}=await submission(t);
 const old=await one('SELECT identity_id FROM guard_claims WHERE claim_id=?',[claim.claimId]);
 await assert.rejects(run('UPDATE guard_identities SET title=?,url=? WHERE id=?',['New Title',posting(5678),old.identity_id]),/immutable_guard_record/);
 await run("INSERT INTO guard_identities VALUES('edited','u','Fictional','New Title',?)",[posting(5678)]);
 await run("INSERT INTO guard_protections VALUES('edited-protection','u','edited','uncertain','identity-edit')");
 for(const input of [candidate({requestId:'old-again'}),candidate({requestId:'edited-again',url:posting(5678),title:'New Title'})])
  await assert.rejects(claimCandidate(db,input),/application_already_protected/);
 await assert.rejects(run('DELETE FROM guard_identities WHERE id=?',[old.identity_id]),/immutable_guard_record/);
 assert.equal((await one('SELECT COUNT(*) n FROM guard_protections')).n,2);
});

test('receipt attribution cannot use fuzzy employer and role match across requisitions',async t=>{
 const {run,one,claim}=await submission(t);
 await run("INSERT INTO guard_identities VALUES('other-posting','u','Fictional','Platform Engineer',?)",[posting(5678)]);
 await assert.rejects(run("INSERT INTO guard_receipts VALUES(?,'u','browser','other-posting',NULL,'Thank you for applying.','2026-10-14T00:00:00Z','2026-10-14T00:00:00Z')",[claim.claimId]),/unattributable_receipt/);
 assert.equal((await one('SELECT COUNT(*) n FROM guard_receipts')).n,0);
});

test('preparation reservation cannot acquire a submission intent or receipt through raw SQL',async t=>{
 const {db,run,one}=await fixture(t),preparationSnapshot=await exportPreparationLedger(db,'u'),claim=await claimCandidate(db,candidate({kind:'preparation',requestId:'preparation_request_0001',preparationSnapshot}));
 const c=await one('SELECT * FROM guard_claims WHERE claim_id=?',[claim.claimId]);
 await assert.rejects(run("INSERT INTO guard_intents VALUES(?,'u','browser',?)",[claim.claimId,c.created_at]),/invalid_intent/);
 await assert.rejects(run("INSERT INTO guard_receipts VALUES(?,'u','browser',?,NULL,'Thank you for applying.',?,?)",[claim.claimId,c.identity_id,c.created_at,c.created_at]),/unattributable_receipt/);
 assert.equal((await one('SELECT state FROM guard_claim_state')).state,'reserved');
});

test('raw DML cannot synthesize receipt evidence from empty or explicitly unsuccessful text',async t=>{
 for(const receipt of ['', 'Click Submit', 'Your application was not submitted.', 'Thank you for applying. Your application was not submitted.']){
  await t.test(receipt||'empty text',async t=>{
   const {run,one,claim}=await submission(t);
   const c=await one('SELECT * FROM guard_claims WHERE claim_id=?',[claim.claimId]);
   await assert.rejects(run("INSERT INTO guard_receipts VALUES(?,'u','browser',?,NULL,?,?,?)",[claim.claimId,c.identity_id,receipt,c.created_at,c.created_at]),/receipt|evidence/i);
   assert.equal((await one('SELECT state FROM guard_claim_state')).state,'uncertain');
   assert.equal((await one("SELECT COUNT(*) n FROM guard_events WHERE type='submitted'")).n,0);
  });
 }
});

test('raw DML cannot create receipt chronology before the attempt or beyond sync time',async t=>{
 for(const observed of ['not-a-date','2000-01-01T00:00:00.000Z','2999-01-01T00:00:00.000Z']){
  await t.test(observed,async t=>{
   const {run,one,claim}=await submission(t);
   const c=await one('SELECT * FROM guard_claims WHERE claim_id=?',[claim.claimId]);
   await assert.rejects(run("INSERT INTO guard_receipts VALUES(?,'u','browser',?,NULL,'Thank you for applying.',?,?)",[claim.claimId,c.identity_id,observed,c.created_at]),/receipt|chronology|time/i);
   assert.equal((await one('SELECT state FROM guard_claim_state')).state,'uncertain');
  });
 }
});

test('raw DML cannot forge receipt or intent lifecycle events',async t=>{
 const {run,one,claim}=await submission(t);
 const c=await one('SELECT * FROM guard_claims WHERE claim_id=?',[claim.claimId]);
 for(const [eventId,type,at] of [
  ['receipt:'+claim.claimId,'submitted',c.created_at],
  ['forged-receipt','submitted',c.created_at],
  ['forged-reservation','reserved',c.created_at],
  ['forged-intent','submission_intent',c.created_at],
  ['intent:'+claim.claimId,'submission_intent','2000-01-01T00:00:00.000Z']
 ])await assert.rejects(run('INSERT INTO guard_events VALUES(?,?,?,?,?)',[eventId,claim.claimId,'u',type,at]),/event|immutable/i);
 assert.equal((await one("SELECT COUNT(*) n FROM guard_events WHERE type='submitted'")).n,0);
 assert.equal((await one('SELECT state FROM guard_claim_state')).state,'uncertain');
});
