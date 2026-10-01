import {companyKey} from './application-history.js';
export function applicationRoleKey(value){
 const title=String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 // Remove only our display annotations, retaining functional/team distinctions.
 return title.replace(/\s+[—–]\s+[^—–]*(?:sponsor|relocation|remote|on-site|hybrid)[^—–]*$/i,'').replace(/[^a-z0-9]+/g,'');
}
function employerKeys(job){
 const keys=[companyKey(job.company)];
 try{const u=new URL(job.url);if(/^(?:jobs\.ashbyhq\.com|(?:job-)?boards\.greenhouse\.io|jobs(?:\.eu)?\.lever\.co)$/.test(u.hostname))keys.push(companyKey(decodeURIComponent(u.pathname.split('/')[1])));}catch{}
 return keys.filter(Boolean);
}
function postingKey(value){
 try{const u=new URL(value),p=u.pathname.split('/').filter(Boolean);
 if(u.hostname==='jobs.ashbyhq.com'&&/^[a-f0-9-]{36}$/i.test(p[1]||''))return 'ashby:'+p[0].toLowerCase()+':'+p[1].toLowerCase();
 if(/^(?:job-)?boards\.greenhouse\.io$/.test(u.hostname)&&p[1]==='jobs'&&/^\d+$/.test(p[2]||''))return 'greenhouse:'+p[0].toLowerCase()+':'+p[2];
 if(/^jobs(?:\.eu)?\.lever\.co$/.test(u.hostname)&&/^[a-f0-9-]{36}$/i.test(p[1]||''))return u.hostname+':'+p[0].toLowerCase()+':'+p[1].toLowerCase();
 }catch{}return '';
}
export function sameApplication(a,b){
 const ak=postingKey(a.url),bk=postingKey(b.url);if(ak&&ak===bk)return true;
 const role=applicationRoleKey(a.title);
 return !!role&&role===applicationRoleKey(b.title)&&employerKeys(a).some(k=>employerKeys(b).includes(k));
}
const protectedStatus="('submitted','interview','rejected','offer','archived','queued','running','local_browser')";
export function priorApplication(db,userId,job){
 return db.prepare("SELECT id,title,company,url,status,local_attempt_at FROM jobs WHERE user_id=? AND id!=? AND (status IN "+protectedStatus+" OR local_attempt_at IS NOT NULL)").all(userId,job.id||'').find(old=>sameApplication(job,old))||null;
}
export function installRepeatGuard(db){
 db.function('same_application',{deterministic:true},(ac,at,au,bc,bt,bu)=>Number(sameApplication({company:ac,title:at,url:au},{company:bc,title:bt,url:bu})));
 const duplicate="EXISTS(SELECT 1 FROM jobs old WHERE old.user_id=NEW.user_id AND old.id!=NEW.id AND (old.status IN "+protectedStatus+" OR old.local_attempt_at IS NOT NULL) AND same_application(NEW.company,NEW.title,NEW.url,old.company,old.title,old.url))";
 db.exec(`
 CREATE TRIGGER IF NOT EXISTS repeat_block_restart BEFORE UPDATE OF status ON jobs
 WHEN NEW.status IN ('queued','running','local_browser') AND ${duplicate}
 BEGIN SELECT RAISE(ABORT,'Already applied or in progress: repeat application blocked'); END;
 CREATE TRIGGER IF NOT EXISTS repeat_block_attempt BEFORE UPDATE OF local_attempt_at ON jobs
 WHEN OLD.local_attempt_at IS NULL AND NEW.local_attempt_at IS NOT NULL AND ${duplicate}
 BEGIN SELECT RAISE(ABORT,'Already applied or in progress: repeat submission blocked'); END;
 CREATE TRIGGER IF NOT EXISTS repeat_skip_new AFTER INSERT ON jobs
 WHEN NEW.status='saved' AND ${duplicate}
 BEGIN UPDATE jobs SET status='duplicate',challenge='Already applied or in progress' WHERE id=NEW.id; END;
 `);
 // Retain receipt/attempt records; hide only untouched duplicate work.
 const pending=db.prepare("SELECT * FROM jobs WHERE status IN ('saved','queued','paused','needs_review') AND local_attempt_at IS NULL AND attempts=0 AND handoff_available=0 ORDER BY created_at,id").all();
 for(const job of pending){const prior=priorApplication(db,job.user_id,job);if(prior)db.prepare("UPDATE jobs SET status='duplicate',challenge=?,updated_at=? WHERE id=?").run('Repeat application held; existing record: '+prior.id,new Date().toISOString(),job.id);}
}
