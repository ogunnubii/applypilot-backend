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
export function normalizeURL(s){let u=new URL(s);if(u.protocol!=='https:')throw Error('Use an HTTPS job link');u.hash='';for(let k of [...u.searchParams.keys()])if(k.startsWith('utm_')||['ref','source','gh_src'].includes(k))u.searchParams.delete(k);u.hostname=u.hostname.toLowerCase();return u.toString().replace(/\/$/,'')}

db.exec(`CREATE TABLE IF NOT EXISTS worker_status(id INTEGER PRIMARY KEY,heartbeat TEXT NOT NULL);CREATE TABLE IF NOT EXISTS chat_usage(user_id TEXT NOT NULL,day TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(user_id,day));`);

if(!db.prepare('PRAGMA table_info(searches)').all().some(c=>c.name==='last_result_json'))db.exec("ALTER TABLE searches ADD COLUMN last_result_json TEXT");
