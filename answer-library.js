import {randomUUID} from 'node:crypto';
import {sensitive} from './local-policy.js';
const {normalize,fieldKind}=globalThis.ApplyPilotPolicy;
export const canCapture=q=>typeof q==='string'&&q.trim().length>1&&q.length<=240&&!sensitive(q)&&!/(password|one.?time|verification code|captcha|date of birth|birth date|ethnic|race|gender|disability|veteran|sexual orientation|religion|medical)/i.test(q);
export const canReuse=q=>canCapture(q)&&!/(sponsor|visa|eligible|authoriz|citizen|country of residence|hear about|referred|referral|this (job|role|company|position)|salary|compensation|notice period|available|current company|current employer|relocat|start date)/i.test(q);
const basic=q=>/^(full name|first name|last name|email|email address|phone|phone number|linkedin profile|github|city|location|location \(city\))\s*[*?]?$/i.test(q.trim());
export function installLibrary(db){db.exec(`CREATE TABLE IF NOT EXISTS answer_history(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,applicant_id TEXT NOT NULL,job_id TEXT NOT NULL,question TEXT NOT NULL,answer TEXT NOT NULL,reusable INTEGER NOT NULL DEFAULT 0,confirmed INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,UNIQUE(job_id,question));`);if(!db.prepare('PRAGMA table_info(answer_history)').all().some(c=>c.name==='reuse_reviewed'))db.exec('ALTER TABLE answer_history ADD COLUMN reuse_reviewed INTEGER NOT NULL DEFAULT 0');}
export function captureAnswers(db,j,fields){
 if(!Array.isArray(fields)||fields.length>120)throw Error('Up to 120 answers can be saved at once');
 const rows=fields.filter(f=>canCapture(f?.question)&&typeof f.answer==='string'&&f.answer.trim()&&f.answer.length<=4000);
 db.exec('BEGIN IMMEDIATE');try{for(const f of rows){const question=f.question.trim(),answer=f.answer.trim(),old=db.prepare('SELECT * FROM answer_history WHERE job_id=? AND question=?').get(j.id,question);if(old&&old.answer!==answer&&old.reusable)forget(db,old);db.prepare(`INSERT INTO answer_history(id,user_id,applicant_id,job_id,question,answer,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(job_id,question) DO UPDATE SET answer=excluded.answer,reusable=CASE WHEN answer_history.answer=excluded.answer THEN answer_history.reusable ELSE 0 END,confirmed=CASE WHEN answer_history.answer=excluded.answer THEN answer_history.confirmed ELSE 0 END,updated_at=excluded.updated_at`).run(randomUUID(),j.user_id,j.applicant_id,j.id,question,answer,new Date().toISOString());}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return rows.length;
}
function forget(db,row){const p=db.prepare('SELECT answers_json FROM applicants WHERE id=?').get(row.applicant_id);const a=JSON.parse(p?.answers_json||'{}');if(a[row.question]===row.answer){delete a[row.question];db.prepare('UPDATE applicants SET answers_json=? WHERE id=?').run(JSON.stringify(a),row.applicant_id);}}
export function updateLibrary(db,uid,id,answer,reuse){const row=db.prepare('SELECT * FROM answer_history WHERE id=? AND user_id=?').get(id,uid);if(!row)throw Error('Answer not found');if(typeof answer!=='string'||!answer.trim()||answer.length>4000)throw Error('Enter an answer up to 4000 characters');if(reuse&&!canReuse(row.question))throw Error('This answer must remain specific to its application');db.exec('BEGIN IMMEDIATE');try{forget(db,row);db.prepare('UPDATE answer_history SET answer=?,reusable=?,reuse_reviewed=1,updated_at=? WHERE id=?').run(answer.trim(),reuse?1:0,new Date().toISOString(),id);if(reuse){const p=db.prepare('SELECT answers_json FROM applicants WHERE id=?').get(row.applicant_id),a=JSON.parse(p.answers_json||'{}');Object.defineProperty(a,row.question,{value:answer.trim(),enumerable:true});db.prepare('UPDATE applicants SET answers_json=? WHERE id=?').run(JSON.stringify(a),row.applicant_id);}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
export function deleteLibrary(db,uid,id){const row=db.prepare('SELECT * FROM answer_history WHERE id=? AND user_id=?').get(id,uid);if(!row)throw Error('Answer not found');forget(db,row);db.prepare('DELETE FROM answer_history WHERE id=? AND user_id=?').run(id,uid);}
export function confirmLibrary(db,j){db.prepare('UPDATE answer_history SET confirmed=1 WHERE job_id=?').run(j.id);for(const r of db.prepare('SELECT * FROM answer_history WHERE job_id=?').all(j.id)){if(basic(r.question)&&canReuse(r.question)){const p=db.prepare('SELECT answers_json FROM applicants WHERE id=?').get(j.applicant_id),a=JSON.parse(p.answers_json||'{}');if(!a[r.question]||a[r.question]===r.answer)updateLibrary(db,j.user_id,r.id,r.answer,true);}}}

// Only receipt-confirmed ordinary facts or explicitly approved answers can be learned.
// A user's explicit decision not to reuse is retained. Conflicts are never resolved by recency.
export function reusableAnswers(db,p){
 const answers=JSON.parse(p.answers_json||'{}'),groups=new Map();
 const group=q=>fieldKind(q)||normalize(q);
 for(const [q,a] of Object.entries(answers)){const k=group(q);if(!groups.has(k))groups.set(k,[]);groups.get(k).push([q,String(a)]);}
 const rows=db.prepare('SELECT question,answer,reusable,confirmed,reuse_reviewed FROM answer_history WHERE user_id=? AND applicant_id=?').all(p.user_id,p.id);
 for(const r of rows){
  if(!r.reusable&&!(r.confirmed&&!r.reuse_reviewed&&canReuse(r.question)&&!!fieldKind(r.question)))continue;
  const k=group(r.question);if(!groups.has(k))groups.set(k,[]);groups.get(k).push([r.question,r.answer]);
 }
 const result=Object.create(null);
 for(const r of rows){const entries=groups.get(group(r.question));if(entries)entries.push([r.question,r.answer]);}
 for(const entries of groups.values()){if(new Set(entries.map(([,a])=>normalize(a))).size!==1)continue;for(const [q,a]of entries)result[q]=a;}
 return result;
}
