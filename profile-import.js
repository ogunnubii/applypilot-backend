// Import a profile and application history from a file the applicant supplies
// (for example an export from another tool or an earlier ApplyPilot install).
// Only values present in the file are used; nothing is inferred. Existing saved
// answers are never overwritten by a different imported value; conflicts are
// reported. Every past application, including attempts whose outcome is
// unknown, blocks a repeat application; none is counted as confirmed here.
import {randomUUID} from 'node:crypto';
import {importHistory} from './application-history.js';

const PROFILE_FIELDS={name:150,email:254,phone:50,location:150,focus:300};
const clip=(value,max)=>String(value??'').replace(/[\u0000-\u001f]+/g,' ').trim().slice(0,max);
const HISTORY_STATUS={submitted:'applied',applied:'applied',confirmed:'applied',uncertain:'uncertain',attempted:'uncertain',unknown:'uncertain',pending:'uncertain',interview:'interview',screening:'screening',rejected:'rejected',offer:'offer'};

export function normalizeBundle(bundle){
 if(!bundle||typeof bundle!=='object'||Array.isArray(bundle))throw Error('The import file must be a JSON object with "profile" and/or "applications".');
 const profile=bundle.profile&&typeof bundle.profile==='object'?bundle.profile:null;
 const rows=Array.isArray(bundle.applications)?bundle.applications:Array.isArray(bundle.history)?bundle.history:[];
 if(!profile&&!rows.length)throw Error('Nothing to import: add "profile" or "applications".');
 if(rows.length>500)throw Error('Import at most 500 applications at a time.');
 const answers={};
 if(profile?.answers!==undefined){
  if(!profile.answers||typeof profile.answers!=='object'||Array.isArray(profile.answers))throw Error('profile.answers must be an object of question → answer.');
  for(const [question,answer] of Object.entries(profile.answers).slice(0,500)){const q=clip(question,300),a=clip(answer,4000);if(q&&a)answers[q]=a;}
 }
 const fields={};for(const [key,max] of Object.entries(PROFILE_FIELDS))if(profile&&profile[key]!==undefined&&clip(profile[key],max))fields[key]=clip(profile[key],max);
 const history=rows.map((r,i)=>{
  const status=HISTORY_STATUS[String(r?.status||'applied').toLowerCase()];
  if(!status)throw Error('Application '+(i+1)+' has an unknown status "'+clip(r?.status,40)+'". Use submitted, uncertain, interview, screening, rejected or offer.');
  if(r.urls!==undefined&&!Array.isArray(r.urls))throw Error('Application '+(i+1)+' has "urls" that is not a list.');
  return {company:clip(r.company,200),title:clip(r.title,300),status,url:r.url?clip(r.url,2000):undefined,urls:Array.isArray(r.urls)?r.urls.slice(0,20).map(u=>clip(u,2000)).filter(Boolean):undefined,source_status:clip(r.status||'applied',80),employer_hold:r.employer_hold===true,notes:clip([r.notes,r.appliedAt?'Applied '+clip(r.appliedAt,40):'',r.confirmation?'Recorded confirmation: '+clip(r.confirmation,300):''].filter(Boolean).join(' · '),2000),source:clip(r.source||'Imported application history',200),work_mode:r.work_mode,country:r.country};
 });
 return {fields,answers,history};
}

export function importBundle(db,userId,bundle,{applicantId=null}={}){
 const {fields,answers,history}=normalizeBundle(bundle);
 const result={applicant:null,created:false,updatedFields:[],answersAdded:0,answerConflicts:[],history:null};
 if(Object.keys(fields).length||Object.keys(answers).length){
  let p=applicantId?db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(applicantId,userId):null;
  if(applicantId&&!p)throw Error('Profile not found.');
  if(!p){const local=db.prepare("SELECT * FROM applicants WHERE user_id=? AND execution_mode='local' ORDER BY created_at").all(userId);if(local.length>1)throw Error('Choose which local profile to import into.');p=local[0]||null;}
  if(!p){
   // A new profile starts without consent: the applicant confirms consent in ApplyPilot.
   const id=randomUUID();
   db.prepare("INSERT INTO applicants(id,user_id,name,email,phone,location,focus,answers_json,consent,created_at) VALUES(?,?,?,?,?,?,?,?,0,?)").run(id,userId,fields.name||'',fields.email||'',fields.phone||'',fields.location||'',fields.focus||'',JSON.stringify(answers),new Date().toISOString());
   db.prepare("UPDATE applicants SET execution_mode='local' WHERE id=?").run(id);
   result.applicant=id;result.created=true;result.updatedFields=Object.keys(fields);result.answersAdded=Object.keys(answers).length;
  }else{
   result.applicant=p.id;
   for(const [key,value] of Object.entries(fields))if(!String(p[key]||'').trim()){db.prepare(`UPDATE applicants SET ${key}=? WHERE id=?`).run(value,p.id);result.updatedFields.push(key);}
   else if(String(p[key]).trim()!==value)result.answerConflicts.push({field:key,kept:String(p[key]).trim(),imported:value});
   let saved={};try{saved=JSON.parse(p.answers_json||'{}')||{};}catch{}
   for(const [question,answer] of Object.entries(answers)){
    if(saved[question]===undefined||saved[question]===''){saved[question]=answer;result.answersAdded++;}
    else if(String(saved[question])!==answer)result.answerConflicts.push({field:question,kept:String(saved[question]),imported:answer});
   }
   db.prepare('UPDATE applicants SET answers_json=? WHERE id=?').run(JSON.stringify(saved),p.id);
  }
 }
 if(history.length)result.history=importHistory(db,userId,history);
 return result;
}
