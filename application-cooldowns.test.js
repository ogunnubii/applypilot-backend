import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {applicationCooldown,splitApplicationCooldowns,hideCooldownActions} from './application-cooldowns.js';
import {officialCareers} from './official-careers.js';
import {companyApplicationPolicy} from './company-application-policy.js';

function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE employer_limits(user_id TEXT,applicant_id TEXT,employer_key TEXT,hold_until TEXT,message TEXT);
 CREATE TABLE company_application_activity(job_id TEXT,user_id TEXT,applicant_id TEXT,company_keys TEXT,normalized_url TEXT,started_at TEXT);`);
 return db;
}
const now=Date.parse('2026-10-04T12:00:00.000Z');
const job=(id,board='ashby')=>({id,user_id:'u',applicant_id:'p',status:'local_browser',company:board,title:'Engineer',url:'https://jobs.ashbyhq.com/'+board+'/'+id,normalized_url:'https://jobs.ashbyhq.com/'+board+'/'+id});
test('a hold hides only the employer and applicant, and expires without changing job evidence',()=>{
 const db=fixture(),held={...job('a'),local_attempt_at:'2026-10-03',attempts:1,confirmation:'No receipt'},copy={...held};
 db.prepare('INSERT INTO employer_limits VALUES(?,?,?,?,?)').run('u','p','ashby:ashby','2026-11-30T12:00:00.000Z','Limit reached');
 const split=splitApplicationCooldowns(db,'u',[held,job('b','hud')],{now});
 assert.deepEqual(split.jobs.map(j=>j.id),['b']);assert.equal(split.deferred[0].cooldown.kind,'employer');
 assert.equal(applicationCooldown(db,{...held,applicant_id:'other'},{now}),null);
 assert.equal(applicationCooldown(db,{...held,user_id:'other'},{now}),null);
 assert.equal(applicationCooldown(db,{...held,status:'submitted'},{now}),null);
 assert.equal(splitApplicationCooldowns(db,'u',[held],{now:Date.parse('2026-11-30T12:00:00.000Z')}).jobs.length,1);
 assert.deepEqual(held,copy);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM employer_limits').get().n,1);db.close();
});
test('unknown employer reset dates stay deferred instead of claiming a reset',()=>{
 const db=fixture();db.prepare('INSERT INTO employer_limits VALUES(?,?,?,?,?)').run('u','p','ashby:ashby',null,'Limit reached');
 assert.equal(applicationCooldown(db,job('a'),{now}).until,null);db.close();
});
test('past applications at a company never hide a different unblocked role',()=>{
 const db=fixture(),put=db.prepare('INSERT INTO company_application_activity VALUES(?,?,?,?,?,?)');
 for(let n=0;n<12;n++)put.run('past'+n,'u','p','["ashby:ashby"]','unique'+n,n%2?null:'2026-10-01T12:00:00.000Z');
 const candidate=job('new');assert.equal(companyApplicationPolicy(db,'p',candidate).allowed,true);
 assert.equal(applicationCooldown(db,candidate,{now}),null);
 assert.equal(splitApplicationCooldowns(db,'u',[candidate],{now}).deferred.length,0);db.close();
});
test('hiding hold actions preserves filled, attempted, and confirmed totals without modifying the snapshot',()=>{
 const snapshot={totals:{active:1,blocked:1,stalled:0,awaiting:1,worked:2,confirmed:1},applications:[{id:'held',blocked:true,awaiting:true,worked:true,attempted:true},{id:'active',active:true},{id:'done',confirmed:true,worked:true}]};
 const actual=hideCooldownActions(snapshot,['held']);
 assert.equal(actual.totals.blocked,0);assert.equal(actual.totals.awaiting,0);assert.equal(actual.totals.active,1);
 assert.equal(actual.totals.confirmed,1);assert.equal(actual.totals.worked,2);assert.equal(actual.applications[0].attempted,true);
 assert.equal(snapshot.applications[0].blocked,true);
});
test('official career links require the verified board, with no guessed company or recruiter mapping',()=>{
 assert.equal(officialCareers(job('a','hud')).url,'https://www.hud.ai/careers');
 assert.equal(officialCareers({...job('b','unknown'),company:'HUD'}),null);
 assert.equal(officialCareers(job('b','Clera')),null);
 assert.equal(officialCareers({...job('b','hud'),url:'https://jobs.ashbyhq.com.evil.test/hud/b'}),null);
});
