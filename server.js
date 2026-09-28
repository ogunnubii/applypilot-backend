import {supported,sameApplication,receipt as employerReceipt,sensitive} from './local-policy.js';
import {rememberAnswers} from './local-state.js';
import {installNotifications,emailConfigured,sendBlockerEmails} from './notifications.js';
import {chat} from './assistant.js';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';import {randomUUID} from 'node:crypto';import {mkdir,writeFile,unlink} from 'node:fs/promises';import {join,resolve,extname} from 'node:path';import {db,event,now,normalizeURL} from './db.js';import {hashPassword,verifyPassword,issueToken,readToken} from './auth.js';
import {parseBoards,parseIntent,runSearch} from './discovery.js';
import {resumeRoles} from './resume.js';
installNotifications(db);
let emailBusy=false;
const emailTimer=setInterval(async()=>{if(emailBusy)return;emailBusy=true;try{await sendBlockerEmails(db)}catch{console.error('Blocker notification delivery failed')}finally{emailBusy=false}},60000);emailTimer.unref();
const origin=process.env.PUBLIC_ORIGIN;if(!origin)throw Error('Set PUBLIC_ORIGIN');if(!process.env.REGISTRATION_CODE||process.env.REGISTRATION_CODE.length<24)throw Error('Set REGISTRATION_CODE to a random value of at least 24 characters');const attempts=new Map();const uploadDir=resolve(process.env.UPLOAD_DIR||'./data/resumes');const limit=6*1024*1024;
const send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))};
async function body(req,max=100000){let chunks=[],size=0;for await(let chunk of req){size+=chunk.length;if(size>max)throw Error('Request too large');chunks.push(chunk)}return Buffer.concat(chunks)}
const text=(v,max=500)=>String(v??'').trim().slice(0,max);
const ownJob=(uid,id)=>db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(id,uid);
function createResumeSearch(uid,applicant,roles){
  const place=/\bcanada\b/i.test(applicant.location)?'; Canada':/\b(?:usa|united states)\b/i.test(applicant.location)?'; USA':'';
  const instruction=roles.join(', ')+place;
  const existing=db.prepare('SELECT id FROM searches WHERE user_id=? AND applicant_id=? AND auto_generated=1').get(uid,applicant.id);
  const id=existing?.id||randomUUID();
  if(existing)db.prepare("UPDATE searches SET instruction=?,enabled=1,last_run=NULL,last_error=NULL WHERE id=?").run(instruction,id);
  else db.prepare('INSERT INTO searches(id,user_id,applicant_id,instruction,boards_json,auto_queue,auto_generated,created_at) VALUES(?,?,?,?,?,0,1,?)').run(id,uid,applicant.id,instruction,'[]',now());
  setImmediate(()=>runSearch(id,uid).catch(e=>console.error('Resume search:',e.message)));
  return instruction;
}
createServer(async(req,res)=>{res.setHeader('access-control-allow-origin',origin);res.setHeader('vary','Origin');res.setHeader('access-control-allow-headers','authorization,content-type,x-applypilot-device');res.setHeader('access-control-allow-methods','GET,POST,PUT,DELETE,OPTIONS');if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}if(req.headers.origin&&req.headers.origin!==origin&&req.headers.origin!==process.env.SERVICE_ORIGIN)return send(res,403,{error:'Origin not allowed'});
try{let path=new URL(req.url,'http://localhost').pathname;if(req.method==='GET'&&['/','/assistant','/assistant.js'].includes(path)){res.writeHead(200,{'content-type':path.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});res.end(await readFile(new URL(path.endsWith('.js')?'./assistant-client.js':'./assistant-page.html',import.meta.url)));return;}
if(req.method==='GET'&&['/setup','/setup.js'].includes(path)){
 res.writeHead(200,{'content-type':path.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});res.end(await readFile(new URL(path.endsWith('.js')?'./web/setup.js':'./web/setup.html',import.meta.url)));return;
}
if(path==='/api/health')return send(res,200,{ok:true,release:'2026-09-28-hosted-agent',aiConfigured:!!(process.env.OPENAI_API_KEY&&process.env.OPENAI_MODEL)});
if(path==='/api/register'&&req.method==='POST'){let input=JSON.parse(await body(req));if(input.registration_code!==process.env.REGISTRATION_CODE)return send(res,403,{error:'Registration code required'});let email=text(input.email,254).toLowerCase();if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return send(res,400,{error:'Valid email required'});let id=randomUUID(),hash=hashPassword(input.password);try{db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id,email,hash,now())}catch{return send(res,409,{error:'Account already exists'})}return send(res,201,{token:issueToken(id,input.remember===true)})}
if(path==='/api/login'&&req.method==='POST'){let address=req.socket.remoteAddress||'unknown',rate=attempts.get(address)||{count:0,at:Date.now()};if(Date.now()-rate.at>600000)rate={count:0,at:Date.now()};if(rate.count>=10)return send(res,429,{error:'Too many sign-in attempts. Try later.'});rate.count++;attempts.set(address,rate);let input=JSON.parse(await body(req)),u=db.prepare('SELECT * FROM users WHERE email=?').get(text(input.email,254).toLowerCase());if(!u||!verifyPassword(input.password,u.password_hash))return send(res,401,{error:'Invalid credentials'});attempts.delete(address);return send(res,200,{token:issueToken(u.id,input.remember===true)})}
let uid=readToken(req.headers.authorization?.replace(/^Bearer /i,''));if(!uid)return send(res,401,{error:'Sign in required'});
if(path==='/api/notifications'&&['GET','PUT'].includes(req.method)){
 if(req.method==='PUT'){const x=JSON.parse(await body(req));if(typeof x.enabled!=='boolean')return send(res,400,{error:'Choose whether to enable blocker emails'});db.prepare('INSERT INTO notification_preferences(user_id,enabled) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled').run(uid,x.enabled?1:0);}
 const enabled=!!db.prepare('SELECT enabled FROM notification_preferences WHERE user_id=?').get(uid)?.enabled;
 return send(res,200,{enabled,configured:emailConfigured(),failed:db.prepare("SELECT COUNT(*) AS n FROM blocker_emails b JOIN jobs j ON j.id=b.job_id WHERE j.user_id=? AND b.last_error IS NOT NULL").get(uid).n});
}
if(path==='/api/chat'&&req.method==='POST')return send(res,200,await chat(uid,JSON.parse(await body(req))));
if(path==='/api/status'&&req.method==='GET'){const heartbeat=db.prepare('SELECT heartbeat FROM worker_status WHERE id=1').get()?.heartbeat;return send(res,200,{workerOnline:!!heartbeat&&Date.now()-Date.parse(heartbeat)<45000,heartbeat:heartbeat||null,queue:db.prepare("SELECT status,COUNT(*) AS count FROM jobs WHERE user_id=? AND status NOT IN ('duplicate','archived') GROUP BY status").all(uid)});}
if(path==='/api/activity'&&req.method==='GET')return send(res,200,{events:db.prepare('SELECT e.at,e.type,e.message,j.title,j.company,j.applicant_id FROM events e JOIN jobs j ON j.id=e.job_id WHERE j.user_id=? ORDER BY e.id DESC LIMIT 100').all(uid)});
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
if(path==='/api/applicants'&&req.method==='GET')return send(res,200,{applicants:db.prepare('SELECT id,name,email,phone,location,focus,execution_mode,answers_json,consent,ai_consent,resume_path IS NOT NULL AS has_resume FROM applicants WHERE user_id=?').all(uid).map(p=>({...p,answers:JSON.parse(p.answers_json),answers_json:undefined,resume_path:undefined}))});
if(path==='/api/applicants'&&req.method==='POST'){let x=JSON.parse(await body(req)),id=randomUUID();db.prepare('INSERT INTO applicants(id,user_id,name,email,phone,location,focus,answers_json,consent,ai_consent,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,uid,text(x.name,150),text(x.email,254),text(x.phone,50),text(x.location,150),text(x.focus,300),JSON.stringify(x.answers||{}),x.consent===true?1:0,x.ai_consent===true?1:0,now());db.prepare('UPDATE applicants SET execution_mode=? WHERE id=?').run(x.execution_mode==='local'?'local':'cloud',id);return send(res,201,{id})}
let m=path.match(/^\/api\/applicants\/([a-f0-9-]+)$/);if(m&&req.method==='PUT'){let x=JSON.parse(await body(req)),p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(m[1],uid);if(!p)return send(res,404,{error:'Applicant not found'});db.prepare('UPDATE applicants SET name=?,email=?,phone=?,location=?,focus=?,answers_json=?,consent=?,ai_consent=? WHERE id=?').run(text(x.name,150),text(x.email,254),text(x.phone,50),text(x.location,150),text(x.focus,300),JSON.stringify(x.answers||{}),x.consent===true?1:0,x.ai_consent===true?1:0,p.id);if(['local','cloud'].includes(x.execution_mode))db.prepare('UPDATE applicants SET execution_mode=? WHERE id=?').run(x.execution_mode,p.id);return send(res,200,{ok:true})}
m=path.match(/^\/api\/applicants\/([a-f0-9-]+)\/resume$/);if(m&&req.method==='POST'){let p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(m[1],uid);if(!p)return send(res,404,{error:'Applicant not found'});let kind=req.headers['content-type'],ext=kind==='application/pdf'?'.pdf':kind==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'?'.docx':null;if(!ext)return send(res,415,{error:'Use PDF or DOCX'});let bytes=await body(req,limit);if(bytes.length<100)return send(res,400,{error:'Resume appears empty'});if(ext==='.pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))return send(res,400,{error:'Invalid PDF'});if(ext==='.docx'&&!bytes.subarray(0,2).equals(Buffer.from('PK')))return send(res,400,{error:'Invalid DOCX'});await mkdir(uploadDir,{recursive:true,mode:0o700});let file=join(uploadDir,randomUUID()+ext);await writeFile(file,bytes,{mode:0o600});db.prepare('UPDATE applicants SET resume_path=? WHERE id=?').run(file,p.id);if(p.resume_path)await unlink(p.resume_path).catch(()=>{});let roles=[],instruction='',resumeNotice='';try{roles=await resumeRoles(file,ext);if(roles.length)instruction=createResumeSearch(uid,p,roles);else resumeNotice='No clear role titles found in the resume. Add a search manually.'}catch(e){console.error('Resume parsing:',e.message);resumeNotice='Resume saved, but its text could not be read. Add a search manually.'}return send(res,200,{ok:true,roles,instruction,resumeNotice})}
if(path==='/api/jobs'&&req.method==='GET')return send(res,200,{jobs:db.prepare(`SELECT id,applicant_id,title,company,url,status,notes,confirmation,challenge,created_at,updated_at,required_fields_json,answers_json,handoff_available,local_phase,local_attempt_at,(SELECT execution_mode FROM applicants WHERE id=jobs.applicant_id) AS execution_mode,(SELECT message FROM events WHERE job_id=jobs.id AND type IN ('paused','needs_review') ORDER BY id DESC LIMIT 1) AS blocker_message,(SELECT message FROM events WHERE job_id=jobs.id ORDER BY id DESC LIMIT 1) AS last_message FROM jobs WHERE user_id=? AND status NOT IN ('duplicate','archived') ORDER BY discovery_priority,created_at DESC`).all(uid)});
if(path==='/api/jobs'&&req.method==='POST'){let x=JSON.parse(await body(req)),p=db.prepare('SELECT id FROM applicants WHERE id=? AND user_id=?').get(x.applicant_id,uid);if(!p)return send(res,400,{error:'Select your applicant profile'});let url=normalizeURL(x.url),id=randomUUID(),date=now();if(!supported(url))return send(res,400,{error:'Use a supported direct employer application link. Aggregator listings are not accepted.'});try{db.prepare('INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,uid,p.id,text(x.title,200),text(x.company,200),url,url,text(x.notes,2000),date,date)}catch{return send(res,409,{error:'Job already tracked for this applicant'})}event(id,'saved','Job added');return send(res,201,{id})}
// Local browser mode owns the application until a receipt is recorded.
let localRoute=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/local\/(claim|packet|progress|attempt|submitted)$/);
if(localRoute){
 const j=ownJob(uid,localRoute[1]);if(!j)return send(res,404,{error:'Job not found'});
 const action=localRoute[2],owner=req.headers['x-applypilot-device'];
 if(typeof owner!=='string'||!/^[a-f0-9-]{36}$/.test(owner))return send(res,400,{error:'Update the extension and reconnect this browser'});
 if(action==='claim'&&req.method==='POST'){
  if(j.status==='local_browser'){
   if(j.local_owner&&j.local_owner!==owner)return send(res,409,{error:'This application belongs to another browser. Complete it there or record an employer receipt.'});
   db.prepare("UPDATE jobs SET local_owner=?,local_attempt_at=CASE WHEN local_owner IS NULL THEN COALESCE(local_attempt_at,?) ELSE local_attempt_at END WHERE id=?").run(owner,now(),j.id);
   const current=db.prepare('SELECT local_attempt_at FROM jobs WHERE id=?').get(j.id);
   return send(res,200,{ok:true,attempted:!!current.local_attempt_at,phase:j.local_phase});
  }
  if(!['saved','queued','paused','needs_review'].includes(j.status)||['Unconfirmed submission','Submission in progress'].includes(j.challenge))return send(res,409,{error:'Wait for the worker or check the employer receipt before opening a local application'});
  if(!supported(j.url))return send(res,400,{error:'Use a supported direct employer application link'});
  const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,uid);
  if(!p?.consent||!p.email||!p.resume_path)return send(res,400,{error:'Applicant consent, email and resume required'});
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
 if(action==='packet'&&req.method==='GET'){
  const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,uid);
  if(!p?.consent)return send(res,403,{error:'Applicant consent required'});
  const bytes=await readFile(p.resume_path);if(bytes.length>limit)throw Error('Resume too large');
  return send(res,200,{job:{id:j.id,url:j.url,title:j.title,company:j.company,attempted:!!j.local_attempt_at,phase:j.local_phase},profile:{name:p.name,email:p.email,phone:p.phone,location:p.location},answers:{...JSON.parse(p.answers_json||'{}'),...JSON.parse(j.answers_json||'{}')},resume:{name:'resume'+extname(p.resume_path),base64:bytes.toString('base64')}});
 }
 if(action==='attempt'&&req.method==='POST'){
  const x=JSON.parse(await body(req));
  const p=db.prepare('SELECT consent FROM applicants WHERE id=?').get(j.applicant_id);
  if(!p?.consent)return send(res,403,{error:'Applicant consent was withdrawn'});
  if(typeof x.before!=='string'||!sameApplication(x.url,j.url)||employerReceipt(x.before)||(x.human!==true&&sensitive(x.before)))return send(res,409,{error:'Application requires human review before submission'});
  if(j.local_attempt_at)return send(res,409,{error:'Submission may already have occurred. Check the employer receipt.'});
  const result=db.prepare("UPDATE jobs SET local_attempt_at=?,local_phase='verifying',challenge='Submission in progress',updated_at=? WHERE id=? AND local_attempt_at IS NULL AND status='local_browser'").run(now(),now(),j.id);
  if(!result.changes)return send(res,409,{error:'Submission already started'});
  event(j.id,'submission_started','Local submission intent saved before clicking; automatic retry disabled.');return send(res,200,{ok:true});
 }
 if(action==='progress'&&req.method==='POST'){
  const x=JSON.parse(await body(req)),fields=Array.isArray(x.fields)?x.fields.filter(v=>typeof v==='string').slice(0,100).map(v=>text(v,240)):[];
  const message=text(x.message,500)||'Continue in your employer tab';
  const previous=db.prepare("SELECT message FROM events WHERE job_id=? AND type='local_browser' ORDER BY id DESC LIMIT 1").get(j.id)?.message;
  db.prepare('UPDATE jobs SET required_fields_json=?,local_phase=?,updated_at=? WHERE id=?').run(JSON.stringify(fields),j.local_attempt_at?'verifying':x.blocked===true?'blocked':'ready',now(),j.id);
  if(message!==previous)event(j.id,'local_browser',message);return send(res,200,{ok:true});
 }
 if(action==='submitted'&&req.method==='POST'){
  const x=JSON.parse(await body(req)),receipt=text(x.receipt,300);
  if(!j.local_attempt_at||!sameApplication(x.url,j.url)||x.afterSubmit!==true||!employerReceipt(receipt))return send(res,400,{error:'An employer receipt after submission is required'});
  db.prepare("UPDATE jobs SET status='submitted',confirmation=?,challenge=NULL,updated_at=? WHERE id=? AND status='local_browser'").run('Browser extension observed: '+receipt,now(),j.id);
  event(j.id,'submitted','Browser extension observed employer confirmation: '+receipt);return send(res,200,{ok:true});
 }
 return send(res,405,{error:'Method not allowed'});
}
let handoffRoute=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/handoff\/(open|view|click|drag|upload|text|key|scroll|resume|close)$/);
if(handoffRoute&&req.method==='POST'){
 const j=ownJob(uid,handoffRoute[1]);if(!j)return send(res,404,{error:'Job not found'});
 const action=handoffRoute[2];
 if(action==='open'){
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
 if(!supported(j.url))return send(res,400,{error:'A supported employer application link is required'});
 const x=JSON.parse(await body(req)),entries=Object.entries(x.answers||{});
 if(!entries.length||entries.length>100)return send(res,400,{error:'Enter the missing answers'});
 const answers=JSON.parse(j.answers_json||'{}');for(const [question,answer] of entries){if(typeof answer!=='string'||!question.trim()||question.length>240||!answer.trim()||answer.length>4000)return send(res,400,{error:'Complete each answer (maximum 4,000 characters)'});Object.defineProperty(answers,question,{value:answer.trim(),enumerable:true,configurable:true,writable:true});}
 if(Object.keys(answers).length>100)return send(res,400,{error:'Answer limit reached'});
 const result=db.prepare("UPDATE jobs SET answers_json=?,status='queued',challenge=NULL,updated_at=? WHERE id=? AND status=? AND COALESCE(challenge,'')=COALESCE(?,'')").run(JSON.stringify(answers),now(),j.id,j.status,j.challenge);
 if(!result.changes)return send(res,409,{error:'Application changed. Refresh to see its current status'});
 if(x.remember===true)rememberAnswers(j.applicant_id,entries.filter(([q])=>!sensitive(q)));
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
  if(x.remember===true&&!sensitive(question))rememberAnswers(j.applicant_id,[[question,answer]]);
  event(j.id,'answer_saved',x.remember===true?'Saved applicant-approved answer for reuse':'Saved an answer for this application');return send(res,200,{ok:true});
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
m=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/queue$/);if(m&&req.method==='POST'){let j=ownJob(uid,m[1]);if(!j)return send(res,404,{error:'Job not found'});if(j.handoff_available)return send(res,409,{error:'Resume the existing live browser instead of queuing a duplicate attempt'});if(!supported(j.url))return send(res,400,{error:'Add the direct employer application link before queuing'});if(['Unconfirmed submission','Submission in progress'].includes(j.challenge))return send(res,409,{error:'The employer may have received this application. Check the employer site and record confirmation before trying again.'});let p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,uid);if(!p.consent||!p.email||!p.resume_path)return send(res,400,{error:'Applicant consent, email and resume required'});if(!['saved','needs_review','paused'].includes(j.status))return send(res,409,{error:'This job cannot be queued from its current state'});db.prepare("UPDATE jobs SET status='queued',challenge=NULL,updated_at=? WHERE id=?").run(now(),j.id);event(j.id,'queued','Application queued');return send(res,200,{ok:true})}
m=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/confirm$/);if(m&&req.method==='POST'){let j=ownJob(uid,m[1]);if(!j)return send(res,404,{error:'Job not found'});if(['queued','running'].includes(j.status))return send(res,409,{error:'Wait until the worker finishes before recording a manual confirmation'});let x=JSON.parse(await body(req)),receipt=text(x.receipt,300);if(receipt.length<8)return send(res,400,{error:'Enter the employer confirmation details'});db.prepare("UPDATE jobs SET status='submitted',confirmation=?,challenge=NULL,updated_at=? WHERE id=?").run('Applicant verified: '+receipt,now(),j.id);event(j.id,'manual_confirmation','Applicant recorded employer confirmation: '+receipt);return send(res,200,{ok:true})}
m=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/events$/);if(m&&req.method==='GET'){if(!ownJob(uid,m[1]))return send(res,404,{error:'Job not found'});return send(res,200,{events:db.prepare('SELECT at,type,message FROM events WHERE job_id=? ORDER BY id').all(m[1])})}
return send(res,404,{error:'Not found'});
}catch(e){console.error(e);return send(res,e.message==='Request too large'?413:400,{error:e.message||'Request failed'})}}).listen(Number(process.env.PORT||8080),process.env.BIND_HOST||'0.0.0.0',()=>console.log('ApplyPilot API listening'));
