import {canonicalJobURL} from './form-policy.js';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
const location=resolve(process.env.DATABASE_PATH||'./data/applypilot.sqlite');mkdirSync(dirname(location),{recursive:true});
export const db=new DatabaseSync(location);db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS applicants(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,email TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',location TEXT NOT NULL DEFAULT '',focus TEXT NOT NULL DEFAULT '',answers_json TEXT NOT NULL DEFAULT '{}',resume_path TEXT,consent INTEGER NOT NULL DEFAULT 0,ai_consent INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),applicant_id TEXT NOT NULL REFERENCES applicants(id),title TEXT NOT NULL,company TEXT NOT NULL,url TEXT NOT NULL,normalized_url TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'saved',notes TEXT NOT NULL DEFAULT '',attempts INTEGER NOT NULL DEFAULT 0,lease_at TEXT,confirmation TEXT,challenge TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(applicant_id,normalized_url));
CREATE TABLE IF NOT EXISTS answer_cache(cache_key TEXT PRIMARY KEY,answer TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS searches(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),applicant_id TEXT NOT NULL REFERENCES applicants(id),instruction TEXT NOT NULL,boards_json TEXT NOT NULL,auto_queue INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1,last_run TEXT,last_error TEXT,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS searches_due ON searches(enabled,last_run);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES jobs(id),at TEXT NOT NULL,type TEXT NOT NULL,message TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status,created_at);CREATE INDEX IF NOT EXISTS events_job ON events(job_id,id);`);
if(!db.prepare('PRAGMA table_info(searches)').all().some(c=>c.name==='auto_generated'))db.exec('ALTER TABLE searches ADD COLUMN auto_generated INTEGER NOT NULL DEFAULT 0');
export function event(id,type,message){db.prepare('INSERT INTO events(job_id,at,type,message) VALUES(?,?,?,?)').run(id,new Date().toISOString(),type,String(message).slice(0,800))}
export const now=()=>new Date().toISOString();
export {canonicalJobURL as normalizeURL} from './form-policy.js';

db.exec(`CREATE TABLE IF NOT EXISTS worker_status(id INTEGER PRIMARY KEY,heartbeat TEXT NOT NULL);CREATE TABLE IF NOT EXISTS chat_usage(user_id TEXT NOT NULL,day TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(user_id,day));`);

if(!db.prepare('PRAGMA table_info(searches)').all().some(c=>c.name==='last_result_json'))db.exec("ALTER TABLE searches ADD COLUMN last_result_json TEXT");

if(!db.prepare('PRAGMA table_info(jobs)').all().some(c=>c.name==='answers_json'))db.exec("ALTER TABLE jobs ADD COLUMN answers_json TEXT NOT NULL DEFAULT '{}'");

// Keep duplicate records and their event history, but exclude them from future work.
const identityRows=db.prepare("SELECT * FROM jobs WHERE status!='duplicate' ORDER BY created_at,id").all();
const identityGroups=new Map();for(const row of identityRows){let key;try{key=canonicalJobURL(row.url)}catch{continue}const group=row.applicant_id+'|'+key;if(!identityGroups.has(group))identityGroups.set(group,{key,rows:[]});identityGroups.get(group).rows.push(row);}
db.exec('BEGIN IMMEDIATE');try{
 for(const {key,rows} of identityGroups.values()){
  const rank=r=>r.status==='submitted'?0:['Unconfirmed submission','Submission in progress'].includes(r.challenge)?1:r.status==='running'?2:r.status==='paused'?3:4;
  rows.sort((a,b)=>rank(a)-rank(b));const keeper=rows[0];
  for(const duplicate of rows.slice(1)){
   db.prepare("UPDATE jobs SET status='duplicate',normalized_url=?,updated_at=? WHERE id=?").run('duplicate:'+duplicate.id,now(),duplicate.id);
   event(duplicate.id,'duplicate','Duplicate record retained; active application: '+keeper.id);
  }
  db.prepare('UPDATE jobs SET normalized_url=? WHERE id=?').run(key,keeper.id);
 }
 db.exec('COMMIT');
}catch(e){db.exec('ROLLBACK');throw e}

if(!db.prepare('PRAGMA table_info(jobs)').all().some(c=>c.name==='required_fields_json'))db.exec("ALTER TABLE jobs ADD COLUMN required_fields_json TEXT NOT NULL DEFAULT '[]'");
