import {createHash,randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {companyKey} from './application-history.js';
import {applicationRoleKey} from './application-dedup.js';
import {employerQuotas} from './employer-limits.js';

export const HANDOFF_SOURCE='ogunnubii/applypilot-backend';
export const HANDOFF_ORIGIN='http://127.0.0.1:17780';
const MAX_AGE=300000;
const protectionCondition=r=>`(${r}.status!='saved' OR ${r}.attempts>0 OR ${r}.local_attempt_at IS NOT NULL OR ${r}.confirmation IS NOT NULL OR ${r}.local_phase IN ('verifying','uncertain','submitted') OR ${r}.challenge IN ('Unconfirmed submission','Submission in progress'))`;
const fail=code=>{throw Object.assign(Error(code),{code});};
function text(value,max=500){if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f]/.test(value))fail('invalid_identity');return value.trim();}
export function handoffURL(value){
 const raw=text(value,3000);let u;try{u=new URL(raw);}catch{fail('invalid_url');}
 if(u.protocol!=='https:'||u.username||u.password||u.port||isIP(u.hostname.replace(/^\[|\]$/g,''))||!u.hostname.includes('.')||/\s|\\/.test(raw)||/\.(?:local|localhost)$/.test(u.hostname))fail('invalid_url');
 if(u.hostname==='boards.greenhouse.io')u.hostname='job-boards.greenhouse.io';
 u.hash='';u.pathname=u.pathname.replace(/\/$/,'')||'/';
 for(const key of [...u.searchParams.keys()])if(/^utm_/i.test(key)||['gh_src','lever-source','lever-origin'].includes(key.toLowerCase()))u.searchParams.delete(key);
 for(const [key,value] of u.searchParams)if(/token|secret|password|session|auth|email|contact/i.test(key)||value.includes('@'))fail('private_url_parameter');
 u.searchParams.sort();return u.toString();
}
function atsIdentity(url){
 if(!url)return null;const u=new URL(url),p=u.pathname.split('/').filter(Boolean);
 if(u.hostname==='job-boards.greenhouse.io'&&p[1]==='jobs'&&/^\d+$/.test(p[2]||''))return {ats:'greenhouse',tenant:p[0].toLowerCase(),requisition_id:p[2]};
 if(['jobs.lever.co','jobs.eu.lever.co','jobs.ashbyhq.com'].includes(u.hostname)&&p[0]&&/^[a-f0-9-]{36}$/i.test(p[1]||''))return {ats:u.hostname.includes('lever')?'lever':'ashby',tenant:p[0].toLowerCase(),requisition_id:p[1].toLowerCase()};
 return null;
}
export function handoffIdentity(value,{candidate=false}={}){
 if(!value||typeof value!=='object'||Array.isArray(value))fail('invalid_identity');
 if(candidate&&Object.keys(value).some(k=>!['url','employer','title','location','ats','tenant','requisition_id','employer_aliases'].includes(k)))fail('invalid_identity');
 const employer=text(value.employer,200),title=text(value.title),location=text(value.location||'Unknown'),url=value.url===null&&!candidate?null:handoffURL(value.url);
 const ats=atsIdentity(url);if(candidate&&!ats)fail('unsupported_candidate_url');
 for(const key of ['ats','tenant','requisition_id'])if(value[key]!==undefined&&String(value[key]).toLowerCase()!==ats?.[key])fail('conflicting_identity');
 const employer_aliases=[...new Set([companyKey(employer),ats?.tenant].filter(Boolean))].sort();
 return {url,employer,title,location,...ats,employer_aliases};
}
function matches(a,b){
 if(a.url&&b.url&&a.url===b.url)return true;
 if(a.ats&&a.ats===b.ats&&a.tenant===b.tenant&&a.requisition_id===b.requisition_id)return true;
 const names=x=>[x.employer,...(x.employer_aliases||[])].map(companyKey).filter(Boolean);
 return !!applicationRoleKey(a.title)&&applicationRoleKey(a.title)===applicationRoleKey(b.title)&&names(a).some(n=>names(b).includes(n));
}
export function registerPreparationHandoffFunctions(db){
 db.function('preparation_identity_key',{deterministic:true},(company,title,url)=>createHash('sha256').update(JSON.stringify([company,title,url])).digest('hex'));
 db.function('preparation_identity_match',{deterministic:true},(json,company,title,url)=>{
  try{return Number(matches(JSON.parse(json),handoffIdentity({employer:company,title,url,location:'Unknown'})));}catch{return 1;}
 });
}
export function installPreparationHandoff(db){
 registerPreparationHandoffFunctions(db);
 db.exec(`CREATE TABLE IF NOT EXISTS preparation_handoff_protections(
  user_id TEXT NOT NULL,job_id TEXT NOT NULL,company TEXT NOT NULL,title TEXT NOT NULL,url TEXT NOT NULL,
  protection TEXT NOT NULL,PRIMARY KEY(user_id,job_id));
 CREATE TABLE IF NOT EXISTS preparation_handoff_snapshots(
  user_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,generated_at TEXT NOT NULL,protection_digest TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS preparation_handoff_reservations(
  user_id TEXT NOT NULL,request_id TEXT NOT NULL,reservation_id TEXT NOT NULL UNIQUE,
  identity_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,request_id));`);
 const protectedRow=protectionCondition;
 const protection=r=>`CASE WHEN ${r}.status IN ('archived','duplicate','excluded') THEN 'excluded' WHEN ${r}.attempts>0 OR ${r}.local_attempt_at IS NOT NULL OR ${r}.confirmation IS NOT NULL OR ${r}.status IN ('submitted','interview','rejected','offer') OR ${r}.local_phase IN ('verifying','uncertain','submitted') OR ${r}.challenge IN ('Unconfirmed submission','Submission in progress') THEN 'uncertain' ELSE 'reserved' END`;
 const retain=r=>`INSERT INTO preparation_handoff_protections(user_id,job_id,company,title,url,protection) VALUES(${r}.user_id,${r}.id,${r}.company,${r}.title,${r}.url,${protection(r)}) ON CONFLICT(user_id,job_id) DO UPDATE SET protection=CASE WHEN excluded.protection='excluded' OR preparation_handoff_protections.protection='excluded' THEN 'excluded' WHEN excluded.protection='uncertain' OR preparation_handoff_protections.protection='uncertain' THEN 'uncertain' ELSE 'reserved' END;`;
 const claimed=r=>`(${r}.status IN ('queued','running','local_browser') OR ${r}.attempts>0 OR ${r}.local_attempt_at IS NOT NULL)`;
 const external=`EXISTS(SELECT 1 FROM preparation_handoff_reservations r WHERE r.user_id=NEW.user_id AND preparation_identity_match(r.identity_json,NEW.company,NEW.title,NEW.url))`;
 db.exec(`CREATE TRIGGER IF NOT EXISTS preparation_handoff_insert_fence BEFORE INSERT ON jobs WHEN ${claimed('NEW')} AND ${external} BEGIN SELECT RAISE(ABORT,'Application reserved by ApplyPilot 2'); END;
 CREATE TRIGGER IF NOT EXISTS preparation_handoff_update_fence BEFORE UPDATE OF status,attempts,local_attempt_at,url,company,title ON jobs WHEN ${claimed('NEW')} AND ${external} BEGIN SELECT RAISE(ABORT,'Application reserved by ApplyPilot 2'); END;
 CREATE TRIGGER IF NOT EXISTS preparation_handoff_retain_insert AFTER INSERT ON jobs WHEN ${protectedRow('NEW')} BEGIN ${retain('NEW')} END;
 CREATE TRIGGER IF NOT EXISTS preparation_handoff_retain_update AFTER UPDATE OF status,attempts,local_attempt_at,confirmation,local_phase,challenge ON jobs WHEN ${protectedRow('NEW')} BEGIN ${retain('NEW')} END;
 CREATE TRIGGER IF NOT EXISTS preparation_handoff_retain_delete BEFORE DELETE ON jobs WHEN ${protectedRow('OLD')} BEGIN ${retain('OLD')} END;
 CREATE TRIGGER IF NOT EXISTS preparation_handoff_retain_identity AFTER UPDATE OF company,title,url ON jobs WHEN ${protectedRow('NEW')} AND (OLD.company!=NEW.company OR OLD.title!=NEW.title OR OLD.url!=NEW.url) BEGIN
  INSERT OR IGNORE INTO preparation_handoff_protections VALUES(NEW.user_id,NEW.id||':'||preparation_identity_key(NEW.company,NEW.title,NEW.url),NEW.company,NEW.title,NEW.url,${protection('NEW')}); END;
 CREATE TRIGGER IF NOT EXISTS preparation_handoff_retain_event AFTER INSERT ON events WHEN NEW.type IN ('submission_started','manual_submission','automatic_submission','applicant_reported_submission','submitted','manual_confirmation') BEGIN
  INSERT INTO preparation_handoff_protections SELECT user_id,id,company,title,url,'uncertain' FROM jobs WHERE id=NEW.job_id ON CONFLICT(user_id,job_id) DO UPDATE SET protection=CASE WHEN protection='excluded' THEN 'excluded' ELSE 'uncertain' END; END;
 INSERT OR IGNORE INTO preparation_handoff_protections(user_id,job_id,company,title,url,protection) SELECT user_id,id,company,title,url,${protection('jobs')} FROM jobs WHERE ${protectedRow('jobs')};`);
 if(hasTable(db,'autonomous_attempts'))db.exec(`CREATE TRIGGER IF NOT EXISTS preparation_handoff_autonomous_fence BEFORE INSERT ON autonomous_attempts WHEN EXISTS(SELECT 1 FROM jobs j JOIN preparation_handoff_reservations r ON r.user_id=j.user_id WHERE j.id=NEW.job_id AND preparation_identity_match(r.identity_json,j.company,j.title,j.url)) BEGIN SELECT RAISE(ABORT,'Application reserved by ApplyPilot 2'); END;
 CREATE TRIGGER IF NOT EXISTS preparation_handoff_retain_attempt AFTER INSERT ON autonomous_attempts BEGIN INSERT OR IGNORE INTO preparation_handoff_protections SELECT user_id,id,company,title,url,'uncertain' FROM jobs WHERE id=NEW.job_id; END;
 INSERT OR IGNORE INTO preparation_handoff_protections SELECT user_id,id,company,title,url,'uncertain' FROM jobs WHERE EXISTS(SELECT 1 FROM autonomous_attempts a WHERE a.job_id=jobs.id);`);
 db.exec("INSERT OR IGNORE INTO preparation_handoff_protections SELECT user_id,id,company,title,url,'uncertain' FROM jobs WHERE EXISTS(SELECT 1 FROM events e WHERE e.job_id=jobs.id AND e.type IN ('submission_started','manual_submission','automatic_submission','applicant_reported_submission','submitted','manual_confirmation'))");
}
function hasTable(db,name){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
export function externalPreparationProblem(db,job){
 if(!hasTable(db,'preparation_handoff_reservations'))return '';
 const uid=job.user_id||(job.applicant_id&&hasTable(db,'applicants')?db.prepare('SELECT user_id FROM applicants WHERE id=?').get(job.applicant_id)?.user_id:null);
 if(!uid)return 'Application account could not be verified for the shared protection check.';
 return db.prepare('SELECT 1 FROM preparation_handoff_reservations WHERE user_id=? AND preparation_identity_match(identity_json,?,?,?) LIMIT 1').get(uid,job.company||'',job.title||'',job.url||'')?'Application reserved by ApplyPilot 2. Protected from duplicate preparation.':'';
}
function projection(db,uid,at){
 const records=[];
 const add=(record_id,status,value)=>records.push({record_id,status,identity:handoffIdentity(value)});
 for(const row of db.prepare('SELECT * FROM preparation_handoff_protections WHERE user_id=? ORDER BY job_id').all(uid))add('job:'+row.job_id,row.protection,{employer:row.company,title:row.title,url:row.url,location:'Unknown'});
 // Preserve the first identity as well as a later edited identity. Neither
 // changing display fields nor deleting a row may erase a duplicate barrier.
 const attemptEvidence=hasTable(db,'autonomous_attempts')?' OR EXISTS(SELECT 1 FROM autonomous_attempts a WHERE a.job_id=jobs.id)':'';
 for(const row of db.prepare(`SELECT id,company,title,url FROM jobs WHERE user_id=? AND (${protectionCondition('jobs')}${attemptEvidence} OR EXISTS(SELECT 1 FROM events e WHERE e.job_id=jobs.id AND e.type IN ('submission_started','manual_submission','automatic_submission','applicant_reported_submission','submitted','manual_confirmation'))) ORDER BY id`).all(uid)){
  const identity=handoffIdentity({employer:row.company,title:row.title,url:row.url,location:'Unknown'}),old=records.find(r=>r.record_id==='job:'+row.id);
  if(!old||JSON.stringify(old.identity)!==JSON.stringify(identity))records.push({record_id:'current:'+row.id,status:'uncertain',identity});
 }
 // Old deleted attempts predate the journal. Their requisition URL remains authoritative.
 for(const row of db.prepare('SELECT * FROM company_application_activity WHERE user_id=? AND job_id NOT IN (SELECT job_id FROM preparation_handoff_protections WHERE user_id=?) ORDER BY job_id').all(uid,uid))add('activity:'+row.job_id,row.started_at?'uncertain':'reserved',{employer:row.company,title:'Unknown historical role',url:row.normalized_url,location:'Unknown'});
 for(const row of db.prepare('SELECT id,company,title FROM external_application_history WHERE user_id=? ORDER BY id').all(uid))add('history:'+row.id,'uncertain',{employer:row.company,title:row.title,url:null,location:'Unknown'});
 for(const row of db.prepare('SELECT reservation_id,identity_json FROM preparation_handoff_reservations WHERE user_id=? ORDER BY reservation_id').all(uid))records.push({record_id:'reservation:'+row.reservation_id,status:'reserved',identity:JSON.parse(row.identity_json)});
 const holds=employerQuotas(db,uid,at).filter(row=>row.hold_until===null||row.hold_until>at).map(row=>({employer:text(row.company,200),reason_code:row.kind==='security'?'excluded':'application_limit',aliases:[...new Set([companyKey(row.company),row.employer_key.split(':').slice(1).join(':')].filter(Boolean))].sort()}));
 const employer_holds=[...new Map(holds.map(row=>[JSON.stringify(row),row])).values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 const data={records,employer_holds};
 if(records.length>20000||employer_holds.length>20000||Buffer.byteLength(JSON.stringify(data))>10*1024*1024-1024)fail('incomplete_projection');
 return data;
}
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function transaction(db,work){db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
export function exportPreparationLedger(db,uid,{at=new Date().toISOString()}={}){
 return transaction(db,()=>{
  const data=projection(db,uid,at),previous=db.prepare('SELECT revision FROM preparation_handoff_snapshots WHERE user_id=?').get(uid),revision=(previous?.revision||0)+1;
  db.prepare('INSERT INTO preparation_handoff_snapshots VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,generated_at=excluded.generated_at,protection_digest=excluded.protection_digest').run(uid,revision,at,digest(data));
  return {schema_version:2,source_project:HANDOFF_SOURCE,revision,generated_at:at,complete:true,...data};
 });
}
function validateRequest(input){
 if(!input||Object.keys(input).some(k=>!['schema_version','request_id','expected_revision','identity'].includes(k))||input.schema_version!==2||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1||typeof input.request_id!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(input.request_id))fail('invalid_request');
 return handoffIdentity(input.identity,{candidate:true});
}
export function reservePreparation(db,uid,input,{at=new Date().toISOString()}={}){
 const identity=validateRequest(input);
 return transaction(db,()=>{
  const previous=db.prepare('SELECT * FROM preparation_handoff_reservations WHERE user_id=? AND request_id=?').get(uid,input.request_id);
  if(previous&&previous.identity_json!==JSON.stringify(identity))fail('request_identity_conflict');
  const snapshot=db.prepare('SELECT * FROM preparation_handoff_snapshots WHERE user_id=?').get(uid);
  const age=Date.parse(at)-Date.parse(snapshot?.generated_at);
  if(!snapshot||!Number.isFinite(age)||age<0||age>MAX_AGE)fail('fresh_snapshot_required');
  const data=projection(db,uid,at);
  if(input.expected_revision!==snapshot.revision||digest(data)!==snapshot.protection_digest)fail('snapshot_changed');
  const record=data.records.find(row=>row.record_id!=='reservation:'+previous?.reservation_id&&matches(row.identity,identity));
  const names=[identity.employer,...identity.employer_aliases].map(companyKey);
  const hold=data.employer_holds.find(row=>[row.employer,...row.aliases].map(companyKey).some(n=>names.includes(n)));
  const base={schema_version:2,source_project:HANDOFF_SOURCE,request_id:input.request_id,identity,revision:snapshot.revision,checked_at:at,submission_allowed:false};
  if(record||hold)return {...base,decision:'blocked',reason_code:hold?'employer_hold':'protected_application',reservation_id:previous?.reservation_id||null};
  const reservation_id=previous?.reservation_id||randomUUID();
  if(!previous)db.prepare('INSERT INTO preparation_handoff_reservations VALUES(?,?,?,?,?)').run(uid,input.request_id,reservation_id,JSON.stringify(identity),at);
  return {...base,decision:previous?'rechecked':'reserved',reservation_id};
 });
}
