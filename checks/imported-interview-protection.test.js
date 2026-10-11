import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installHistory,importHistory} from '../application-history.js';

test('an imported interview blocks the prepared role and future repeats without inventing a receipt or blocking other roles',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);
   INSERT INTO users VALUES('u'),('other');
   CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id,company,title,status,handoff_available DEFAULT 0,local_attempt_at,updated_at,challenge,attempts DEFAULT 0,confirmation);
   CREATE TABLE events(id INTEGER PRIMARY KEY,job_id,at,type,message);`);
  installHistory(db);
  const add=(id,user,title)=>db.prepare('INSERT INTO jobs(id,user_id,company,title,status) VALUES(?,?,?,?,?)').run(id,user,'Fixture Employer',title,'queued');
  add('prepared','u','AI Support Engineer - Toronto (Weekend Shift)');
  add('different','u','Dedicated Support Engineer - Toronto');
  add('other-account','other','AI Support Engineer - Toronto (Weekend Shift)');
  db.exec("UPDATE jobs SET status='needs_review',attempts=2 WHERE id='prepared'");
  const result=importHistory(db,'u',[{company:'Fixture Employer',title:'AI Support Engineer - Toronto (Weekend Shift)',status:'interview',source:'External application service — applicant confirmed'}]);
  assert.equal(result.blocked,1);assert.equal(result.added,1);
  const record=db.prepare("SELECT * FROM jobs WHERE id='prepared'").get();
  assert.equal(record.status,'duplicate');assert.equal(record.attempts,2);assert.equal(record.local_attempt_at,null);assert.equal(record.confirmation,null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type IN ('submitted','manual_confirmation')").get().n,0);
  assert.throws(()=>db.exec("UPDATE jobs SET status='running' WHERE id='prepared'"),/repeat application blocked/);
  assert.throws(()=>db.exec("UPDATE jobs SET local_attempt_at='2026-10-11T16:00:00Z' WHERE id='prepared'"),/repeat submission blocked/);
  add('rediscovered','u','AI Support Engineer – Toronto (Weekend Shift)');
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id='rediscovered'").get().status,'duplicate');
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id='different'").get().status,'queued');
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id='other-account'").get().status,'queued');
  const merged=importHistory(db,'u',[{company:'Fixture Employer',title:'AI Support Engineer - Toronto (Weekend Shift)',status:'applied'}]);
  assert.equal(merged.added,0);assert.equal(merged.total,1);assert.equal(db.prepare('SELECT status FROM external_application_history').get().status,'interview');
 }finally{db.close();}
});
