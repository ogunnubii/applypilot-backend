const plain=v=>String(v||'').replace(/<[^>]*>/g,' ').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export function frenchApplication(job={}){
 let metadata={};try{metadata=JSON.parse(job.job_metadata_json||'{}')}catch{}
 const lang=String(job.language||job.formLanguage||metadata.formLanguage||'').toLowerCase();
 if(/^fr(?:-|$)/.test(lang)||metadata.frenchApplication===true)return true;
 const title=plain(job.title),text=plain([job.title,job.description,job.required_fields_json].join(' '));
 if(/\b(?:ingenieur|ingenieure|gestionnaire|developpeur|developpeuse|administrateur|administratrice|conseiller|conseillere|technicien|technicienne)\b/.test(title))return true;
 if(/(?:[?&](?:lang|locale|language)=fr(?:[-_][a-z]+)?(?:&|$)|\/fr(?:[-_](?:ca|fr))?\/)/i.test(job.url||''))return true;
 const signals=['postuler','candidature','votre experience','vos competences','curriculum vitae','lettre de motivation','prenom','courriel','autorise a travailler','nous recherchons','vous serez','rejoignez'];
 return signals.filter(s=>text.includes(s)).length>=2;
}
export function installLanguagePolicy(db){
 db.exec("CREATE TABLE IF NOT EXISTS language_preferences(user_id TEXT PRIMARY KEY,exclude_french INTEGER NOT NULL DEFAULT 0)");
}
export function excludesFrench(db,uid){try{return !!db.prepare('SELECT exclude_french FROM language_preferences WHERE user_id=?').get(uid)?.exclude_french}catch{return false}}
export function archiveFrench(db,uid){
 if(!excludesFrench(db,uid))return [];
 const archived=[],at=new Date().toISOString();
 for(const job of db.prepare("SELECT * FROM jobs WHERE user_id=? AND status IN ('saved','queued','paused','needs_review','local_browser')").all(uid)){
  if(!frenchApplication(job)||job.handoff_available)continue;
  db.prepare('INSERT OR REPLACE INTO application_archive(job_id,previous_status,archived_at) VALUES(?,?,?)').run(job.id,job.status,at);
  db.prepare("UPDATE jobs SET status='archived',challenge='French-language application excluded',updated_at=? WHERE id=?").run(at,job.id);
  db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'archived','French-language application excluded by your preference. History and attempts retained.')").run(job.id,at);
  db.prepare('DELETE FROM work_focus WHERE user_id=? AND job_id=?').run(uid,job.id);archived.push({id:job.id,title:job.title,company:job.company});
 }return archived;
}
export function setFrenchExclusion(db,uid,enabled){
 if(typeof enabled!=='boolean')throw Error('Choose whether to exclude French applications');
 db.exec('BEGIN IMMEDIATE');try{
 db.prepare('INSERT INTO language_preferences(user_id,exclude_french) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET exclude_french=excluded.exclude_french').run(uid,enabled?1:0);
 const archived=archiveFrench(db,uid);db.exec('COMMIT');return {enabled,archived};
 }catch(e){db.exec('ROLLBACK');throw e}
}
