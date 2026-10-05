import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {recordReportedSubmission} from '../manual-submit-record.js';
import {applicationEvidence} from '../operation-evidence.js';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';

test('an applicant report stops reapplication without inventing an employer confirmation',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,status TEXT,handoff_available INTEGER,local_attempt_at TEXT,local_phase TEXT,required_fields_json TEXT,challenge TEXT,updated_at TEXT,confirmation TEXT);CREATE TABLE events(job_id TEXT,at TEXT,type TEXT,message TEXT)");
 const add=(id,status='local_browser',uid='owner',handoff=0)=>db.prepare("INSERT INTO jobs VALUES(?,?,?, ?,NULL,'blocked','[\"Country\"]','Missing answers','old',NULL)").run(id,uid,status,handoff);
 add('reported');add('other','local_browser','different');add('running','running');add('queued','queued');add('handoff','paused','owner',1);add('confirmed','interview');
 db.exec("UPDATE jobs SET confirmation='Thank you for applying' WHERE id='confirmed'");
 assert.throws(()=>recordReportedSubmission(db,'owner','other'),/not found/);
 for(const id of ['running','queued','handoff'])assert.throws(()=>recordReportedSubmission(db,'owner',id),/active preparation/);
 const result=recordReportedSubmission(db,'owner','reported');assert.equal(result.confirmed,false);
 const job=db.prepare("SELECT * FROM jobs WHERE id='reported'").get();
 assert.equal(job.status,'submitted');assert(job.local_attempt_at);assert.equal(job.required_fields_json,'[]');assert.equal(job.confirmation,null);
 const evidence=applicationEvidence(job);assert.equal(evidence.confirmed,false);assert.equal(evidence.attempted,true);assert.equal(evidence.worked,true);assert.equal(evidence.awaiting,true);
 assert.equal(db.prepare('SELECT type FROM events').get().type,'applicant_reported_submission');
 recordReportedSubmission(db,'owner','reported');assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n,1);
 recordReportedSubmission(db,'owner','confirmed');assert.equal(db.prepare("SELECT status,confirmation FROM jobs WHERE id='confirmed'").get().status,'interview');
 assert.equal(db.prepare("SELECT confirmation FROM jobs WHERE id='confirmed'").get().confirmation,'Thank you for applying');db.close();
});

test('dashboard reports an existing submission through its own API without opening or submitting an employer form',async()=>{
 const dom=new JSDOM(readFileSync(new URL('../assistant-page.html',import.meta.url),'utf8'),{runScripts:'outside-only',url:'https://example.test'}),w=dom.window;
 w.setInterval=()=>0;w.eval(readFileSync(new URL('../extension/policy.js',import.meta.url),'utf8'));w.eval(readFileSync(new URL('../assistant-client.js',import.meta.url),'utf8'));
 w.fetch=async(url)=>{const path=new URL(url,'https://example.test').pathname;return {ok:true,json:async()=>path==='/api/jobs'?{jobs:[{id:'reported',company:'Employer',title:'Engineer',status:'local_browser',local_phase:'blocked',required_fields_json:'[]'}]}:path==='/api/status'?{workerOnline:true}:path==='/api/operations'?{totals:{},applications:[]}:path==='/api/continuations'?{requests:[]}:path==='/api/application-history'?{records:[]}:path==='/api/employer-limits'?{limits:[]}:path==='/api/searches'?{searches:[]}:path==='/api/activity'?{events:[]}: {}};};
 await w.refresh(true);const calls=[];w.eval('refresh=async()=>{}');w.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({ok:true,reported:true,confirmed:false})};};
 const button=[...w.document.querySelectorAll('button')].find(b=>b.textContent==='Record my submission without a receipt');assert(button);await button.onclick();
 assert.equal(calls.length,1);assert(calls[0].url.endsWith('/jobs/reported/report-submitted'));assert.deepEqual(JSON.parse(calls[0].options.body),{reported:true});
 assert(w.document.querySelector('#notice').textContent.includes('Employer receipt is still unverified'));assert.equal(w.pendingSubmission({status:'submitted'}),false);w.close();
});
