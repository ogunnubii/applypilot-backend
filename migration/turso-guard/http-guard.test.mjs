import test from 'node:test';
import assert from 'node:assert/strict';
import {UncertainCommitError} from '../../database/async-database.js';
import {claimCandidate,reconcileClaim,recordReceipt} from './guard-repository.mjs';
import {guardHttpFixture} from './http-fixture.mjs';

const candidate={userId:'u',requestId:'synthetic-http-request',applicantId:'profile',owner:'browser',company:'Fictional',title:'Platform Engineer',url:'https://job-boards.greenhouse.io/fictional/jobs/1234',kind:'submission'};
const count=(engine,table)=>engine.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

test('official HTTP driver commits the full SQL-enforced claim graph through the shared repository',async t=>{
 const {db,engine,counts}=await guardHttpFixture(t);
 const result=await claimCandidate(db,candidate);
 assert.equal(result.fresh,true);assert.equal(result.submission_allowed,false);assert.equal(result.state,'uncertain');
 for(const table of ['guard_identities','guard_claims','guard_intents','guard_protections'])assert.equal(count(engine,table),1,table);
 assert.deepEqual(engine.prepare('SELECT type FROM guard_events ORDER BY type').all().map(row=>row.type),['reserved','submission_intent']);
 const claim=engine.prepare('SELECT * FROM guard_claims').get(),intent=engine.prepare('SELECT * FROM guard_intents').get();
 assert.equal(claim.claim_id,result.claimId);assert.equal(intent.claim_id,claim.claim_id);assert.equal(intent.owner,candidate.owner);assert.equal(intent.created_at,claim.created_at);
 assert.deepEqual(await reconcileClaim(db,candidate),{claimId:result.claimId,fresh:false,state:'uncertain',submission_allowed:false});
 assert.equal(counts.claims,1);assert.equal(counts.begin,2);assert.equal(counts.commit,2);assert.equal(counts.rollback,0);
});

test('official HTTP driver reports lost committed claim response as uncertain; replay cannot grant a fresh action',async t=>{
 const fixture=await guardHttpFixture(t),{db,engine,counts}=fixture;
 // The fixture commits actual SQL including intent/events/protection, then
 // throws from fetch instead of returning the COMMIT/close pipeline response.
 fixture.dropNextCommitResponse();
 await assert.rejects(claimCandidate(db,candidate),UncertainCommitError);
 assert.equal(counts.commit,1);assert.equal(counts.droppedCommitResponses,1);assert.equal(counts.claims,1);
 const committed=engine.prepare('SELECT claim_id FROM guard_claims').get();
 for(const table of ['guard_claims','guard_intents','guard_protections'])assert.equal(count(engine,table),1,table);
 assert.equal(count(engine,'guard_events'),2);
 const replay=await claimCandidate(db,candidate);
 assert.deepEqual(replay,{claimId:committed.claim_id,fresh:false,state:'uncertain',submission_allowed:false});
 assert.equal(counts.claims,1,'the HTTP driver/adapter must not automatically retry the write');
 assert.equal(count(engine,'guard_events'),2);
 await assert.rejects(claimCandidate(db,{...candidate,requestId:'other-http-request'}),/application_already_protected/);
 assert.equal(count(engine,'guard_identities'),1,'rejected new request cannot leak a staged identity');
});

test('official HTTP driver expiration after claim and triggers rolls the entire graph back',async t=>{
 const fixture=await guardHttpFixture(t),{db,engine,counts}=fixture;
 fixture.expireAfterStatement(/^INSERT INTO guard_claims\b/i);
 // This fixture models the old stream becoming unusable after expiry. Its
 // rollback also fails, so the shared adapter must poison that connection.
 await assert.rejects(claimCandidate(db,candidate),error=>error.code==='database_rollback_failed_connection_closed');
 assert.equal(counts.expired,1);assert.equal(counts.claims,1);assert.equal(counts.commit,0);
 for(const table of ['guard_identities','guard_claims','guard_intents','guard_protections','guard_events','guard_receipts'])assert.equal(count(engine,table),0,table);
 assert.equal(engine.isTransaction,false);
 await assert.rejects(reconcileClaim(db,candidate),error=>error.code==='database_connection_closed');
 const recovered=fixture.connect();
 assert.deepEqual(await reconcileClaim(recovered,candidate),{found:false,submission_allowed:false});
 assert.equal(counts.claims,1,'recovery reads state without rerunning the failed claim');
});

test('official HTTP driver lost receipt commit response reconciles exactly once and preserves later outcome',async t=>{
 const fixture=await guardHttpFixture(t),{db,engine,counts}=fixture;
 const claim=await claimCandidate(db,candidate);
 const intent=engine.prepare('SELECT created_at FROM guard_intents').get();
 const input={userId:candidate.userId,claimId:claim.claimId,owner:candidate.owner,url:candidate.url,afterSubmit:true,receipt:'Thank you for applying.',observedAt:intent.created_at,receiptId:'synthetic-receipt'};
 fixture.dropNextCommitResponse();
 await assert.rejects(recordReceipt(db,input),UncertainCommitError);
 assert.equal(counts.commit,2);assert.equal(counts.droppedCommitResponses,1);assert.equal(counts.receipts,1);
 assert.equal(count(engine,'guard_receipts'),1);
 assert.equal(engine.prepare("SELECT COUNT(*) n FROM guard_events WHERE type='submitted'").get().n,1);
 const original=engine.prepare('SELECT * FROM guard_receipts').get();
 engine.prepare("INSERT INTO guard_outcomes VALUES('later-interview',1,?,'u','interview',?)").run(claim.claimId,new Date().toISOString());
 assert.deepEqual(await recordReceipt(db,{...input,receiptId:'different-retry-id',observedAt:new Date().toISOString()}),{ok:true,alreadySynced:true});
 assert.deepEqual(engine.prepare('SELECT * FROM guard_receipts').get(),original,'first receipt attribution and timestamps are immutable');
 assert.equal(engine.prepare('SELECT state FROM guard_claim_state').get().state,'interview');
 assert.equal(counts.receipts,1);assert.equal(count(engine,'guard_identities'),2);
 assert.equal(engine.prepare("SELECT COUNT(*) n FROM guard_events WHERE type='submitted'").get().n,1);
});
