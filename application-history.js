import {randomUUID} from 'node:crypto';
import {canonicalJobURL} from './form-policy.js';
export function historyKey(value){return String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'');}
const COMPANY_ALIASES=Object.freeze(Object.assign(Object.create(null),{clutchtechnologies:'clutch',arhsdevelopments:'arhs',pricewaterhousecoopers:'pwc'}));
export function companyKey(value){let s=String(value||'').toLowerCase().replace(/\b(incorporated|inc|corporation|corp|limited|ltd|llc)\.?\s*$/,'').trim();const key=historyKey(s);// Own keys only: an employer named "Constructor" or "toString" must not resolve to
// Object.prototype members (that broke SQLite binding mid-import).
const aliases=COMPANY_ALIASES;return Object.hasOwn(aliases,key)?aliases[key]:key;}
export function installHistory(db){
 db.function('history_company',{deterministic:true},companyKey);db.function('history_title',{deterministic:true},historyKey);
 db.exec(`CREATE TABLE IF NOT EXISTS external_application_history(
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),company TEXT NOT NULL,title TEXT NOT NULL,
 company_key TEXT NOT NULL,title_key TEXT NOT NULL,status TEXT NOT NULL,source TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',
 imported_at TEXT NOT NULL,updated_at TEXT NOT NULL,work_mode TEXT NOT NULL DEFAULT 'unknown',country TEXT NOT NULL DEFAULT '',interview_at TEXT NOT NULL DEFAULT '',UNIQUE(user_id,company_key,title_key));
 CREATE TRIGGER IF NOT EXISTS history_skip_new AFTER INSERT ON jobs
 WHEN EXISTS(SELECT 1 FROM external_application_history h WHERE h.user_id=NEW.user_id AND h.company_key=history_company(NEW.company) AND h.title_key=history_title(NEW.title))
 BEGIN UPDATE jobs SET status='duplicate',challenge='Already applied externally' WHERE id=NEW.id; END;
 CREATE TRIGGER IF NOT EXISTS history_block_restart BEFORE UPDATE OF status ON jobs
 WHEN NEW.status IN ('queued','running','local_browser') AND EXISTS(SELECT 1 FROM external_application_history h WHERE h.user_id=NEW.user_id AND h.company_key=history_company(NEW.company) AND h.title_key=history_title(NEW.title))
 BEGIN SELECT RAISE(ABORT,'Already applied externally: repeat application blocked'); END;
 CREATE TRIGGER IF NOT EXISTS history_block_attempt BEFORE UPDATE OF local_attempt_at ON jobs
 WHEN OLD.local_attempt_at IS NULL AND NEW.local_attempt_at IS NOT NULL AND EXISTS(SELECT 1 FROM external_application_history h WHERE h.user_id=NEW.user_id AND h.company_key=history_company(NEW.company) AND h.title_key=history_title(NEW.title))
 BEGIN SELECT RAISE(ABORT,'Already applied externally: repeat submission blocked'); END;`);
 const columns=new Set(db.prepare('PRAGMA table_info(external_application_history)').all().map(r=>r.name));
 if(!columns.has('interview_stage'))db.exec("ALTER TABLE external_application_history ADD COLUMN interview_stage TEXT NOT NULL DEFAULT 'scheduled'");
 // A recorded job link blocks that exact posting too, even if its title changed.
 if(!columns.has('url_key'))db.exec("ALTER TABLE external_application_history ADD COLUMN url_key TEXT NOT NULL DEFAULT ''");
 if(db.prepare('PRAGMA table_info(jobs)').all().some(c=>c.name==='normalized_url'))db.exec(`CREATE TRIGGER IF NOT EXISTS history_skip_url AFTER INSERT ON jobs
 WHEN EXISTS(SELECT 1 FROM external_application_history h WHERE h.user_id=NEW.user_id AND h.url_key<>'' AND h.url_key=NEW.normalized_url)
 BEGIN UPDATE jobs SET status='duplicate',challenge='Already applied externally' WHERE id=NEW.id; END;
 CREATE TRIGGER IF NOT EXISTS history_block_url_restart BEFORE UPDATE OF status ON jobs
 WHEN NEW.status IN ('queued','running','local_browser') AND EXISTS(SELECT 1 FROM external_application_history h WHERE h.user_id=NEW.user_id AND h.url_key<>'' AND h.url_key=NEW.normalized_url)
 BEGIN SELECT RAISE(ABORT,'Already applied externally: repeat application blocked'); END;
 CREATE TRIGGER IF NOT EXISTS history_block_url_attempt BEFORE UPDATE OF local_attempt_at ON jobs
 WHEN OLD.local_attempt_at IS NULL AND NEW.local_attempt_at IS NOT NULL AND EXISTS(SELECT 1 FROM external_application_history h WHERE h.user_id=NEW.user_id AND h.url_key<>'' AND h.url_key=NEW.normalized_url)
 BEGIN SELECT RAISE(ABORT,'Already applied externally: repeat submission blocked'); END;`);
 // Provenance: the original tool's own status label, kept verbatim.
 if(!columns.has('source_status'))db.exec("ALTER TABLE external_application_history ADD COLUMN source_status TEXT NOT NULL DEFAULT ''");
 // URL aliases: every link a record was known by (board, ATS, LinkedIn, Indeed).
 db.exec(`CREATE TABLE IF NOT EXISTS external_history_urls(user_id TEXT NOT NULL,url_key TEXT NOT NULL,history_id TEXT NOT NULL REFERENCES external_application_history(id),PRIMARY KEY(user_id,url_key));
 INSERT OR IGNORE INTO external_history_urls(user_id,url_key,history_id) SELECT user_id,url_key,id FROM external_application_history WHERE url_key<>'';
 CREATE TABLE IF NOT EXISTS history_employer_holds(user_id TEXT NOT NULL,employer_key TEXT NOT NULL,company TEXT NOT NULL,source TEXT NOT NULL,reason TEXT NOT NULL,history_id TEXT,created_at TEXT NOT NULL,released_at TEXT,PRIMARY KEY(user_id,employer_key));`);
 if(db.prepare('PRAGMA table_info(jobs)').all().some(c=>c.name==='normalized_url'))db.exec(`CREATE TRIGGER IF NOT EXISTS history_skip_alias AFTER INSERT ON jobs
 WHEN EXISTS(SELECT 1 FROM external_history_urls h WHERE h.user_id=NEW.user_id AND h.url_key=NEW.normalized_url)
 BEGIN UPDATE jobs SET status='duplicate',challenge='Already applied externally' WHERE id=NEW.id; END;
 CREATE TRIGGER IF NOT EXISTS history_block_alias_restart BEFORE UPDATE OF status ON jobs
 WHEN NEW.status IN ('queued','running','local_browser') AND EXISTS(SELECT 1 FROM external_history_urls h WHERE h.user_id=NEW.user_id AND h.url_key=NEW.normalized_url)
 BEGIN SELECT RAISE(ABORT,'Already applied externally: repeat application blocked'); END;
 CREATE TRIGGER IF NOT EXISTS history_block_alias_attempt BEFORE UPDATE OF local_attempt_at ON jobs
 WHEN OLD.local_attempt_at IS NULL AND NEW.local_attempt_at IS NOT NULL AND EXISTS(SELECT 1 FROM external_history_urls h WHERE h.user_id=NEW.user_id AND h.url_key=NEW.normalized_url)
 BEGIN SELECT RAISE(ABORT,'Already applied externally: repeat submission blocked'); END;`);
}
// Employer key used by holds: the same normalization as employer-limits.
export const historyEmployerKey=company=>{const name=String(company||'').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g,'');return name?'company:'+name:'';};
function boardKeys(urlKeys){
 const keys=[];for(const key of urlKeys){try{const u=new URL(key),parts=u.pathname.split('/').filter(Boolean);
  if(['jobs.ashbyhq.com','jobs.eu.ashbyhq.com'].includes(u.hostname)&&parts[0])keys.push('ashby:'+parts[0].toLowerCase());
  if(['jobs.lever.co','jobs.eu.lever.co'].includes(u.hostname)&&parts[0])keys.push('lever:'+parts[0].toLowerCase());
  if(['boards.greenhouse.io','job-boards.greenhouse.io'].includes(u.hostname)&&parts[0])keys.push('greenhouse:'+parts[0].toLowerCase());}catch{}}
 return keys;
}
export function historyEmployerHolds(db,userId){return db.prepare('SELECT employer_key,company,source,reason,created_at,released_at FROM history_employer_holds WHERE user_id=? ORDER BY created_at DESC').all(userId);}
export function releaseHistoryEmployerHold(db,userId,employerKey){
 const r=db.prepare('UPDATE history_employer_holds SET released_at=? WHERE user_id=? AND employer_key=? AND released_at IS NULL').run(new Date().toISOString(),userId,String(employerKey||''));
 return r.changes>0;
}
export function importHistory(db,uid,rows){
 if(!Array.isArray(rows)||!rows.length||rows.length>500)throw Error('Import 1–500 application records');
 const clean=rows.map(r=>{if(r.interview_stage!==undefined&&!['scheduled','completed','needs_scheduling'].includes(r.interview_stage))throw Error('Choose a valid interview stage');const company=String(r.company||'').trim(),title=String(r.title||'').trim(),status0=r.status==='attempted'?'uncertain':r.status||'applied';let status=status0;
 const links=[r.url,...(Array.isArray(r.urls)?r.urls:[])].filter(Boolean).slice(0,20);
 if(r.urls!==undefined&&!Array.isArray(r.urls))throw Error('urls for '+company+' must be a list of links');
 const url_keys=[...new Set(links.map(link=>{try{return canonicalJobURL(String(link));}catch{throw Error('Job link for '+company+' is not a valid HTTPS link');}}))],url_key=url_keys[0]||'';
 if(r.status==='excluded')status='uncertain';
 if(!company||!title||company.length>200||title.length>300||!['applied','uncertain','interview','screening','rejected','offer'].includes(status))throw Error('Each record needs company, title and a valid status');
 return {company,title,status,url_key,url_keys,source_status:String(r.source_status??r.original_status??r.status??'').slice(0,80),// Employer-wide holds only when the source says so (an employer-level limit or
 // exclusion). An uncertain record protects its role, same title and every URL
 // alias, not unrelated roles at that employer (AP2 ledger v2 rule).
 employer_hold:r.employer_hold===true||r.status==='excluded',interview_stage:r.interview_stage,notes:String(r.notes||'').slice(0,2000),source:String(r.source||'Tsenta — applicant supplied').slice(0,200),work_mode:['remote','hybrid','on-site'].includes(r.work_mode)?r.work_mode:'unknown',country:String(r.country||'').trim().slice(0,100),interview_at:String(r.interview_at||'').trim().slice(0,100)};});
 let added=0,updated=0,blocked=0,holds=0;const active=[];const at=new Date().toISOString();
 const urlKeyed=db.prepare('PRAGMA table_info(jobs)').all().some(c=>c.name==='normalized_url');
 db.exec('BEGIN IMMEDIATE');try{
 for(const r of clean){const ck=companyKey(r.company),tk=historyKey(r.title);if(!ck||!tk)throw Error('Company and title must contain letters or numbers');
 const old=db.prepare('SELECT * FROM external_application_history WHERE user_id=? AND company_key=? AND title_key=?').get(uid,ck,tk);
 // Re-importing a plain application must not erase a later outcome.
 const status=old&&['applied','uncertain'].includes(r.status)&&!['applied','uncertain'].includes(old.status)?old.status:old&&r.status==='uncertain'&&old.status==='applied'?'applied':r.status;
 let historyId=old?.id;
 if(old){db.prepare("UPDATE external_application_history SET status=?,notes=?,updated_at=?,source_status=CASE WHEN ?<>'' THEN ? ELSE source_status END,url_key=?,work_mode=?,country=?,interview_at=?,interview_stage=? WHERE id=?").run(status,r.notes||old.notes,at,r.source_status,r.source_status,r.url_key||old.url_key||'',r.work_mode==='unknown'?old.work_mode:r.work_mode,r.country||old.country,r.interview_at||old.interview_at,r.interview_stage||old.interview_stage,old.id);updated++;}
 else{historyId=randomUUID();db.prepare('INSERT INTO external_application_history(id,user_id,company,title,company_key,title_key,status,source,notes,imported_at,updated_at,url_key,work_mode,country,interview_at,interview_stage,source_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(historyId,uid,r.company,r.title,ck,tk,status,r.source,r.notes,at,at,r.url_key,r.work_mode,r.country,r.interview_at,r.interview_stage||'scheduled',r.source_status);added++;}
 for(const key of r.url_keys)db.prepare('INSERT OR IGNORE INTO external_history_urls(user_id,url_key,history_id) VALUES(?,?,?)').run(uid,key,historyId);
 // Unknown outcome: hold the whole employer (company and its ATS board). A hold the
 // applicant already released is not re-created by a later re-import.
 if(r.employer_hold)for(const key of [historyEmployerKey(r.company),...boardKeys(r.url_keys)].filter(Boolean)){if(db.prepare('INSERT OR IGNORE INTO history_employer_holds(user_id,employer_key,company,source,reason,history_id,created_at) VALUES(?,?,?,?,?,?,?)').run(uid,key,r.company,r.source,'Earlier application to '+r.company+' ('+r.title+') has an unknown outcome',historyId,at).changes)holds++;}
 const matches=urlKeyed?db.prepare(`SELECT * FROM jobs WHERE user_id=? AND (history_company(company)=? AND history_title(title)=? OR normalized_url IN (SELECT url_key FROM external_history_urls WHERE user_id=? AND history_id=?))`).all(uid,ck,tk,uid,historyId):db.prepare('SELECT * FROM jobs WHERE user_id=? AND history_company(company)=? AND history_title(title)=?').all(uid,ck,tk);
 for(const j of matches){
 if(['saved','queued','paused','needs_review'].includes(j.status)&&!j.handoff_available&&!j.local_attempt_at){
 db.prepare("UPDATE jobs SET status='duplicate',challenge='Already applied externally',updated_at=? WHERE id=?").run(at,j.id);
 db.prepare('INSERT INTO events(job_id,at,type,message) VALUES(?,?,?,?)').run(j.id,at,'duplicate','Matched imported external application history; repeat application blocked');blocked++;
 }else if(['running','local_browser'].includes(j.status))active.push({id:j.id,company:j.company,title:j.title});
 }
 }
 db.exec('COMMIT');return {added,updated,blocked,holds,active,total:db.prepare('SELECT count(*) n FROM external_application_history WHERE user_id=?').get(uid).n};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
