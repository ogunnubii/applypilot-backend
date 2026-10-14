import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeFixture,fixtureJobId,FIXTURE_OWNER} from '../database/runtime-fixture.js';
import {openNativeDatabase} from '../database/native.js';
import {applicationHistory} from './application-history.js';
import {authorizePreparationStep} from './preparation-authorization.js';
import {UncertainCommitError} from '../database/async-database.js';

function setup(t){const f=runtimeFixture(process.env.APPLYPILOT_ASYNC_TEST_ROOT),db=openNativeDatabase(f.path);t.after(async()=>{await db.close();f.source.close();});return {...f,db};}
const row=(n,extra={})=>({company:'Fictional '+n,title:'Engineer '+n,status:'interview',...extra});
const post=(db,rows,uid='u')=>applicationHistory(db,{uid,method:'POST',input:{rows}});
test('wired history repository atomically blocks untouched duplicates and preserves active/unknown receipts and later outcomes',async t=>{
 const f=setup(t);f.add(1);f.add(2,{status:'local_browser'});f.add(3,{status:'needs_review',attempt:true});
 f.source.prepare('UPDATE jobs SET local_owner=? WHERE id=?').run(FIXTURE_OWNER,fixtureJobId(2));
 const unknown=f.source.prepare('SELECT * FROM jobs WHERE id=?').get(fixtureJobId(3));
 const result=await post(f.db,[row(1),row(2),row(3)]);assert.equal(result.status,200);assert.equal(result.body.added,3);assert.equal(result.body.blocked,1);assert.equal(result.body.active.length,2);
 assert.equal(f.source.prepare('SELECT status FROM jobs WHERE id=?').get(fixtureJobId(1)).status,'duplicate');assert.deepEqual(f.source.prepare('SELECT * FROM jobs WHERE id=?').get(fixtureJobId(3)),unknown);
 assert.equal(f.source.prepare('SELECT count(*) n FROM employer_receipts').get().n,0);
 assert.equal((await authorizePreparationStep(f.db,{uid:'u',jobId:fixtureJobId(2),owner:FIXTURE_OWNER})).status,409,'an active form cannot advance after external history was imported');
 const reimport=await post(f.db,[row(1,{status:'applied'})]);assert.equal(reimport.body.updated,1);assert.equal(reimport.body.blocked,0);
 const list=await applicationHistory(f.db,{uid:'u',method:'GET'});assert.equal(list.body.records.find(r=>r.company==='Fictional 1').status,'interview');assert.equal((await applicationHistory(f.db,{uid:'other',method:'GET'})).body.records.length,0);
 assert.throws(()=>f.source.prepare("UPDATE jobs SET status='running' WHERE id=?").run(fixtureJobId(1)),/repeat application blocked/);
 assert.throws(()=>f.source.prepare("UPDATE jobs SET local_attempt_at='2026-10-14' WHERE id=?").run(fixtureJobId(2)),/repeat submission blocked/);
});
test('history import validation, account scope and failure after duplicate write leave no partial import or event',async t=>{
 const f=setup(t);f.add(1);
 for(const rows of [[],null,[{company:'',title:'Engineer'}],[row(1,{status:'fabricated'})]])assert.equal((await post(f.db,rows)).status,400);
 assert.equal((await post(f.db,[row(1)],'missing')).status,401);
 f.source.exec("CREATE TRIGGER synthetic_event_failure BEFORE INSERT ON events WHEN NEW.type='duplicate' BEGIN SELECT RAISE(ABORT,'synthetic_storage_fault');END;");
 assert.equal((await post(f.db,[row(1)])).status,503);assert.equal(f.source.prepare('SELECT count(*) n FROM external_application_history').get().n,0);assert.equal(f.source.prepare('SELECT status FROM jobs').get().status,'saved');
 f.source.exec('DROP TRIGGER synthetic_event_failure');assert.equal((await post(f.db,[row(1),row(1)])).body.blocked,1);assert.equal(f.source.prepare("SELECT count(*) n FROM events WHERE type='duplicate'").get().n,1);
});
test('lost history acknowledgement reports uncertainty; saved-state readback and reimport preserve one record and one duplicate event',async t=>{
 const f=setup(t);f.add(1);let writes=0;
 const fault={read:fn=>f.db.read(fn),async write(fn){writes++;await f.db.write(fn);throw new UncertainCommitError();}};
 const result=await post(fault,[row(1,{status:'offer'})]);assert.equal(result.status,503);assert.equal(result.body.code,'database_commit_outcome_uncertain');assert.equal(writes,1);
 assert.equal((await applicationHistory(f.db,{uid:'u',method:'GET'})).body.records[0].status,'offer');
 const next=await post(f.db,[row(1,{status:'applied'})]);assert.equal(next.body.added,0);assert.equal(next.body.updated,1);assert.equal(next.body.blocked,0);assert.equal(next.body.total,1);
 assert.equal((await applicationHistory(f.db,{uid:'u',method:'GET'})).body.records[0].status,'offer');
});
