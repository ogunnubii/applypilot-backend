import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeFixture,fixtureJobId,FIXTURE_OWNER,FIXTURE_AT} from '../database/runtime-fixture.js';
import {openNativeDatabase} from '../database/native.js';
import {authorizePreparationStep} from './preparation-authorization.js';

test('Next authorization rechecks owner/account, focus, batch, Stop, exclusion, consent, provenance and every attempt marker',async t=>{
 const f=runtimeFixture(process.env.APPLYPILOT_ASYNC_TEST_ROOT);f.add(1,{status:'local_browser'});const id=fixtureJobId(1);f.source.prepare('UPDATE jobs SET local_owner=? WHERE id=?').run(FIXTURE_OWNER,id);
 const db=openNativeDatabase(f.path);t.after(async()=>{await db.close();f.source.close();});const request=extra=>authorizePreparationStep(db,{uid:'u',jobId:id,owner:FIXTURE_OWNER,...extra});
 assert.equal((await request()).status,200);assert.equal((await request({uid:'other'})).status,404);assert.equal((await request({uid:null})).status,401);assert.equal((await request({owner:'invalid'})).status,400);assert.equal((await request({owner:FIXTURE_OWNER.replace('1','2')})).status,409);
 const cases=[
  ["INSERT INTO work_focus(user_id,enabled,job_id) VALUES('u',1,'different')","DELETE FROM work_focus",409],
  ["INSERT INTO application_batch_preferences(user_id,applicant_id,enabled,current_batch,created_at) VALUES('u','p',1,'batch','2026')","DELETE FROM application_batch_preferences",409],
  [`INSERT INTO preparation_campaigns VALUES('u','campaign','p',20,20,'[]',0,'2026');INSERT INTO preparation_members(campaign_id,job_id,user_id,position,title_group) VALUES('campaign','${id}','u',1,'Engineer')`,'DELETE FROM preparation_members;DELETE FROM preparation_campaigns',409],
  [`INSERT INTO preparation_campaigns VALUES('u','campaign','p',20,20,'[]',1,'2026');INSERT INTO preparation_members(campaign_id,job_id,user_id,position,title_group,excluded_at) VALUES('campaign','${id}','u',1,'Engineer','2026')`,'DELETE FROM preparation_members;DELETE FROM preparation_campaigns',409],
  ["UPDATE applicants SET consent=0","UPDATE applicants SET consent=1",403],
  [`INSERT INTO fact_drafts VALUES('${id}','Synthetic question','Synthetic answer','gemini','[]','2026');UPDATE applicants SET gemini_facts_consent=0`,'DELETE FROM fact_drafts;UPDATE applicants SET gemini_facts_consent=1',403],
  [`INSERT INTO fact_drafts VALUES('${id}','Synthetic question','Synthetic answer','openai','[]','2026');UPDATE applicants SET ai_consent=0`,'DELETE FROM fact_drafts;UPDATE applicants SET ai_consent=1',403],
  [`INSERT INTO research_draft_usage VALUES('${id}','Synthetic question','2026');UPDATE applicants SET google_research_consent=0`,'DELETE FROM research_draft_usage;UPDATE applicants SET google_research_consent=1',403],
  [`INSERT INTO unresolved_attempt_quarantines VALUES('${id}','u','synthetic','${FIXTURE_AT}')`,'DELETE FROM unresolved_attempt_quarantines',409],

 ];
 for(const [set,reset,status] of cases){f.source.exec(set);assert.equal((await request()).status,status,set);f.source.exec(reset);assert.equal((await request()).status,200,reset);}
 f.source.prepare('INSERT INTO autonomous_attempts VALUES(?,?,?)').run(id,'browser',FIXTURE_AT);assert.equal((await request()).status,409);
 f.source.exec('DELETE FROM autonomous_attempts');assert.equal((await request()).status,409,'deleting a mutable attempt row cannot erase the retained uncertainty journal');
});

test('each saved submission marker blocks Next even when current browser ownership is valid',async t=>{
 const f=runtimeFixture(process.env.APPLYPILOT_ASYNC_TEST_ROOT),db=openNativeDatabase(f.path);
 t.after(async()=>{await db.close();f.source.close();});
 const markers=[['attempts',1],['confirmation','Your application has been received.'],['local_attempt_at',FIXTURE_AT],['local_phase','verifying'],['local_phase','uncertain'],['local_phase','submitted'],['challenge','Unconfirmed submission'],['challenge','Submission in progress']];
 for(const [index,[column,value]] of markers.entries()){
  const n=index+10,id=fixtureJobId(n);f.add(n,{status:'local_browser'});
  f.source.prepare(`UPDATE jobs SET local_owner=?,${column}=? WHERE id=?`).run(FIXTURE_OWNER,value,id);
  const result=await authorizePreparationStep(db,{uid:'u',jobId:id,owner:FIXTURE_OWNER});
  assert.equal(result.status,409,`${column}=${value}`);
 }
});
