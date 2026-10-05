import {randomUUID} from 'node:crypto';

export function installExperience(db){
 db.exec(`CREATE TABLE IF NOT EXISTS professional_experience(
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL,applicant_id TEXT NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
 title TEXT NOT NULL,details TEXT NOT NULL,approved_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS experience_profile ON professional_experience(user_id,applicant_id);`);
}
export function experienceFor(db,uid,applicant){
 return db.prepare('SELECT id,title,details,approved_at,updated_at FROM professional_experience WHERE user_id=? AND applicant_id=? ORDER BY title,id').all(uid,applicant);
}
export function saveExperience(db,uid,applicant,input,id=null){
 if(!db.prepare('SELECT id FROM applicants WHERE id=? AND user_id=?').get(applicant,uid))throw Error('Profile not found.');
 if(input.approved!==true)throw Error('Confirm these are your real professional facts before saving.');
 const title=typeof input.title==='string'?input.title.trim():'',details=typeof input.details==='string'?input.details.trim():'';
 if(title.length<3||title.length>160||details.length<20||details.length>8000)throw Error('Add a short title and 20–8,000 characters of factual detail.');
 const existing=id&&db.prepare('SELECT id FROM professional_experience WHERE id=? AND user_id=? AND applicant_id=?').get(id,uid,applicant);
 if(id&&!existing)throw Error('Experience not found.');
 if(!id&&db.prepare('SELECT COUNT(*) AS n FROM professional_experience WHERE user_id=? AND applicant_id=?').get(uid,applicant).n>=150)throw Error('Edit an existing example before adding more than 150.');
 id=id||randomUUID();const at=new Date().toISOString();
 db.prepare(`INSERT INTO professional_experience VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,details=excluded.details,approved_at=excluded.approved_at,updated_at=excluded.updated_at`).run(id,uid,applicant,title,details,at,at);
 return {id};
}
export function deleteExperience(db,uid,applicant,id){
 if(!db.prepare('DELETE FROM professional_experience WHERE id=? AND user_id=? AND applicant_id=?').run(id,uid,applicant).changes)throw Error('Experience not found.');
}
