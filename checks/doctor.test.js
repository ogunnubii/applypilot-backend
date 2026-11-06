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
