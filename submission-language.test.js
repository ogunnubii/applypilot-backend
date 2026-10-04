import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {frenchApplication,installLanguagePolicy,setFrenchExclusion,archiveFrench} from './language-policy.js';
import {installManualSubmitRecords,recordManualSubmit} from './manual-submit-record.js';
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,title TEXT,company TEXT,status TEXT,local_attempt_at TEXT,local_phase TEXT,challenge TEXT,updated_at TEXT,handoff_available INTEGER,job_metadata_json TEXT,required_fields_json TEXT);CREATE TABLE events(id INTEGER PRIMARY KEY,job_id TEXT,at TEXT,type TEXT,message TEXT);CREATE TABLE application_archive(job_id TEXT PRIMARY KEY,previous_status TEXT,archived_at TEXT);CREATE TABLE work_focus(user_id TEXT,job_id TEXT);");
 installLanguagePolicy(db);installManualSubmitRecords(db);
 const add=(id,title,status='local_browser',user='u')=>db.prepare("INSERT INTO jobs VALUES(?,?,?,'Employer',?,NULL,'blocked',NULL,'date',0,'{}','[]')").run(id,user,title,status);
 return {db,add};
}
test('French application detection uses language evidence, not country or optional French mentions',()=>{
 for(const job of [{title:'Gestionnaire, Ingénierie de la fiabilité des sites (SRE)'},{title:'Ingénieur DevOps Cloud AWS (H/F)'},{url:'https://employer.example/fr/jobs/1'},{language:'fr-CA'},{required_fields_json:'["Prénom","Votre expérience"]'}])assert(frenchApplication(job),JSON.stringify(job));
 for(const job of [{title:'Staff Platform Engineer',location:'Paris, France'},{title:'Cloud Engineer',description:'English is required. French is optional. Submit your application.'},{title:'SRE',location:'Montreal, Quebec'},{company:'French Labs',title:'Platform Engineer'}])assert(!frenchApplication(job),JSON.stringify(job));
});
test('French exclusion archives active work only, retains attempts and isolates other accounts',()=>{
 const {db,add}=fixture();try{
 add('f','Gestionnaire SRE');add('e','Staff Engineer');add('s','Ingénieur DevOps','submitted');add('o','Ingénieur DevOps','queued','other');
 db.prepare("UPDATE jobs SET local_attempt_at='prior-attempt' WHERE id='f'").run();
 assert.equal(setFrenchExclusion(db,'u',true).archived.length,1);
 assert.equal(db.prepare("SELECT local_attempt_at FROM jobs WHERE id='f'").get().local_attempt_at,'prior-attempt');
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id='s'").get().status,'submitted');
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id='o'").get().status,'queued');
 assert.equal(archiveFrench(db,'u').length,0);
 }finally{db.close()}
});
test('manual retry records are idempotent per click and never confirm or inflate application totals',()=>{
 const {db,add}=fixture();try{
 add('j','Engineer');let job=db.prepare("SELECT * FROM jobs WHERE id='j'").get();
 db.prepare("UPDATE jobs SET required_fields_json='[\"Old missing question\"]' WHERE id='j'").run();
 assert.equal(recordManualSubmit(db,job,'click-1').clicks,1);
 assert.equal(db.prepare("SELECT required_fields_json FROM jobs WHERE id='j'").get().required_fields_json,'[]');
 job=db.prepare("SELECT * FROM jobs WHERE id='j'").get();const first=job.local_attempt_at;
 assert.equal(recordManualSubmit(db,job,'click-1').duplicate,true);
 assert.equal(recordManualSubmit(db,job,'click-2').clicks,2);
 const after=db.prepare("SELECT * FROM jobs WHERE id='j'").get();assert.equal(after.local_attempt_at,first);assert.equal(after.status,'local_browser');
 assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type='submission_started'").get().n,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type='manual_submission_retry'").get().n,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type='submitted'").get().n,0);
 }finally{db.close()}
});
