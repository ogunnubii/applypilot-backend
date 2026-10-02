// AI answers remain application-specific; they never become new applicant facts.
export function installFactDrafts(db){db.exec("CREATE TABLE IF NOT EXISTS fact_drafts(job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,question TEXT NOT NULL,answer TEXT NOT NULL,provider TEXT NOT NULL,sources_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(job_id,question,answer))");}
export function hasFactDraft(db,id,question){try{return !!db.prepare('SELECT 1 FROM fact_drafts WHERE job_id=? AND question=?').get(id,question);}catch{return false;}}
export function factDraftProvider(db,id,question,answer){try{return db.prepare('SELECT provider FROM fact_drafts WHERE job_id=? AND question=? AND answer=?').get(id,question,answer)?.provider||null;}catch{return null;}}
export function factDraftConsentWithdrawn(db,id,profile){
 let rows;try{rows=db.prepare('SELECT DISTINCT provider FROM fact_drafts WHERE job_id=?').all(id);}catch{return false;}
 return rows.some(row=>row.provider==='gemini'?!profile?.gemini_facts_consent:!profile?.ai_consent);
}
