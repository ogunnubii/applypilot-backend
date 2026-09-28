import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'applypilot-recovery-'));process.env.DATABASE_PATH=join(dir,'db.sqlite');
const {db,now}=await import('./db.js');const {recoverWorkerJobs,rememberAnswers}=await import('./local-state.js');
test('Restart recovers only pre-submit jobs and preserves local ownership and uncertain intent',()=>{
 db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('u','fixture@example.test','unused',now());
 db.prepare('INSERT INTO applicants(id,user_id,name,created_at) VALUES(?,?,?,?)').run('a','u','Fixture',now());
 for(const [id,status,challenge] of [['safe','running',null],['uncertain','running','Submission in progress'],['local','local_browser','Submission in progress']])db.prepare('INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,challenge,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,'u','a','Fixture','Fixture','https://jobs.lever.co/example/'+id,'https://jobs.lever.co/example/'+id,status,challenge,now(),now());
 recoverWorkerJobs();assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get('safe').status,'queued');assert.equal(db.prepare('SELECT challenge FROM jobs WHERE id=?').get('uncertain').challenge,'Unconfirmed submission');assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get('local').status,'local_browser');
 rememberAnswers('a',[['Work authorized?','No']]);assert.equal(JSON.parse(db.prepare('SELECT answers_json FROM applicants WHERE id=?').get('a').answers_json)['Work authorized?'],'No');
 const n=db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='recovery'").get().n;recoverWorkerJobs();assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='recovery'").get().n,n);
});
test.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
