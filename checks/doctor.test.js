import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {doctorReport,formatDoctor} from '../doctor.js';
// doctor reports configuration without ever printing a secret value.
test('doctor: secrets hidden, unknown work facts shown as "will ask", counts split by evidence',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ap-doctor-')),resume=join(dir,'resume.pdf');writeFileSync(resume,'%PDF-1.4 synthetic');
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE applicants(id TEXT,name TEXT,execution_mode TEXT,consent INTEGER,resume_path TEXT,gemini_facts_consent INTEGER,answers_json TEXT,created_at TEXT);
  CREATE TABLE jobs(status TEXT,confirmation TEXT,local_attempt_at TEXT,local_phase TEXT);CREATE TABLE searches(enabled INTEGER,scope_json TEXT);
  CREATE TABLE external_application_history(id TEXT);CREATE TABLE history_employer_holds(released_at TEXT);`);
 db.prepare("INSERT INTO applicants VALUES('p1','Fixture','local',1,?,1,?,'2026')").run(resume,JSON.stringify({'Work authorization - Canada':'Yes','Visa sponsorship required - outside Canada':'Yes'}));
 db.exec(`INSERT INTO jobs VALUES('submitted','Thank you for applying',NULL,NULL),('local_browser',NULL,NULL,'blocked'),('local_browser',NULL,NULL,'blocked'),('local_browser',NULL,NULL,'blocked'),('local_browser',NULL,'2026','uncertain');
  INSERT INTO searches VALUES(1,'{}');INSERT INTO external_application_history VALUES('a'),('b');INSERT INTO history_employer_holds VALUES(NULL);`);
 const secret='AIzaSy-THIS-IS-A-FAKE-KEY-1234567890';
 const out=formatDoctor(doctorReport({env:{PORT:'8088',PUBLIC_ORIGIN:'http://localhost:8088',GEMINI_API_KEY:secret,RESEND_API_KEY:'re_fake_secret'},db,version:'24.21.0'}));
 assert(!out.includes(secret)&&!out.includes('re_fake_secret'),'no secret values');
 assert.match(out,/Gemini: API key configured \(value hidden\)/);
 assert.match(out,/Authorized to work in Canada: Saved: Yes/);assert.match(out,/Visa sponsorship in Canada: Not set — questions about this stop and ask you/);
 assert.match(out,/Authorized outside Canada: Not set/);assert.match(out,/Visa sponsorship outside Canada: Saved: Yes/);
 assert.match(out,/SHA-256 [0-9a-f]{16}…/);
 assert.match(out,/1 confirmed by employer receipt · 1 submitted without a confirmed receipt · 3 blocked · 0 prepared/);
 assert.match(out,/2 protection record\(s\) \(not counted as submissions\) · 1 active employer hold/);
 const mismatch=doctorReport({env:{PORT:'8088',PUBLIC_ORIGIN:'http://localhost:8080'},db:null,version:'22.0.0'});
 assert(mismatch.some(c=>c.area==='Node.js'&&c.status==='action'));assert(mismatch.some(c=>c.area==='Local address'&&c.status==='action'));
});

test('doctor: shows where LinkedIn/Indeed jobs stop (added, waiting, eligible, held reasons) and whether automatic submit is on',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE applicants(id TEXT,name TEXT,execution_mode TEXT,consent INTEGER,resume_path TEXT,gemini_facts_consent INTEGER,answers_json TEXT,created_at TEXT);
  CREATE TABLE jobs(url TEXT,status TEXT,confirmation TEXT,local_attempt_at TEXT,local_phase TEXT,job_metadata_json TEXT);
  CREATE TABLE work_focus(user_id TEXT,enabled INTEGER,job_id TEXT,auto_submit INTEGER,search_queue_only INTEGER);`);
 const li='https://www.linkedin.com/jobs/view/',held=JSON.stringify({listingCheck:{eligible:false,blocker:'Not listed as a remote position.'}});
 db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)').run(li+'1','saved',null,null,null,'{}');
 db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)').run(li+'2','saved',null,null,null,held);
 db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)').run(li+'3','saved',null,null,null,held);
 db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)').run(li+'4','saved',null,null,null,JSON.stringify({listingCheck:{eligible:true}}));
 db.exec("INSERT INTO work_focus VALUES('u',0,NULL,0,1)");
 const out=formatDoctor(doctorReport({env:{},db,version:'24.21.0'}));
 assert.match(out,/LinkedIn: 4 added · 1 waiting for listing check · 1 eligible · 2 held · 0 submitted without receipt · 0 confirmed · top reasons: 2× Not listed as a remote position/);
 assert.match(out,/Indeed: No jobs added yet[\s\S]*does not crawl Indeed/);
 assert.match(out,/Automatic submit: Off: jobs are prepared but not submitted/);
});
