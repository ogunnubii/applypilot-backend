import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installLibrary,captureAnswers,updateLibrary} from '../answer-library.js';
import {installResearch} from '../google-research.js';
import {deleteApplication} from '../delete-application.js';

function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE applicants(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,answers_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,applicant_id TEXT NOT NULL,status TEXT NOT NULL,handoff_available INTEGER NOT NULL DEFAULT 0,answers_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE blocker_emails(job_id TEXT NOT NULL);
  CREATE TABLE events(id INTEGER PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id));
  CREATE TABLE work_focus(user_id TEXT PRIMARY KEY,job_id TEXT);
  INSERT INTO applicants VALUES('p1','u1','{}'),('p2','u2','{}');
  INSERT INTO jobs(id,user_id,applicant_id,status,handoff_available) VALUES('braze','u1','p1','submitted',0),('other','u2','p2','submitted',0);
  INSERT INTO blocker_emails VALUES('braze'),('other');
  INSERT INTO events VALUES(1,'braze'),(2,'other');
  INSERT INTO work_focus VALUES('u1','braze'),('u2','other');`);
 installLibrary(db);
 installResearch(db);
 return db;
}

test('permanent deletion removes only the owner application and its linked history',()=>{
 const db=fixture();
 try{
  const job={id:'braze',user_id:'u1',applicant_id:'p1'};
  captureAnswers(db,job,[{question:'Phone',answer:'6475700241'}]);
  const answer=db.prepare('SELECT * FROM answer_history WHERE job_id=?').get('braze');
  updateLibrary(db,'u1',answer.id,answer.answer,true);
  assert.deepEqual(deleteApplication(db,'u1','braze'),{ok:true});
  assert.equal(db.prepare('SELECT 1 FROM jobs WHERE id=?').get('braze'),undefined);
  assert.equal(db.prepare('SELECT 1 FROM answer_history WHERE job_id=?').get('braze'),undefined);
  assert.equal(db.prepare('SELECT 1 FROM blocker_emails WHERE job_id=?').get('braze'),undefined);
  assert.equal(db.prepare('SELECT 1 FROM events WHERE job_id=?').get('braze'),undefined);
  assert.equal(db.prepare('SELECT job_id FROM work_focus WHERE user_id=?').get('u1').job_id,null);
  assert.deepEqual(JSON.parse(db.prepare('SELECT answers_json FROM applicants WHERE id=?').get('p1').answers_json),{});
  assert.ok(db.prepare('SELECT 1 FROM jobs WHERE id=?').get('other'));
  assert.ok(db.prepare('SELECT 1 FROM blocker_emails WHERE job_id=?').get('other'));
  assert.ok(db.prepare('SELECT 1 FROM events WHERE job_id=?').get('other'));
 }finally{db.close();}
});

test('permanent deletion enforces ownership and rejects active or handed-off work',()=>{
 const db=fixture();
 try{
  assert.throws(()=>deleteApplication(db,'u2','braze'),/not found/i);
  for(const status of ['running','queued','local_browser']){
   db.prepare('UPDATE jobs SET status=?,handoff_available=0 WHERE id=?').run(status,'braze');
   assert.throws(()=>deleteApplication(db,'u1','braze'),/stop the application/i);
  }
  db.prepare("UPDATE jobs SET status='paused',handoff_available=1 WHERE id='braze'").run();
  assert.throws(()=>deleteApplication(db,'u1','braze'),/close its live session/i);
  assert.ok(db.prepare('SELECT 1 FROM jobs WHERE id=?').get('braze'));
 }finally{db.close();}
});

test('a failed dependent delete rolls the entire transaction back',()=>{
 const db=fixture();
 try{
  db.exec(`CREATE TRIGGER reject_event_delete BEFORE DELETE ON events
   WHEN old.job_id='braze' BEGIN SELECT RAISE(ABORT,'event deletion rejected'); END;`);
  assert.throws(()=>deleteApplication(db,'u1','braze'),/event deletion rejected/i);
  assert.ok(db.prepare('SELECT 1 FROM jobs WHERE id=?').get('braze'));
  assert.ok(db.prepare('SELECT 1 FROM blocker_emails WHERE job_id=?').get('braze'));
  assert.ok(db.prepare('SELECT 1 FROM events WHERE job_id=?').get('braze'));
  assert.equal(db.prepare('SELECT job_id FROM work_focus WHERE user_id=?').get('u1').job_id,'braze');
 }finally{db.close();}
});
