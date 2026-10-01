export function canArchive(j){return !!j&&!j.handoff_available&&(['saved','queued','paused','needs_review'].includes(j.status)||j.status==='local_browser'&&j.local_phase==='blocked'&&!j.local_attempt_at);}
export function installArchive(db){db.exec("CREATE TABLE IF NOT EXISTS application_archive(job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,previous_status TEXT NOT NULL,archived_at TEXT NOT NULL)");}
export function archiveApplications(db,uid,ids){
 if(!Array.isArray(ids)||!ids.length||ids.length>500||ids.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)))throw Error('Choose between 1 and 500 application IDs');
 const archived=[],skipped=[];db.exec('BEGIN IMMEDIATE');
 try{for(const id of new Set(ids)){const j=db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(id,uid);
 if(!canArchive(j)){skipped.push(id);continue;}const at=new Date().toISOString();
 db.prepare('INSERT OR REPLACE INTO application_archive(job_id,previous_status,archived_at) VALUES(?,?,?)').run(id,j.status,at);
 db.prepare("UPDATE jobs SET status='archived',updated_at=? WHERE id=? AND user_id=?").run(at,id,uid);
 db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'archived','Removed from active applications. History and duplicate protection retained.')").run(id,at);
 db.prepare('DELETE FROM work_focus WHERE user_id=? AND job_id=?').run(uid,id);archived.push(id);
 }db.exec('COMMIT');return {archived,skipped};}catch(e){db.exec('ROLLBACK');throw e;}
}
export function restoreApplication(db,uid,id){
 db.exec('BEGIN IMMEDIATE');try{
 const j=db.prepare('SELECT j.*,a.previous_status FROM jobs j JOIN application_archive a ON a.job_id=j.id WHERE j.id=? AND j.user_id=?').get(id,uid);
 if(!j||j.status!=='archived'||['submitted','interview','rejected','offer'].includes(j.previous_status))throw Error('Archived application not found');
 const status=j.previous_status==='local_browser'?'local_browser':'paused',at=new Date().toISOString();
 db.prepare('UPDATE jobs SET status=?,updated_at=? WHERE id=? AND user_id=?').run(status,at,id,uid);
 db.prepare('DELETE FROM application_archive WHERE job_id=?').run(id);
 db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'restored','Restored for review; not automatically queued.')").run(id,at);
 db.exec('COMMIT');return {ok:true};}catch(e){db.exec('ROLLBACK');throw e;}
}
