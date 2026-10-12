import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installLibrary} from './answer-library.js';
import {installExperience} from './experience-library.js';
import {installFactDrafts} from './draft-provenance.js';
import {installCoverLetters,prepareCoverLetter,coverLetterPreview} from './cover-letter.js';
import {renderCoverLetter,coverLetterFormat} from './cover-letter-document.js';
import {resumeText} from './resume.js';

function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES('u'),('other');
 CREATE TABLE applicants(id TEXT PRIMARY KEY,user_id TEXT,name TEXT,consent INTEGER,answers_json TEXT,resume_path TEXT);
 CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,title TEXT,company TEXT,url TEXT,job_metadata_json TEXT,answers_json TEXT,status TEXT,local_attempt_at TEXT,handoff_available INTEGER,local_phase TEXT,local_owner TEXT,challenge TEXT);
 CREATE TABLE events(job_id TEXT,type TEXT);
 INSERT INTO applicants VALUES('p','u','Fixture Applicant',1,'{}',NULL),('other-p','other','Other Applicant',1,'{}',NULL);
 INSERT INTO jobs VALUES('j','u','p','Support Engineer','Example Company','https://jobs.lever.co/example/1','{}','{}','local_browser',NULL,0,'ready','browser',NULL);
 INSERT INTO jobs SELECT 'second',user_id,applicant_id,'Platform Engineer','Second Company','https://jobs.lever.co/second/2',job_metadata_json,answers_json,status,local_attempt_at,handoff_available,local_phase,local_owner,challenge FROM jobs WHERE id='j';`);
 installLibrary(db);installExperience(db);installFactDrafts(db);installCoverLetters(db);
 db.prepare('UPDATE applicants SET answers_json=? WHERE id=?').run(JSON.stringify({'Professional background':'I supported Linux services and investigated customer incidents. I documented solutions and worked with engineering teams.'}),'p');
 const prepare=(options={})=>prepareCoverLetter(db,'u','j',{required:true,expectedOwner:'browser',...options});
 return {db,prepare};
}
test('required text is concise, exclusively grounded and owner/job scoped; generation does not change jobs or submission controls',async()=>{
 const {db,prepare}=fixture();try{
  const before=db.prepare('SELECT * FROM jobs').all();const r=await prepare();
  assert.match(r.answer,/Support Engineer role at Example Company/);assert.match(r.answer,/I supported Linux services/);assert(r.answer.split(/\s+/).length<=200);
  assert.doesNotMatch(r.answer,/Tailored to|Approved|\[|citizenship|certified|years|product user/);assert(r.manualSubmit&&r.requiresReview);
  assert.deepEqual(db.prepare('SELECT * FROM jobs').all(),before);assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM answer_history').get().n,0);assert.equal(coverLetterPreview(db,'u','j').stale,false);
  await assert.rejects(prepareCoverLetter(db,'other','j',{required:true}),/not found/);
  assert.equal(coverLetterPreview(db,'u','second'),null);
  const second=await prepareCoverLetter(db,'u','second',{required:true});assert.match(second.answer,/Second Company/);assert.doesNotMatch(second.answer,/Example Company/);
 }finally{db.close();}
});
test('optional, absent facts, unsupported formats, ambiguous slots and length limits do not produce letters',async()=>{
 const {db,prepare}=fixture();try{
  for(const options of [{required:false},{required:'true'},{maxLength:30},{maxLength:0},{format:'file',accept:'.txt,image/*'},{fieldHelp:'Maximum 5 words'},{fieldHelp:'State your citizenship and salary expectations.'}])assert.equal((await prepare(options)).answer,'',JSON.stringify(options));
  for(const question of ['Resume','Resume / cover letter','Portfolio'])await assert.rejects(prepare({question}),/clearly identified/);
  db.prepare("UPDATE applicants SET answers_json='{}' WHERE id='p'").run();assert.equal((await prepare()).answer,'');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cover_letters').get().n,0);
 }finally{db.close();}
});
test('application-provided letters are preserved; profile-wide letters and unapproved or internal content are never used',async()=>{
 const {db,prepare}=fixture();try{
  const text='Dear hiring team,\n\nThis is my own application-specific letter.\n\nFixture Applicant';
  db.prepare('UPDATE jobs SET answers_json=? WHERE id=?').run(JSON.stringify({'Cover letter':text}),'j');assert.equal((await prepare()).answer,text);assert.equal((await prepare({maxLength:20})).answer,'');
  assert.equal(JSON.parse(db.prepare("SELECT answers_json FROM jobs WHERE id='j'").get().answers_json)['Cover letter'],text);
  db.prepare("UPDATE jobs SET answers_json='{}' WHERE id='j'").run();
  db.prepare('UPDATE applicants SET answers_json=? WHERE id=?').run(JSON.stringify({'Cover letter':text,'Professional background':'Approved resume professional experience: I worked at a fictional company.\nTailored to Example.\nI am a citizen of Example.\nI handled support incidents. [source 1]'}),'p');
  assert.equal((await prepare()).answer,'');
  db.prepare("INSERT INTO professional_experience VALUES('e','u','p','Support','I investigated customer incidents and documented solutions.','2026','2026')").run();
  assert.match((await prepare()).answer,/I investigated customer incidents/);
 }finally{db.close();}
});
test('DOCX upload is a genuine document with the same clean letter; accepted types choose the correct format',async()=>{
 const {db,prepare}=fixture(),dir=mkdtempSync(join(tmpdir(),'applypilot-cover-doc-'));try{
  for(const accept of ['', '.docx','.PDF, .DOCX','application/*'])assert.equal(coverLetterFormat(accept),'docx');
  assert.equal(coverLetterFormat('application/pdf'),'pdf');assert.equal(coverLetterFormat('.doc'),null);
  const r=await prepare({format:'file',accept:'.docx'}),bytes=Buffer.from(r.file.base64,'base64');assert.equal(bytes.subarray(0,2).toString(),'PK');assert.equal(r.file.name,'cover-letter.docx');
  const file=join(dir,r.file.name);writeFileSync(file,bytes);assert.equal((await resumeText(file,'.docx')).trim(),r.answer.replace(/\n\n/g,'\n\n').trim());
  const unicode='Dear Hiring Team,\n\nI supported José & Chloë’s systems <safely>.\n\nÉlodie';writeFileSync(file,await renderCoverLetter(unicode,'docx'));assert.equal((await resumeText(file,'.docx')).trim(),unicode);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('stale job/profile/owner/consent/submission changes during document rendering fail without saving a letter',async()=>{
 for(const sql of ["UPDATE jobs SET title='Different role' WHERE id='j'","UPDATE jobs SET company='Different company' WHERE id='j'","UPDATE jobs SET url='https://jobs.lever.co/example/2' WHERE id='j'","UPDATE jobs SET job_metadata_json='{\"description\":\"new role\"}' WHERE id='j'","UPDATE jobs SET applicant_id='other-p' WHERE id='j'","UPDATE applicants SET name='Different name' WHERE id='p'","UPDATE applicants SET answers_json='{}' WHERE id='p'","UPDATE applicants SET consent=0 WHERE id='p'","UPDATE jobs SET local_owner='changed' WHERE id='j'","UPDATE jobs SET status='paused' WHERE id='j'","UPDATE jobs SET local_attempt_at='2026' WHERE id='j'","UPDATE jobs SET answers_json='{\"Cover letter\":\"My concurrent edit\"}' WHERE id='j'"]){
  const {db,prepare}=fixture();try{await assert.rejects(prepare({format:'file',accept:'.pdf',render:async()=>{db.exec(sql);return Buffer.from('%PDF-synthetic');}}));assert.equal(db.prepare('SELECT COUNT(*) n FROM cover_letters').get().n,0,sql);}finally{db.close();}
 }
});
test('stale saved drafts are marked, regenerated for current facts, and paused/attempted/duplicate applications stay held',async()=>{
 const {db,prepare}=fixture();try{
  await prepare();db.prepare("UPDATE jobs SET title='Platform Engineer' WHERE id='j'").run();assert(coverLetterPreview(db,'u','j').stale);assert.match((await prepare()).answer,/Platform Engineer/);
  for(const status of ['paused','needs_review','submitted','duplicate','archived']){db.prepare('UPDATE jobs SET status=? WHERE id=?').run(status,'j');await assert.rejects(prepare(),/paused|cannot/);}
  db.prepare("UPDATE jobs SET status='local_browser' WHERE id='j'").run();await assert.rejects(prepare({check:()=> 'This application is parked.'}),/parked/);
  db.prepare("INSERT INTO events VALUES('j','submission_started')").run();await assert.rejects(prepare(),/cannot/);
 }finally{db.close();}
});
