import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {closeRetainedBrowser} from './retained-state.js';
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE jobs(id,status,challenge,handoff_available,local_owner,local_phase,local_attempt_at,confirmation,updated_at);CREATE TABLE autonomous_attempts(job_id);CREATE TABLE events(job_id,at,type,message);INSERT INTO jobs VALUES('j','needs_review','Ready to submit',1,NULL,'ready',NULL,NULL,'2026')");return db;
}
test('crashed prepared browser clears stale readiness and records failure before closure',()=>{
 const db=fixture();closeRetainedBrowser(db,'j','Closed failed browser',{crashed:true});const j=db.prepare('SELECT * FROM jobs').get();assert.equal(j.handoff_available,0);assert.equal(j.challenge,'Worker error');assert.equal(j.status,'needs_review');assert.deepEqual(db.prepare('SELECT type FROM events ORDER BY rowid').all().map(e=>e.type),['needs_review','handoff_closed']);db.close();
});
test('crashed retained browsers preserve every submission marker and completed or excluded records',()=>{
 for(const marker of ['in-memory','intent','event','local','phase','receipt','completed','excluded','owner','ordinary-close']){
  const db=fixture();
  if(marker==='intent')db.exec("INSERT INTO autonomous_attempts VALUES('j')");
  if(marker==='event')db.exec("INSERT INTO events VALUES('j','2026','submission_started','Possible Submit')");
  if(marker==='local')db.exec("UPDATE jobs SET local_attempt_at='2026'");
  if(marker==='phase')db.exec("UPDATE jobs SET local_phase='uncertain'");
  if(marker==='receipt')db.exec("UPDATE jobs SET confirmation='Existing receipt'");
  if(marker==='completed')db.exec("UPDATE jobs SET status='submitted',confirmation='Existing receipt'");
  if(marker==='excluded')db.exec("UPDATE jobs SET status='archived'");
  if(marker==='owner')db.exec("UPDATE jobs SET local_owner='chrome'");
  const before=db.prepare('SELECT * FROM jobs').get();closeRetainedBrowser(db,'j','Closed failed browser',{crashed:marker!=='ordinary-close',attempted:marker==='in-memory'});
  const after=db.prepare('SELECT * FROM jobs').get();assert.equal(after.handoff_available,0);assert.equal(after.confirmation,before.confirmation);assert.equal(after.local_attempt_at,before.local_attempt_at);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type='needs_review'").get().n,0,marker);
  if(['completed','excluded','owner','ordinary-close'].includes(marker)){assert.equal(after.status,before.status);assert.equal(after.challenge,before.challenge);}else assert.equal(after.challenge,'Unconfirmed submission');db.close();
 }
});
