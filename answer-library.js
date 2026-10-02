import {hasFactDraft} from './draft-provenance.js';
import {randomUUID} from 'node:crypto';
import {sensitive} from './local-policy.js';
import {canResearchQuestion,hasResearchDraftForQuestion} from './google-research.js';
const {normalize,fieldKind}=globalThis.ApplyPilotPolicy;
export const canCapture=q=>typeof q==='string'&&q.trim().length>1&&q.length<=240&&!sensitive(q)&&!/(password|one.?time|verification code|captcha|date of birth|birth date|ethnic|race|gender|disability|veteran|sexual orientation|religion|medical)/i.test(q);
const APPLICATION_ONLY=[
 /^\s*why\b/i,
 /\bwhat do you know about\b/i,
 /\b(?:cover letter|personal statement|candidate statement|additional (?:information|comments?)|anything else)\b/i,
 /\b(?:tell (?:me|us) about yourself|describe yourself|strengths?|weakness(?:es)?|career goals?|five[- ]year (?:goals?|plan|future)|where do you see yourself|what (?:are you|you are) (?:seeking|looking for) in (?:your )?next (?:role|job|position)|type of (?:role|job|position)|manager expectations?|expect\w* from (?:your|a) manager|culture expectations?|(?:workplace|company|team) culture|conflict|challenge|leadership|accomplishment|know anyone)\b/i,
 /\bwhy\s+(?:should\s+(?:we|[\p{L}\p{N}][\p{L}\p{N} .&'-]{0,80})\s+hire\s+you|(?:do|did|would)\s+you\s+(?:want\s+to\s+(?:work|join)|apply)|(?:are|were)\s+you\s+(?:interested|excited)|(?:this|our)\s+(?:company|organization|role|position|job|opportunity)|us|here)\b/iu,
 /\b(?:interest(?:ed)?|excit\w*|motivat\w*)\b.*\b(?:opportunit(?:y|ies)|role|position|job|company|organization|join(?:ing)?|team|us|here)\b/i,
 /\b(?:opportunit(?:y|ies)|role|position|job|company|organization|join(?:ing)?|team)\b.*\b(?:interest(?:ed)?|excit\w*|motivat\w*)\b/i,
 /\b(?:good fit|best candidate|succeed (?:here|in (?:this|the|our) (?:role|position|job|team|company))|contribut(?:e|es|ed|ing|ion|ions)|value (?:you |would you )?(?:bring|add))\b/i,
 /\b(?:company|organization|mission|values?)\b.*\b(?:align(?:ment|ed|s|ing)?|knowledge|know|understand\w*)\b|\b(?:align(?:ment|ed|s|ing)?|knowledge|know|understand\w*)\b.*\b(?:company|organization|mission|values?)\b/i,
 /\b(?:applied (?:to|for)|worked (?:for|with)|employed by|relatives? (?:or family )?(?:work|worked|employed)|family members? (?:work|worked|employed))\s+(?:us|here|this company|our company|this organization|our organization)\b/i,
 /\b(?:relative|family member|contact|know anyone|referr(?:al|ed))\b.*\b(?:company|organization|employer|team|us|here)\b|\b(?:company|organization|employer|team)\b.*\b(?:relative|family member|contact|know anyone|referr(?:al|ed))\b/i,
 /\b(?:currently interviewing|interviewing (?:with|elsewhere)|where else (?:are|have) you interview\w*|other offers?|current (?:job )?title|current manager|current employer|reason for leaving|reason you (?:are )?leav\w*|why you (?:left|are leaving) (?:your )?(?:current|last)?\s*(?:role|job|position)?)\b/i,
 /\b(?:sponsor(?:ship)?|visa|eligible|authoriz\w*|citizen(?:ship)?|country of residence|hear about|learn (?:about|of)|find (?:this |the )?(?:opening|job|role|position)|referred|referral|salary|compensation|bonus|equity|notice period|availability|available to (?:start|work)|when can you start|relocat\w*|start date|non[- ]?compete|conflict of interest|staffing agency|employment agency|recruiter|agency name|travel|work schedule|shift|weekends?|overtime|remote|hybrid|on[- ]?site)\b/i,
 /\bthis\s+(?:job|role|company|position|opportunity)\b/i
];
export const canReuse=q=>canCapture(q)&&!canResearchQuestion(q)&&!APPLICATION_ONLY.some(pattern=>pattern.test(q));
const basic=q=>/^(full name|first name|last name|email|email address|phone|phone number|linkedin profile|github|city|location|location \(city\))\s*[*?]?$/i.test(q.trim());
export function installLibrary(db){db.exec(`CREATE TABLE IF NOT EXISTS answer_history(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,applicant_id TEXT NOT NULL,job_id TEXT NOT NULL,question TEXT NOT NULL,answer TEXT NOT NULL,reusable INTEGER NOT NULL DEFAULT 0,confirmed INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,UNIQUE(job_id,question));`);if(!db.prepare('PRAGMA table_info(answer_history)').all().some(c=>c.name==='reuse_reviewed'))db.exec('ALTER TABLE answer_history ADD COLUMN reuse_reviewed INTEGER NOT NULL DEFAULT 0');}
export function captureAnswers(db,j,fields){
 if(!Array.isArray(fields)||fields.length>120)throw Error('Up to 120 answers can be saved at once');
 const rows=fields.filter(f=>!hasFactDraft(db,j.id,String(f?.question||'').trim())&&canCapture(f?.question)&&typeof f.answer==='string'&&f.answer.trim()&&f.answer.length<=4000);
 db.exec('BEGIN IMMEDIATE');try{for(const f of rows){const question=f.question.trim(),answer=f.answer.trim(),old=db.prepare('SELECT * FROM answer_history WHERE job_id=? AND question=?').get(j.id,question);if(old&&old.answer!==answer&&old.reusable)forget(db,old);db.prepare(`INSERT INTO answer_history(id,user_id,applicant_id,job_id,question,answer,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(job_id,question) DO UPDATE SET answer=excluded.answer,reusable=CASE WHEN answer_history.answer=excluded.answer THEN answer_history.reusable ELSE 0 END,confirmed=CASE WHEN answer_history.answer=excluded.answer THEN answer_history.confirmed ELSE 0 END,updated_at=excluded.updated_at`).run(randomUUID(),j.user_id,j.applicant_id,j.id,question,answer,new Date().toISOString());}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return rows.length;
}
function forget(db,row){const p=db.prepare('SELECT answers_json FROM applicants WHERE id=?').get(row.applicant_id);const a=JSON.parse(p?.answers_json||'{}');if(a[row.question]===row.answer){delete a[row.question];db.prepare('UPDATE applicants SET answers_json=? WHERE id=?').run(JSON.stringify(a),row.applicant_id);}}
export function updateLibrary(db,uid,id,answer,reuse){const row=db.prepare('SELECT * FROM answer_history WHERE id=? AND user_id=?').get(id,uid);if(!row)throw Error('Answer not found');if(typeof answer!=='string'||!answer.trim()||answer.length>4000)throw Error('Enter an answer up to 4000 characters');if(reuse&&(!canReuse(row.question)||hasFactDraft(db,row.job_id,row.question)||hasResearchDraftForQuestion(db,row.job_id,row.question)))throw Error('This answer must remain specific to its application');db.exec('BEGIN IMMEDIATE');try{forget(db,row);db.prepare('UPDATE answer_history SET answer=?,reusable=?,reuse_reviewed=1,updated_at=? WHERE id=?').run(answer.trim(),reuse?1:0,new Date().toISOString(),id);if(reuse){const p=db.prepare('SELECT answers_json FROM applicants WHERE id=?').get(row.applicant_id),a=JSON.parse(p.answers_json||'{}');Object.defineProperty(a,row.question,{value:answer.trim(),enumerable:true});db.prepare('UPDATE applicants SET answers_json=? WHERE id=?').run(JSON.stringify(a),row.applicant_id);}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
export function deleteLibrary(db,uid,id){const row=db.prepare('SELECT * FROM answer_history WHERE id=? AND user_id=?').get(id,uid);if(!row)throw Error('Answer not found');forget(db,row);db.prepare('DELETE FROM answer_history WHERE id=? AND user_id=?').run(id,uid);}
export function confirmLibrary(db,j){db.prepare('UPDATE answer_history SET confirmed=1 WHERE job_id=?').run(j.id);for(const r of db.prepare('SELECT * FROM answer_history WHERE job_id=?').all(j.id)){if(basic(r.question)&&canReuse(r.question)){const p=db.prepare('SELECT answers_json FROM applicants WHERE id=?').get(j.applicant_id),a=JSON.parse(p.answers_json||'{}');if(!a[r.question]||a[r.question]===r.answer)updateLibrary(db,j.user_id,r.id,r.answer,true);}}}

// Only receipt-confirmed ordinary facts or explicitly approved answers can be learned.
// A user's explicit decision not to reuse is retained. Conflicts are never resolved by recency.
export function reusableAnswers(db,p){
 const answers=JSON.parse(p.answers_json||'{}'),groups=new Map();
 const group=q=>fieldKind(q)||normalize(q);
 for(const [q,a] of Object.entries(answers)){if(!canReuse(q))continue;const k=group(q);if(!groups.has(k))groups.set(k,[]);groups.get(k).push([q,String(a)]);}
 const rows=db.prepare('SELECT question,answer,reusable,confirmed,reuse_reviewed FROM answer_history WHERE user_id=? AND applicant_id=?').all(p.user_id,p.id).filter(r=>canReuse(r.question));
 for(const r of rows){
  if(!r.reusable&&!(r.confirmed&&!r.reuse_reviewed&&canReuse(r.question)&&!!fieldKind(r.question)))continue;
  const k=group(r.question);if(!groups.has(k))groups.set(k,[]);groups.get(k).push([r.question,r.answer]);
 }
 const result=Object.create(null);
 for(const r of rows){const entries=groups.get(group(r.question));if(entries)entries.push([r.question,r.answer]);}
 for(const entries of groups.values()){if(new Set(entries.map(([,a])=>normalize(a))).size!==1)continue;for(const [q,a]of entries)result[q]=a;}
 return result;
}
