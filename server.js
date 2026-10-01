import {installContinuations,requestContinuation,listContinuations,claimContinuation,settleContinuation,cancelContinuation} from './continuation-queue.js';
import {operationSnapshot} from './operation-evidence.js';
import {extensionArchive} from './extension-package.js';
import {importHistory} from './application-history.js';
import {installArchive,archiveApplications,restoreApplication} from './application-archive.js';
import {installLibrary,captureAnswers,updateLibrary,deleteLibrary,confirmLibrary,canReuse,reusableAnswers} from './answer-library.js';
import {installDrafts,draftForJob} from './answer-drafts.js';
import {hasResearchDraftForQuestion,installResearch,isResearchDraft,markResearchDraftUsed,researchForJob} from './google-research.js';
import {researchConsentWithdrawn} from './research-consent.js';
import {deleteApplication} from './delete-application.js';
import {supported,sameApplication,receipt as employerReceipt,sensitive} from './local-policy.js';
import {rememberAnswers} from './local-state.js';
import {installNotifications,emailConfigured,sendBlockerEmails} from './notifications.js';
import {chat} from './assistant.js';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';import {randomUUID} from 'node:crypto';import {mkdir,writeFile,unlink} from 'node:fs/promises';import {join,resolve,extname} from 'node:path';import {db,event,now,normalizeURL} from './db.js';import {hashPassword,verifyPassword,issueToken,readToken} from './auth.js';
import {parseBoards,parseIntent,profileSearchInstruction,runSearch} from './discovery.js';
import {resumeRoles,resumeText} from './resume.js';
installNotifications(db);installLibrary(db);installDrafts(db);installResearch(db);db.exec('CREATE TABLE IF NOT EXISTS work_focus(user_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,job_id TEXT)');
installArchive(db);installContinuations(db);
let emailBusy=false;
const emailTimer=setInterval(async()=>{if(emailBusy)return;emailBusy=true;try{await sendBlockerEmails(db)}catch{console.error('Blocker notification delivery failed')}finally{emailBusy=false}},60000);emailTimer.unref();
const origin=process.env.PUBLIC_ORIGIN;if(!origin)throw Error('Set PUBLIC_ORIGIN');if(!process.env.REGISTRATION_CODE||process.env.REGISTRATION_CODE.length<24)throw Error('Set REGISTRATION_CODE to a random value of at least 24 characters');const attempts=new Map();const uploadDir=resolve(process.env.UPLOAD_DIR||'./data/resumes');const limit=6*1024*1024;
const send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))};
async function body(req,max=100000){let chunks=[],size=0;for await(let chunk of req){size+=chunk.length;if(size>max)throw Error('Request too large');chunks.push(chunk)}return Buffer.concat(chunks)}
const text=(v,max=500)=>String(v??'').trim().slice(0,max);
const ownJob=(uid,id)=>db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(id,uid);
function createResumeSearch(uid,applicant,roles){
  const instruction=profileSearchInstruction(applicant,roles);
  const existing=db.prepare('SELECT id FROM searches WHERE user_id=? AND applicant_id=? AND auto_generated=1').get(uid,applicant.id);
  const id=existing?.id||randomUUID();
  if(existing)db.prepare("UPDATE searches SET instruction=?,enabled=1,last_run=NULL,last_error=NULL WHERE id=?").run(instruction,id);
  else db.prepare('INSERT INTO searches(id,user_id,applicant_id,instruction,boards_json,auto_queue,auto_generated,created_at) VALUES(?,?,?,?,?,0,1,?)').run(id,uid,applicant.id,instruction,'[]',now());
  setImmediate(()=>runSearch(id,uid).catch(e=>console.error('Resume search:',e.message)));
  return instruction;
}
const allowedOrigins=new Set([origin,process.env.SERVICE_ORIGIN,'https://applypilot-jobs.pages.dev'].filter(Boolean));
createServer(async(req,res)=>{const requestOrigin=req.headers.origin;if(requestOrigin&&!allowedOrigins.has(requestOrigin))return send(res,403,{error:'Origin not allowed'});res.setHeader('access-control-allow-origin',requestOrigin||origin);res.setHeader('vary','Origin');res.setHeader('access-control-allow-headers','authorization,content-type,x-applypilot-device');res.setHeader('access-control-allow-methods','GET,POST,PUT,DELETE,OPTIONS');if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}
try{let path=new URL(req.url,'http://localhost').pathname;if(req.method==='GET'&&['/','/assistant','/assistant.js'].includes(path)){res.writeHead(200,{'content-type':path.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});res.end(await readFile(new URL(path.endsWith('.js')?'./assistant-client.js':'./assistant-page.html',import.meta.url)));return;}
if(req.method==='GET'&&path==='/form-policy.js'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(await readFile(new URL('./extension/policy.js',import.meta.url)));return;}
if(req.method==='GET'&&['/setup','/setup.js'].includes(path)){
 res.writeHead(200,{'content-type':path.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});res.end(await readFile(new URL(path.endsWith('.js')?'./web/setup.js':'./web/setup.html',import.meta.url)));return;
}
if(req.method==='GET'&&path==='/applypilot-local.zip'){const archive=await extensionArchive();res.writeHead(200,{'content-type':'application/zip','content-disposition':'attachment; filename="applypilot-local-0.6.2.zip"','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(archive);return;}
if(req.method==='GET'&&path==='/local-browser.html'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(await readFile(new URL('./web/local-browser.html',import.meta.url)));return;}
if(path==='/api/health')return send(res,200,{ok:true,release:'2026-10-01-resume-preview',extensionVersion:'0.6.2',aiConfigured:!!(process.env.OPENAI_API_KEY&&process.env.OPENAI_MODEL),googleResearchConfigured:!!process.env.GEMINI_API_KEY});
if(path==='/api/register'&&req.method==='POST'){let input=JSON.parse(await body(req));if(input.registration_code!==process.env.REGISTRATION_CODE)return send(res,403,{error:'Registration code required'});let email=text(input.email,254).toLowerCase();if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return send(res,400,{error:'Valid email required'});let id=randomUUID(),hash=hashPassword(input.password);try{db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id,email,hash,now())}catch{return send(res,409,{error:'Account already exists'})}return send(res,201,{token:issueToken(id,input.remember===true)})}
if(path==='/api/login'&&req.method==='POST'){let address=req.socket.remoteAddress||'unknown',rate=attempts.get(address)||{count:0,at:Date.now()};if(Date.now()-rate.at>600000)rate={count:0,at:Date.now()};if(rate.count>=10)return send(res,429,{error:'Too many sign-in attempts. Try later.'});rate.count++;attempts.set(address,rate);let input=JSON.parse(await body(req)),u=db.prepare('SELECT * FROM users WHERE email=?').get(text(input.email,254).toLowerCase());if(!u||!verifyPassword(input.password,u.password_hash))return send(res,401,{error:'Invalid credentials'});attempts.delete(address);return send(res,200,{token:issueToken(u.id,input.remember===true)})}
let uid=readToken(req.headers.authorization?.replace(/^Bearer /i,''));if(!uid)return send(res,401,{error:'Sign in required'});

if(path==='/api/application-history'&&req.method==='GET')return send(res,200,{records:db.prepare('SELECT id,company,title,status,source,notes,imported_at,work_mode,country,interview_at,interview_stage FROM external_application_history WHERE user_id=? ORDER BY company,title').all(uid)});
if(path==='/api/application-history'&&req.method==='POST'){try{const x=JSON.parse(await body(req,1500000));return send(res,200,importHistory(db,uid,x.rows));}catch(e){return send(res,400,{error:e.message});}}
if(path==='/api/application-archive'&&req.method==='GET')return send(res,200,{jobs:db.prepare("SELECT j.id,j.title,j.company,j.url,a.archived_at FROM jobs j JOIN application_archive a ON a.job_id=j.id WHERE j.user_id=? AND j.status='archived' ORDER BY a.archived_at DESC").all(uid)});
if(path==='/api/application-archive'&&req.method==='POST'){try{const x=JSON.parse(await body(req));return send(res,200,archiveApplications(db,uid,x.ids));}catch(e){return send(res,400,{error:e.message});}}
const restoreArchiveRoute=path.match(/^\/api\/application-archive\/([a-f0-9-]+)\/restore$/);
if(restoreArchiveRoute&&req.method==='POST'){try{return send(res,200,restoreApplication(db,uid,restoreArchiveRoute[1]));}catch(e){return send(res,409,{error:e.message});}}

const deleteRoute=path.match(/^\/api\/jobs\/([a-f0-9-]+)$/);
if(deleteRoute&&req.method==='DELETE'){const x=JSON.parse(await body(req));if(x.confirm!==deleteRoute[1])return send(res,400,{error:'Confirm permanent deletion of this application'});try{return send(res,200,deleteApplication(db,uid,deleteRoute[1]));}catch(e){return send(res,409,{error:e.message});}}
if(path==='/api/notifications'&&['GET','PUT'].includes(req.method)){
 if(req.method==='PUT'){const x=JSON.parse(await body(req));if(typeof x.enabled!=='boolean')return send(res,400,{error:'Choose whether to enable blocker emails'});db.prepare('INSERT INTO notification_preferences(user_id,enabled) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled').run(uid,x.enabled?1:0);}
 const enabled=!!db.prepare('SELECT enabled FROM notification_preferences WHERE user_id=?').get(uid)?.enabled;
 return send(res,200,{enabled,configured:emailConfigured(),failed:db.prepare("SELECT COUNT(*) AS n FROM blocker_emails b JOIN jobs j ON j.id=b.job_id WHERE j.user_id=? AND b.last_error IS NOT NULL").get(uid).n});
}
const draftRoute=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/draft-answer$/);
if(draftRoute&&req.method==='POST'){try{const x=JSON.parse(await body(req));return send(res,200,await draftForJob(db,uid,draftRoute[1],x.question));}catch(e){return send(res,400,{error:e.message});}}
const researchRoute=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/research-answer$/);
if(researchRoute&&req.method==='POST'){try{const x=JSON.parse(await body(req));return send(res,200,await researchForJob(db,uid,researchRoute[1],x.question));}catch(e){return send(res,400,{error:e.message});}}
if(path==='/api/answer-library'&&req.method==='GET')return send(res,200,{answers:db.prepare('SELECT a.*,j.company,j.title FROM answer_history a JOIN jobs j ON j.id=a.job_id WHERE a.user_id=? ORDER BY a.updated_at DESC LIMIT 500').all(uid).map(a=>({...a,canReuse:canReuse(a.question)}))});
const libraryRoute=path.match(/^\/api\/answer-library\/([a-f0-9-]+)$/);
if(libraryRoute&&['PUT','DELETE'].includes(req.method)){try{if(req.method==='DELETE')deleteLibrary(db,uid,libraryRoute[1]);else{const x=JSON.parse(await body(req));updateLibrary(db,uid,libraryRoute[1],x.answer,x.reuse===true);}return send(res,200,{ok:true});}catch(e){return send(res,400,{error:e.message});}}
if(path==='/api/work-focus'&&['GET','PUT'].includes(req.method)){
 if(req.method==='PUT'){const x=JSON.parse(await body(req));if(x.enabled===false)db.prepare('DELETE FROM work_focus WHERE user_id=?').run(uid);else{
  const current=db.prepare('SELECT job_id FROM work_focus WHERE user_id=?').get(uid);const old=current?.job_id?ownJob(uid,current.job_id):null;
  if(old&&!['submitted','interview','rejected','offer'].includes(old.status)&&x.next===true)return send(res,409,{error:'Complete the current application before opening the next one'});
  const next=db.prepare("SELECT id FROM jobs WHERE user_id=? AND status IN ('saved','queued','paused','needs_review','local_browser') AND local_attempt_at IS NULL AND COALESCE(challenge,'') NOT IN ('Unconfirmed submission','Submission in progress') ORDER BY discovery_priority,CASE WHEN lower(title) LIKE '%support%' THEN 0 ELSE 1 END,created_at LIMIT 1").get(uid);
  db.prepare('INSERT INTO work_focus(user_id,enabled,job_id) VALUES(?,1,?) ON CONFLICT(user_id) DO UPDATE SET enabled=1,job_id=excluded.job_id').run(uid,next?.id||null);
 }}const f=db.prepare('SELECT * FROM work_focus WHERE user_id=?').get(uid);return send(res,200,{enabled:!!f?.enabled,job_id:f?.job_id||null,parked:db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND status NOT IN ('duplicate','archived','submitted','interview','rejected','offer') AND id!=COALESCE(?,'')").get(uid,f?.job_id||null).n});
}
if(path==='/api/chat'&&req.method==='POST')return send(res,200,await chat(uid,JSON.parse(await body(req))));
if(path==='/api/status'&&req.method==='GET'){const heartbeat=db.prepare('SELECT heartbeat FROM worker_status WHERE id=1').get()?.heartbeat;return send(res,200,{workerOnline:!!heartbeat&&Date.now()-Date.parse(heartbeat)<45000,heartbeat:heartbeat||null,queue:db.prepare("SELECT status,COUNT(*) AS count FROM jobs WHERE user_id=? AND status NOT IN ('duplicate','archived') GROUP BY status").all(uid)});}
const continuationCheck=job=>researchConsentWithdrawn(db,job.id,job.applicant_id)?'Drafting consent changed. Review saved answers before continuing.':'';
if(path==='/api/continuations'&&req.method==='GET')return send(res,200,{requests:listContinuations(db,uid)});
if(path==='/api/continuations/claim'&&req.method==='POST')return send(res,200,{request:claimContinuation(db,uid,continuationCheck)});
const continuationRoute=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/continuation$/);
if(continuationRoute){
 if(req.method==='POST')return send(res,200,requestContinuation(db,uid,continuationRoute[1],continuationCheck));
 if(req.method==='DELETE')return send(res,200,cancelContinuation(db,uid,continuationRoute[1]));
 if(req.method==='PUT'){const x=JSON.parse(await body(req));return send(res,200,settleContinuation(db,uid,continuationRoute[1],x.claimId,x.result));}
}

if(path==='/api/operations'&&req.method==='GET')return send(res,200,operationSnapshot(db,uid));
if(path==='/api/activity'&&req.method==='GET')return send(res,200,{events:db.prepare('SELECT e.at,e.type,e.message,j.id AS job_id,j.title,j.company,j.applicant_id FROM events e JOIN jobs j ON j.id=e.job_id WHERE j.user_id=? AND j.status NOT IN (\'archived\',\'duplicate\') ORDER BY e.id DESC LIMIT 100').all(uid)});
if(path==='/api/me')return send(res,200,{email:db.prepare('SELECT email FROM users WHERE id=?').get(uid)?.email});
if(path==='/api/searches'&&req.method==='GET')return send(res,200,{intervalHours:Math.max(1,Math.min(24,Number(process.env.SEARCH_INTERVAL_HOURS)||1)),searches:db.prepare('SELECT * FROM searches WHERE user_id=? ORDER BY created_at DESC').all(uid).map(s=>({...s,boards:JSON.parse(s.boards_json),boards_json:undefined,last_result:s.last_result_json?JSON.parse(s.last_result_json):null,last_result_json:undefined}))});
if(path==='/api/searches'&&req.method==='POST'){
  const x=JSON.parse(await body(req)),p=db.prepare('SELECT id FROM applicants WHERE id=? AND user_id=?').get(x.applicant_id,uid);
  if(!p)return send(res,400,{error:'Select your applicant profile'});
  const instruction=text(x.instruction,5000),boards=parseBoards(x.boards);parseIntent(instruction);
  const id=randomUUID();db.prepare('INSERT INTO searches(id,user_id,applicant_id,instruction,boards_json,auto_queue,created_at) VALUES(?,?,?,?,?,?,?)').run(id,uid,p.id,instruction,JSON.stringify(boards),x.auto_queue===true?1:0,now());
  return send(res,201,{id});
}
let searchRoute=path.match(/^\/api\/searches\/([a-f0-9-]+)\/(run|toggle)$/);
if(searchRoute&&req.method==='POST'){
  const s=db.prepare('SELECT * FROM searches WHERE id=? AND user_id=?').get(searchRoute[1],uid);if(!s)return send(res,404,{error:'Search not found'});
  if(searchRoute[2]==='toggle'){db.prepare('UPDATE searches SET enabled=? WHERE id=?').run(s.enabled?0:1,s.id);return send(res,200,{enabled:!s.enabled})}
  return send(res,200,await runSearch(s.id,uid));
}
if(path==='/api/applicants'&&req.method==='GET')return send(res,200,{applicants:db.prepare('SELECT id,user_id,name,email,phone,location,focus,execution_mode,answers_json,consent,ai_consent,google_research_consent,resume_path IS NOT NULL AS has_resume FROM applicants WHERE user_id=?').all(uid).map(p=>({...p,answers:JSON.parse(p.answers_json),reusableAnswers:{...reusableAnswers(db,p)},answers_json:undefined,user_id:undefined,resume_path:undefined}))});
if(path==='/api/applicants'&&req.method==='POST'){let x=JSON.parse(await body(req)),id=randomUUID();db.prepare('INSERT INTO applicants(id,user_id,name,email,phone,location,focus,answers_json,consent,ai_consent,google_research_consent,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,uid,text(x.name,150),text(x.email,254),text(x.phone,50),text(x.location,150),text(x.focus,300),JSON.stringify(x.answers||{}),x.consent===true?1:0,x.ai_consent===true?1:0,x.google_research_consent===true?1:0,now());db.prepare('UPDATE applicants SET execution_mode=? WHERE id=?').run(x.execution_mode==='local'?'local':'cloud',id);return send(res,201,{id})}
let m=path.match(/^\/api\/applicants\/([a-f0-9-]+)$/);if(m&&req.method==='PUT'){let x=JSON.parse(await body(req)),p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(m[1],uid);if(!p)return send(res,404,{error:'Applicant not found'});db.prepare('UPDATE applicants SET name=?,email=?,phone=?,location=?,focus=?,answers_json=?,consent=?,ai_consent=?,google_research_consent=? WHERE id=?').run(text(x.name,150),text(x.email,254),text(x.phone,50),text(x.location,150),text(x.focus,300),JSON.stringify(x.answers||{}),x.consent===true?1:0,x.ai_consent===true?1:0,x.google_research_consent===true?1:0,p.id);if(['local','cloud'].includes(x.execution_mode))db.prepare('UPDATE applicants SET execution_mode=? WHERE id=?').run(x.execution_mode,p.id);return send(res,200,{ok:true})}
m=path.match(/^\/api\/applicants\/([a-f0-9-]+)\/resume$/);
if(m&&req.method==='GET'){
 const p=db.prepare('SELECT name,resume_path FROM applicants WHERE id=? AND user_id=?').get(m[1],uid);
 if(!p)return send(res,404,{error:'Applicant not found'});
 if(!p.resume_path)return send(res,404,{error:'No resume has been uploaded for this profile'});
 const bytes=await readFile(p.resume_path),ext=extname(p.resume_path).toLowerCase();if(bytes.length>limit)throw Error('Resume too large');
 let extracted='',previewNotice='';try{extracted=(await resumeText(p.resume_path,ext)).slice(0,100000);}catch{previewNotice='Text preview is unavailable. Download the original file to inspect it.';}
 return send(res,200,{name:'resume'+ext,applicant:p.name,mime:ext==='.pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:bytes.length,base64:bytes.toString('base64'),text:extracted,previewNotice});
}
if(m&&req.method==='POST'){let p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(m[1],uid);if(!p)return send(res,404,{error:'Applicant not found'});let kind=req.headers['content-type'],ext=kind==='application/pdf'?'.pdf':kind==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'?'.docx':null;if(!ext)return send(res,415,{error:'Use PDF or DOCX'});let bytes=await body(req,limit);if(bytes.length<100)return send(res,400,{error:'Resume appears empty'});if(ext==='.pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))return send(res,400,{error:'Invalid PDF'});if(ext==='.docx'&&!bytes.subarray(0,2).equals(Buffer.from('PK')))return send(res,400,{error:'Invalid DOCX'});await mkdir(uploadDir,{recursive:true,mode:0o700});let file=join(uploadDir,randomUUID()+ext);await writeFile(file,bytes,{mode:0o600});db.prepare('UPDATE applicants SET resume_path=? WHERE id=?').run(file,p.id);if(p.resume_path)await unlink(p.resume_path).catch(()=>{});let roles=[],instruction='',resumeNotice='';try{roles=await resumeRoles(file,ext);if(roles.length)instruction=createResumeSearch(uid,p,roles);else resumeNotice='No clear role titles found in the resume. Add a search manually.'}catch(e){console.error('Resume parsing:',e.message);resumeNotice='Resume saved, but its text could not be read. Add a search manually.'}return send(res,200,{ok:true,roles,instruction,resumeNotice})}
if(path==='/api/jobs'&&req.method==='GET')return send(res,200,{jobs:db.prepare(`SELECT id,applicant_id,title,company,url,status,notes,confirmation,challenge,created_at,updated_at,required_fields_json,answers_json,handoff_available,local_phase,local_attempt_at,(SELECT execution_mode FROM applicants WHERE id=jobs.applicant_id) AS execution_mode,(SELECT message FROM events WHERE job_id=jobs.id AND type IN ('paused','needs_review') ORDER BY id DESC LIMIT 1) AS blocker_message,(SELECT message FROM events WHERE job_id=jobs.id ORDER BY id DESC LIMIT 1) AS last_message FROM jobs WHERE user_id=? AND status NOT IN ('duplicate','archived') AND (NOT EXISTS(SELECT 1 FROM work_focus f WHERE f.user_id=jobs.user_id AND f.enabled=1) OR id=(SELECT job_id FROM work_focus f WHERE f.user_id=jobs.user_id) OR status IN ('submitted','interview','rejected','offer')) ORDER BY discovery_priority,created_at DESC`).all(uid).map(job=>{let questions=[];try{questions=JSON.parse(job.required_fields_json||'[]')}catch{}return {...job,application_only_questions:[...new Set(questions.filter(question=>typeof question==='string'&&!canReuse(question)))]};})});
if(path==='/api/jobs'&&req.method==='POST'){let x=JSON.parse(await body(req)),p=db.prepare('SELECT id FROM applicants WHERE id=? AND user_id=?').get(x.applicant_id,uid);if(!p)return send(res,400,{error:'Select your applicant profile'});let url=normalizeURL(x.url),id=randomUUID(),date=now();if(!supported(url))return send(res,400,{error:'Use a supported direct employer application link. Aggregator listings are not accepted.'});try{db.prepare('INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,uid,p.id,text(x.title,200),text(x.company,200),url,url,text(x.notes,2000),date,date)}catch{return send(res,409,{error:'Job already tracked for this applicant'})}event(id,'saved','Job added');return send(res,201,{id})}
// Local browser mode owns the application until a receipt is recorded.
let localRoute=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/local\/(claim|packet|progress|research-answer|research-used|step|attempt|submitted|capture)$/);
if(localRoute){
 const j=ownJob(uid,localRoute[1]);if(!j)return send(res,404,{error:'Job not found'});
 const focus=db.prepare('SELECT job_id FROM work_focus WHERE user_id=? AND enabled=1').get(uid);if(focus&&focus.job_id!==j.id&&['claim','packet'].includes(localRoute[2]))return send(res,409,{error:'This application is parked while you work on one job at a time.'});
 const action=localRoute[2],owner=req.headers['x-applypilot-device'];
 if(typeof owner!=='string'||!/^[a-f0-9-]{36}$/.test(owner))return send(res,400,{error:'Update the extension and reconnect this browser'});
 if(action==='claim'&&req.method==='POST'){
  if(j.status==='local_browser'){
   if(j.local_owner&&j.local_owner!==owner)return send(res,409,{error:'This application belongs to another browser. Complete it there or record an employer receipt.'});
   if(researchConsentWithdrawn(db,j.id,j.applicant_id))return send(res,403,{error:'Google public job-page drafting consent was withdrawn'});
   db.prepare("UPDATE jobs SET local_owner=?,local_attempt_at=CASE WHEN local_owner IS NULL THEN COALESCE(local_attempt_at,?) ELSE local_attempt_at END WHERE id=?").run(owner,now(),j.id);
   const current=db.prepare('SELECT local_attempt_at FROM jobs WHERE id=?').get(j.id);
   return send(res,200,{ok:true,attempted:!!current.local_attempt_at,phase:j.local_phase});
  }
  if(!['saved','queued','paused','needs_review'].includes(j.status)||['Unconfirmed submission','Submission in progress'].includes(j.challenge))return send(res,409,{error:'Wait for the worker or check the employer receipt before opening a local application'});
  if(!supported(j.url))return send(res,400,{error:'Use a supported direct employer application link'});
  const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,uid);
  if(!p?.consent||!p.email||!p.resume_path)return send(res,400,{error:'Applicant consent, email and resume required'});
  if(researchConsentWithdrawn(db,j.id,p.id))return send(res,403,{error:'Google public job-page drafting consent was withdrawn'});
  if(j.handoff_available){
   try{const r=await fetch('http://127.0.0.1:8081/'+j.id+'/close',{method:'POST',headers:{authorization:req.headers.authorization,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error();}
   catch{return send(res,409,{error:'Close the existing live session before switching to your browser'});}
  }
  const result=db.prepare("UPDATE jobs SET status='local_browser',handoff_available=0,challenge='Local browser',local_owner=?,local_phase='ready',updated_at=? WHERE id=? AND status=? AND COALESCE(challenge,'')=COALESCE(?,'')").run(owner,now(),j.id,j.status,j.challenge);
  if(!result.changes)return send(res,409,{error:'Application changed. Refresh before continuing'});
  event(j.id,'local_browser','Opening in your browser. Cloud retries disabled for this application.');return send(res,200,{ok:true});
 }
 if(j.local_owner!==owner)return send(res,409,{error:'Application belongs to another browser'});
 if(j.status==='submitted'&&action==='submitted')return send(res,200,{ok:true});
 if(j.status!=='local_browser')return send(res,409,{error:'This application is not active in your browser'});
 if(action==='capture'&&req.method==='POST'){const x=JSON.parse(await body(req)),fields=Array.isArray(x.fields)?x.fields.filter(f=>typeof f?.question==='string'&&!hasResearchDraftForQuestion(db,j.id,f.question.trim())):x.fields;return send(res,200,{saved:captureAnswers(db,j,fields)});}
 if(action==='packet'&&req.method==='GET'){
  const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,uid);
  if(!p?.consent)return send(res,403,{error:'Applicant consent required'});
  if(researchConsentWithdrawn(db,j.id,p.id))return send(res,403,{error:'Google public job-page drafting consent was withdrawn'});
  const bytes=await readFile(p.resume_path);if(bytes.length>limit)throw Error('Resume too large');
  const applicationAnswers=JSON.parse(j.answers_json||'{}');if(!p.google_research_consent)for(const [question,answer] of Object.entries(applicationAnswers))if(isResearchDraft(db,j.id,question,answer))delete applicationAnswers[question];
  return send(res,200,{job:{id:j.id,url:j.url,title:j.title,company:j.company,attempted:!!j.local_attempt_at,phase:j.local_phase},profile:{name:p.name,email:p.email,phone:p.phone,location:p.location},answers:{...reusableAnswers(db,p),...applicationAnswers},applicationOnlyQuestions:db.prepare('SELECT DISTINCT question FROM research_drafts WHERE job_id=?').all(j.id).map(row=>row.question),resume:{name:'resume'+extname(p.resume_path),base64:bytes.toString('base64')}});
 }
 if(action==='research-answer'&&req.method==='POST'){
  const x=JSON.parse(await body(req)),question=text(x.question,240);if(!question)return send(res,400,{error:'A public job-page question is required'});
  try{
   if(!db.prepare('SELECT google_research_consent FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,uid)?.google_research_consent)return send(res,403,{error:'Enable Google public job-page drafting in profile setup first.'});
   const answers=JSON.parse(j.answers_json||'{}'),saved=Object.entries(answers).find(([,answer])=>typeof answer==='string'&&isResearchDraft(db,j.id,question,answer));
   if(saved)return send(res,200,{answer:saved[1],requiresReview:true,citations:[]});
   const result=await researchForJob(db,uid,j.id,question);if(!result.answer)return send(res,200,result);
   Object.defineProperty(answers,question,{value:result.answer,enumerable:true,configurable:true,writable:true});db.prepare('UPDATE jobs SET answers_json=?,updated_at=? WHERE id=?').run(JSON.stringify(answers),now(),j.id);
   return send(res,200,result);
  }catch(error){return send(res,400,{error:error.message});}
 }
 if(action==='research-used'&&req.method==='POST'){
  const x=JSON.parse(await body(req)),questions=Array.isArray(x.questions)?x.questions.filter(question=>typeof question==='string'&&question.trim()&&question.length<=240).slice(0,100):[];
  if(!questions.length)return send(res,400,{error:'Research-backed fields required'});
  let marked=0;for(const question of questions)if(markResearchDraftUsed(db,j.id,question))marked++;
  if(!marked)return send(res,400,{error:'Research provenance not found for these fields'});
  if(researchConsentWithdrawn(db,j.id,j.applicant_id))return send(res,403,{error:'Google public job-page drafting consent was withdrawn'});
  return send(res,200,{marked});
 }
 if(action==='step'&&req.method==='POST'){
  const p=db.prepare('SELECT consent FROM applicants WHERE id=?').get(j.applicant_id);
  if(!p?.consent)return send(res,403,{error:'Applicant consent was withdrawn'});
  if(researchConsentWithdrawn(db,j.id,j.applicant_id))return send(res,403,{error:'Google public job-page drafting consent was withdrawn'});
  return send(res,200,{ok:true});
 }
 if(action==='attempt'&&req.method==='POST'){
  const x=JSON.parse(await body(req));
  if(x.human!==true&&x.automatic!==true)return send(res,409,{error:'Review the employer form and click Submit yourself'});
  const p=db.prepare('SELECT consent FROM applicants WHERE id=?').get(j.applicant_id);
  if(!p?.consent)return send(res,403,{error:'Applicant consent was withdrawn'});
  if(researchConsentWithdrawn(db,j.id,j.applicant_id))return send(res,403,{error:'Google public job-page drafting consent was withdrawn'});
  if(typeof x.before!=='string'||!sameApplication(x.url,j.url)||employerReceipt(x.before)||(x.automatic===true&&sensitive(x.before)))return send(res,409,{error:'Application requires human review before submission'});
  if(j.local_attempt_at)return send(res,409,{error:'Submission may already have occurred. Check the employer receipt.'});
  const result=db.prepare("UPDATE jobs SET local_attempt_at=?,local_phase='verifying',challenge='Submission in progress',updated_at=? WHERE id=? AND local_attempt_at IS NULL AND status='local_browser'").run(now(),now(),j.id);
  if(!result.changes)return send(res,409,{error:'Submission already started'});
  event(j.id,'submission_started','Local submission intent saved before clicking; automatic retry disabled.');return send(res,200,{ok:true});
 }
 if(action==='progress'&&req.method==='POST'){
  const x=JSON.parse(await body(req)),fields=Array.isArray(x.fields)?x.fields.filter(v=>typeof v==='string').slice(0,100).map(v=>text(v,240)):[];
  const message=text(x.message,500)||'Continue in your employer tab';
  const previous=db.prepare("SELECT message FROM events WHERE job_id=? AND type='local_browser' ORDER BY id DESC LIMIT 1").get(j.id)?.message;
  db.prepare('UPDATE jobs SET required_fields_json=?,local_phase=?,updated_at=? WHERE id=?').run(JSON.stringify(fields),j.local_attempt_at?(x.blocked===true?'uncertain':'verifying'):x.blocked===true?'blocked':'ready',now(),j.id);
  if(message!==previous){event(j.id,'local_browser',message);if(Number.isInteger(x.filled)&&x.filled>0&&x.filled<=150)event(j.id,'filled','Filled '+x.filled+' saved fields in the employer browser');}return send(res,200,{ok:true});
 }
 if(action==='submitted'&&req.method==='POST'){
  const x=JSON.parse(await body(req)),receipt=text(x.receipt,300);
  if(!j.local_attempt_at||!sameApplication(x.url,j.url)||x.afterSubmit!==true||!employerReceipt(receipt))return send(res,400,{error:'An employer receipt after submission is required'});
  db.prepare("UPDATE jobs SET status='submitted',confirmation=?,challenge=NULL,updated_at=? WHERE id=? AND status='local_browser'").run('Browser extension observed: '+receipt,now(),j.id);
  confirmLibrary(db,j);
  event(j.id,'submitted','Browser extension observed employer confirmation: '+receipt);return send(res,200,{ok:true});
 }
 return send(res,405,{error:'Method not allowed'});
}
let handoffRoute=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/handoff\/(open|view|click|drag|upload|text|key|scroll|resume|close)$/);
if(handoffRoute&&req.method==='POST'){
 const j=ownJob(uid,handoffRoute[1]);if(!j)return send(res,404,{error:'Job not found'});
 const action=handoffRoute[2];
 if(action==='open'){
  if(researchConsentWithdrawn(db,j.id,j.applicant_id))return send(res,403,{error:'Google public job-page drafting consent was withdrawn'});
  if(j.handoff_available)return send(res,200,{available:true});
  if(!['paused','needs_review'].includes(j.status)||['Unconfirmed submission','Submission in progress'].includes(j.challenge))return send(res,409,{error:'This application cannot restart until its submission status is checked'});
  const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,uid);
  if(!p?.consent||!p.email||!p.resume_path)return send(res,400,{error:'Applicant consent, email and resume required'});
  if(!supported(j.url))return send(res,400,{error:'Supported employer link required'});
  db.prepare("UPDATE jobs SET status='queued',challenge=NULL,updated_at=? WHERE id=? AND status IN ('paused','needs_review')").run(now(),j.id);
  event(j.id,'queued','Preparing a live application browser for applicant takeover');return send(res,200,{preparing:true});
 }
 if(!j.handoff_available)return send(res,409,{error:'The live browser has expired or restarted. Reopen the application to prepare another.'});
 const input=await body(req,action==='upload'?9000000:20000);
 try{const response=await fetch('http://127.0.0.1:8081/'+j.id+'/'+action,{method:'POST',headers:{authorization:req.headers.authorization,'content-type':'application/json'},body:input.length?input:'{}',signal:AbortSignal.timeout(20000)});return send(res,response.status,await response.json());}
 catch{return send(res,503,{error:'The live browser is unavailable. Check the worker status and try again.'})}
}
let continueRoute=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/continue$/);
if(continueRoute&&req.method==='POST'){
 const j=ownJob(uid,continueRoute[1]);if(!j)return send(res,404,{error:'Job not found'});
 if(j.handoff_available)return send(res,409,{error:'Use Take over and Resume worker to continue in the existing browser'});
 if(!['needs_review','paused'].includes(j.status)||['Unconfirmed submission','Submission in progress','CAPTCHA','Sign-in'].includes(j.challenge))return send(res,409,{error:'This application requires employer-site action before it can continue'});
 const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,uid);
 if(!p?.consent||!p.email||!p.resume_path)return send(res,400,{error:'Applicant consent, email and resume required'});
 if(researchConsentWithdrawn(db,j.id,p.id))return send(res,403,{error:'Google public job-page drafting consent was withdrawn'});
 if(!supported(j.url))return send(res,400,{error:'A supported employer application link is required'});
 const x=JSON.parse(await body(req)),entries=Object.entries(x.answers||{});
 if(!entries.length||entries.length>100)return send(res,400,{error:'Enter the missing answers'});
 if(!p.google_research_consent&&entries.some(([question])=>hasResearchDraftForQuestion(db,j.id,question)))return send(res,403,{error:'Google public job-page drafting consent was withdrawn'});
 const answers=JSON.parse(j.answers_json||'{}');for(const [question,answer] of entries){if(typeof answer!=='string'||!question.trim()||question.length>240||!answer.trim()||answer.length>4000)return send(res,400,{error:'Complete each answer (maximum 4,000 characters)'});Object.defineProperty(answers,question,{value:answer.trim(),enumerable:true,configurable:true,writable:true});}
 if(Object.keys(answers).length>100)return send(res,400,{error:'Answer limit reached'});
 const result=db.prepare("UPDATE jobs SET answers_json=?,status='queued',challenge=NULL,updated_at=? WHERE id=? AND status=? AND COALESCE(challenge,'')=COALESCE(?,'')").run(JSON.stringify(answers),now(),j.id,j.status,j.challenge);
 if(!result.changes)return send(res,409,{error:'Application changed. Refresh to see its current status'});
 for(const [question] of entries)markResearchDraftUsed(db,j.id,question);
 if(x.remember===true)rememberAnswers(j.applicant_id,entries.filter(([q])=>canReuse(q.trim())&&!hasResearchDraftForQuestion(db,j.id,q.trim())));
 event(j.id,'queued','Missing answers saved; application queued to continue');return send(res,200,{ok:true});
}
let answerRoute=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/answers$/);
if(answerRoute){const j=ownJob(uid,answerRoute[1]);if(!j)return send(res,404,{error:'Job not found'});
 if(req.method==='GET')return send(res,200,{answers:JSON.parse(j.answers_json||'{}')});
 if(req.method==='PUT'){
  if(['running','queued','submitted'].includes(j.status))return send(res,409,{error:'Answers cannot change while queued, running or submitted'});
  const x=JSON.parse(await body(req)),question=text(x.question,240),answer=text(x.answer,4000);
  if(!question||!answer)return send(res,400,{error:'Enter the exact question and your answer'});
  const answers=JSON.parse(j.answers_json||'{}');if(Object.keys(answers).length>=100&&!Object.hasOwn(answers,question))return send(res,400,{error:'Answer limit reached'});
  Object.defineProperty(answers,question,{value:answer,enumerable:true,configurable:true,writable:true});
  db.prepare('UPDATE jobs SET answers_json=?,updated_at=? WHERE id=?').run(JSON.stringify(answers),now(),j.id);
  markResearchDraftUsed(db,j.id,question);
  const reusable=x.remember===true&&canReuse(question)&&!hasResearchDraftForQuestion(db,j.id,question);
  if(reusable)rememberAnswers(j.applicant_id,[[question,answer]]);
  event(j.id,'answer_saved',reusable?'Saved applicant-approved answer for reuse':'Saved an answer for this application');return send(res,200,{ok:true});
 }
}
let outcomeRoute=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/outcome$/);
if(outcomeRoute&&req.method==='PUT'){
 const j=ownJob(uid,outcomeRoute[1]);if(!j)return send(res,404,{error:'Job not found'});
 const x=JSON.parse(await body(req));
 if(!['submitted','interview','rejected','offer'].includes(j.status)||!['interview','rejected','offer'].includes(x.status))return send(res,409,{error:'Record an employer receipt first, then choose Interview, Rejected or Offer'});
 db.prepare('UPDATE jobs SET status=?,updated_at=? WHERE id=?').run(x.status,now(),j.id);event(j.id,x.status,'Applicant recorded employer outcome');return send(res,200,{ok:true});
}
let jobLink=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/application-link$/);
if(jobLink&&req.method==='PUT'){
  const j=ownJob(uid,jobLink[1]);if(!j)return send(res,404,{error:'Job not found'});
  if(!['saved','paused','needs_review'].includes(j.status)||['Unconfirmed submission','Submission in progress'].includes(j.challenge))return send(res,409,{error:'Review this application before changing its link'});
  const x=JSON.parse(await body(req)),url=normalizeURL(x.url),host=new URL(url).hostname;
  if(!supported(url))return send(res,400,{error:'Use a direct Greenhouse, Lever, or Workday employer application link'});
  try{db.prepare("UPDATE jobs SET url=?,normalized_url=?,status='saved',challenge=NULL,updated_at=? WHERE id=?").run(url,url,now(),j.id)}catch{return send(res,409,{error:'This employer job is already tracked'})}
  event(j.id,'link_updated','Direct employer application link added');return send(res,200,{ok:true});
}
m=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/queue$/);if(m&&req.method==='POST'){let j=ownJob(uid,m[1]);if(!j)return send(res,404,{error:'Job not found'});if(j.handoff_available)return send(res,409,{error:'Resume the existing live browser instead of queuing a duplicate attempt'});if(!supported(j.url))return send(res,400,{error:'Add the direct employer application link before queuing'});if(['Unconfirmed submission','Submission in progress'].includes(j.challenge))return send(res,409,{error:'The employer may have received this application. Check the employer site and record confirmation before trying again.'});let p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,uid);if(!p.consent||!p.email||!p.resume_path)return send(res,400,{error:'Applicant consent, email and resume required'});if(researchConsentWithdrawn(db,j.id,p.id))return send(res,403,{error:'Google public job-page drafting consent was withdrawn'});if(!['saved','needs_review','paused'].includes(j.status))return send(res,409,{error:'This job cannot be queued from its current state'});db.prepare("UPDATE jobs SET status='queued',challenge=NULL,updated_at=? WHERE id=?").run(now(),j.id);event(j.id,'queued','Application queued');return send(res,200,{ok:true})}
m=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/confirm$/);if(m&&req.method==='POST'){let j=ownJob(uid,m[1]);if(!j)return send(res,404,{error:'Job not found'});if(['queued','running'].includes(j.status))return send(res,409,{error:'Wait until the worker finishes before recording a manual confirmation'});let x=JSON.parse(await body(req)),receipt=text(x.receipt,300);if(!employerReceipt(receipt)||/placeholder|example\.com|github\.com|not (?:yet )?(?:submitted|confirmed)|unconfirmed|simulat|test receipt/i.test(receipt))return send(res,400,{error:'Paste the employer message confirming that your application was received or submitted. Profile links and placeholders are not receipts.'});db.prepare("UPDATE jobs SET status='submitted',confirmation=?,challenge=NULL,updated_at=? WHERE id=?").run('Applicant verified: '+receipt,now(),j.id);confirmLibrary(db,j);event(j.id,'manual_confirmation','Applicant recorded employer confirmation: '+receipt);return send(res,200,{ok:true})}
m=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/events$/);if(m&&req.method==='GET'){if(!ownJob(uid,m[1]))return send(res,404,{error:'Job not found'});return send(res,200,{events:db.prepare('SELECT at,type,message FROM events WHERE job_id=? ORDER BY id').all(m[1])})}
return send(res,404,{error:'Not found'});
}catch(e){console.error(e);return send(res,e.message==='Request too large'?413:400,{error:e.message||'Request failed'})}}).listen(Number(process.env.PORT||8080),process.env.BIND_HOST||'0.0.0.0',()=>console.log('ApplyPilot API listening'));
