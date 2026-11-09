import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {connectionStatus,WORKER_FRESH_MS,HELPER_FRESH_MS} from './connection-status.js';

const NOW=Date.parse('2026-11-09T04:00:00Z'),at=ms=>new Date(NOW-ms).toISOString();
function fixture({worker,helpers={}}={}){
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE worker_status(id INTEGER PRIMARY KEY,heartbeat TEXT NOT NULL);CREATE TABLE browser_helper_checkins(user_id TEXT PRIMARY KEY,last_seen_at TEXT NOT NULL)');
 if(worker!==undefined)db.prepare('INSERT INTO worker_status VALUES(1,?)').run(worker);
 for(const [user,seen] of Object.entries(helpers))db.prepare('INSERT INTO browser_helper_checkins VALUES(?,?)').run(user,seen);
 return db;
}

test('fresh worker and this account\'s helper read as connected',()=>{
 const status=connectionStatus(fixture({worker:at(5000),helpers:{u:at(20000)}}),'u',NOW);
 assert.equal(status.ok,true);
 assert.deepEqual(status.worker,{state:'online',lastSeenAt:at(5000),ageSeconds:5});
 assert.deepEqual(status.helper,{state:'online',lastSeenAt:at(20000),ageSeconds:20});
 assert.equal(status.message,'Worker and Chrome helper are connected.');
});

test('stale heartbeats explain what to do, with the age',()=>{
 const status=connectionStatus(fixture({worker:at(WORKER_FRESH_MS+1000),helpers:{u:at(HELPER_FRESH_MS+180000)}}),'u',NOW);
 assert.equal(status.ok,false);
 assert.equal(status.worker.state,'offline');assert.equal(status.helper.state,'offline');
 assert.match(status.message,/worker stopped responding 46 seconds ago/);
 assert.match(status.message,/helper last checked in 5 minutes ago/);
 assert.match(status.message,/saved answers are kept/);
});

test('another account\'s helper never counts, and missing data reads as unknown',()=>{
 const status=connectionStatus(fixture({worker:at(1000),helpers:{someone:at(1000)}}),'u',NOW);
 assert.equal(status.ok,false);assert.equal(status.worker.state,'online');
 assert.deepEqual(status.helper,{state:'unknown',lastSeenAt:null,ageSeconds:null});
 assert.match(status.message,/has not checked in/);
 const bare=new DatabaseSync(':memory:');
 const none=connectionStatus(bare,'u',NOW);
 assert.equal(none.worker.state,'unknown');assert.equal(none.helper.state,'unknown');assert.match(none.message,/worker has not started/);
 assert.equal(connectionStatus(fixture({worker:'not a time'}),'u',NOW).worker.state,'unknown');
});

test('the status check is read-only',()=>{
 const db=fixture({worker:at(1000),helpers:{u:at(1000)}}),before=JSON.stringify([db.prepare('SELECT * FROM worker_status').all(),db.prepare('SELECT * FROM browser_helper_checkins').all()]);
 connectionStatus(db,'u',NOW);
 assert.equal(JSON.stringify([db.prepare('SELECT * FROM worker_status').all(),db.prepare('SELECT * FROM browser_helper_checkins').all()]),before);
});
