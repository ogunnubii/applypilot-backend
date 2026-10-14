import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createClient} from '@libsql/client';
import {createClient as createRemoteClient} from '@libsql/client/http';
import {installRepeatGuard} from '../../application-dedup.js';
import {installHistory} from '../../application-history.js';
import {registerPreparationHandoffFunctions} from '../../preparation-handoff.js';

// This intentionally uses fictional in-memory SQLite data, not a Turso account.
// It tests the supported SDK interface and retained SQLite trigger compatibility.
// It cannot establish cloud latency, quotas or remote transaction availability.
async function fixture(t){
 const db=new DatabaseSync(':memory:');
 db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE users(id TEXT PRIMARY KEY);
 INSERT INTO users VALUES('fictional');
 CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),applicant_id TEXT,title TEXT,company TEXT,url TEXT,normalized_url TEXT,status TEXT,attempts INTEGER DEFAULT 0,local_attempt_at TEXT,confirmation TEXT,local_phase TEXT DEFAULT 'ready',notes TEXT DEFAULT '',challenge TEXT,handoff_available INTEGER DEFAULT 0,created_at TEXT DEFAULT '2026',updated_at TEXT DEFAULT '2026');
 INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,local_attempt_at) VALUES('prior','fictional','p','Platform Engineer','Fictional Inc','https://job-boards.greenhouse.io/fictional/jobs/1234','prior','paused','2026-10-13');
 INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status) VALUES('retry','fictional','p','Platform Engineer','Fictional Inc','https://boards.greenhouse.io/fictional/jobs/1234','retry','saved');`);
 installHistory(db);installRepeatGuard(db);
 const client=createClient({url:':memory:',intMode:'bigint'});t.after(()=>client.close());
 try{
  const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL").all();
  for(const table of tables)await client.execute(table.sql);
  for(const table of tables)for(const row of db.prepare('SELECT * FROM '+table.name).all()){
   const keys=Object.keys(row);await client.execute({sql:'INSERT INTO '+table.name+'('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')',args:Object.values(row)});
  }
  for(const {sql} of db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger'").all())await client.execute(sql);
 }finally{db.close()}
 return {client};
}

test('documented remote SDK lacks the connection-local JavaScript function API required by installers',()=>{
 const client=createRemoteClient({url:'https://no-provider-call.invalid'});
 try{
  assert.equal(typeof client.execute,'function');
  assert.equal(typeof client.transaction,'function');
  assert.equal(client.function,undefined);
  assert.equal(client.prepare,undefined);
  assert.throws(()=>registerPreparationHandoffFunctions(client),/db.function is not a function/);
 }finally{client.close()}
});

test('retained original duplicate trigger fails rather than authorizing a repeat through the local libSQL SDK',async t=>{
 const {client}=await fixture(t);
 await assert.rejects(client.execute("UPDATE jobs SET status='queued' WHERE id='retry'"),error=>{
  assert.match(error.message,/no such function: (same_application|history_company)/);
  t.diagnostic(error.message.match(/no such function: \w+/)[0]);return true;
 });
 assert.equal((await client.execute("SELECT local_attempt_at FROM jobs WHERE id='prior'")).rows[0].local_attempt_at,'2026-10-13');
 assert.notEqual((await client.execute("SELECT status FROM jobs WHERE id='retry'")).rows[0].status,'queued');
});

test('foreign keys, explicit rollback and durable uniqueness work in the local libSQL client',async t=>{
 const {client}=await fixture(t);
 await client.execute('PRAGMA foreign_keys=ON');
 await client.execute('CREATE TABLE intent(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL UNIQUE)');
 await assert.rejects(client.execute("INSERT INTO intent VALUES('invalid','missing','invalid')"),/FOREIGN KEY/);
 let tx=await client.transaction('write');
 await tx.execute("INSERT INTO intent VALUES('one','fictional','request-1')");await tx.rollback();tx.close();
 assert.equal((await client.execute('SELECT count(*) n FROM intent')).rows[0].n,0n);
 tx=await client.transaction('write');await tx.execute("INSERT INTO intent VALUES('one','fictional','request-1')");await tx.commit();tx.close();
 await assert.rejects(client.execute("INSERT INTO intent VALUES('two','fictional','request-1')"),/UNIQUE/);
 assert.equal((await client.execute('SELECT count(*) n FROM intent')).rows[0].n,1n);
});
