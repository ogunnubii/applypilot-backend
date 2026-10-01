import {randomUUID} from 'node:crypto';
export function historyKey(value){return String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'');}
export function companyKey(value){let s=String(value||'').toLowerCase().replace(/\b(incorporated|inc|corporation|corp|limited|ltd|llc)\.?\s*$/,'').trim();const key=historyKey(s);return ({clutchtechnologies:'clutch',arhsdevelopments:'arhs',pricewaterhousecoopers:'pwc'})[key]||key;}
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
}
export function importHistory(db,uid,rows){
 if(!Array.isArray(rows)||!rows.length||rows.length>500)throw Error('Import 1–500 application records');
 const clean=rows.map(r=>{if(r.interview_stage!==undefined&&!['scheduled','completed','needs_scheduling'].includes(r.interview_stage))throw Error('Choose a valid interview stage');const company=String(r.company||'').trim(),title=String(r.title||'').trim(),status=r.status||'applied';
 if(!company||!title||company.length>200||title.length>300||!['applied','interview','screening','rejected','offer'].includes(status))throw Error('Each record needs company, title and a valid status');
 return {company,title,status,interview_stage:r.interview_stage,notes:String(r.notes||'').slice(0,2000),source:String(r.source||'Tsenta — applicant supplied').slice(0,200),work_mode:['remote','hybrid','on-site'].includes(r.work_mode)?r.work_mode:'unknown',country:String(r.country||'').trim().slice(0,100),interview_at:String(r.interview_at||'').trim().slice(0,100)};});
 let added=0,updated=0,blocked=0;const active=[];const at=new Date().toISOString();
 db.exec('BEGIN IMMEDIATE');try{
 for(const r of clean){const ck=companyKey(r.company),tk=historyKey(r.title);if(!ck||!tk)throw Error('Company and title must contain letters or numbers');
 const old=db.prepare('SELECT * FROM external_application_history WHERE user_id=? AND company_key=? AND title_key=?').get(uid,ck,tk);
 // Re-importing a plain application must not erase a later outcome.
 const status=old&&r.status==='applied'&&old.status!=='applied'?old.status:r.status;
 if(old){db.prepare("UPDATE external_application_history SET status=?,notes=?,updated_at=?,work_mode=?,country=?,interview_at=?,interview_stage=? WHERE id=?").run(status,r.notes||old.notes,at,r.work_mode==='unknown'?old.work_mode:r.work_mode,r.country||old.country,r.interview_at||old.interview_at,r.interview_stage||old.interview_stage,old.id);updated++;}
 else{db.prepare('INSERT INTO external_application_history(id,user_id,company,title,company_key,title_key,status,source,notes,imported_at,updated_at,work_mode,country,interview_at,interview_stage) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),uid,r.company,r.title,ck,tk,status,r.source,r.notes,at,at,r.work_mode,r.country,r.interview_at,r.interview_stage||'scheduled');added++;}
 const matches=db.prepare('SELECT * FROM jobs WHERE user_id=? AND history_company(company)=? AND history_title(title)=?').all(uid,ck,tk);
 for(const j of matches){
 if(['saved','queued','paused','needs_review'].includes(j.status)&&!j.handoff_available&&!j.local_attempt_at){
 db.prepare("UPDATE jobs SET status='duplicate',challenge='Already applied externally',updated_at=? WHERE id=?").run(at,j.id);
 db.prepare('INSERT INTO events(job_id,at,type,message) VALUES(?,?,?,?)').run(j.id,at,'duplicate','Matched imported external application history; repeat application blocked');blocked++;
 }else if(['running','local_browser'].includes(j.status))active.push({id:j.id,company:j.company,title:j.title});
 }
 }
 db.exec('COMMIT');return {added,updated,blocked,active,total:db.prepare('SELECT count(*) n FROM external_application_history WHERE user_id=?').get(uid).n};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
