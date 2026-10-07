import {populateBatch,batchSnapshot,resetSupportBatch,nextBatch,inActiveBatch,batchPreferences} from './application-batches.js';
import {canCapture} from './answer-library.js';
import {submissionDeclaration} from './local-policy.js';
import {ensureFocusedJob,focusSnapshot,setWorkFocus,focusAllowsSubmit,saveFormProgress,reserveAutonomousAttempt} from './single-application.js';
import {installFunnel,createFunnelBatch,funnelStatus,retryFunnelItem,processFunnel,enableWorldwideDiscovery} from './job-funnel.js';
import {experienceFor,saveExperience,deleteExperience} from './experience-library.js';
import {installLanguagePolicy,excludesFrench,frenchApplication,archiveFrench,setFrenchExclusion} from './language-policy.js';
import {installManualSubmitRecords,recordManualSubmit,recordReportedSubmission} from './manual-submit-record.js';
import {fillPendingFactQuestions} from './paused-fact-fill.js';
import {prepareFormAnswer} from './form-answer.js';
import {hasFactDraft} from './draft-provenance.js';
import {installSavedRecovery,recoverSavedAnswers,savedRecoveryStatus} from './saved-answer-recovery.js';
import {applicationLimit,employerHold,employerLimits,recordEmployerLimit} from './employer-limits.js';
import {companyApplicationPolicy,deferForCompanyLimit,isCompanyApplicationPolicyError,markExactRequisitionDuplicate} from './company-application-policy.js';
import {pipelineStatus,setPipeline,queueFoundApplications,queueEnabledPipelines} from './application-pipeline.js';
import {priorApplication} from './application-dedup.js';
import {prioritizeApplications} from './application-diversity.js';
import {installResumeEditor,prepareResumeEdit,saveResumeEdit,previousResumePath} from './resume-editor.js';
import {installPublicFill,fillPendingPublicQuestions,publicFillStatus,testPublicDrafting} from './public-answer-fill.js';
import {metadataFor} from './job-intelligence.js';
import {installContinuations,requestContinuation,listContinuations,claimContinuation,settleContinuation,cancelContinuation} from './continuation-queue.js';
import {operationSnapshot} from './operation-evidence.js';
import {splitApplicationCooldowns,hideCooldownActions} from './application-cooldowns.js';
import {officialCareers} from './official-careers.js';
import {extensionArchive} from './extension-package.js';
import {importHistory} from './application-history.js';
import {installArchive,archiveApplications,restoreApplication} from './application-archive.js';
import {installLibrary,captureAnswers,updateLibrary,deleteLibrary,confirmLibrary,canReuse,reusableAnswers} from './answer-library.js';
import {installDrafts,draftForJob,draftAnswer} from './answer-drafts.js';
import {hasResearchDraftForQuestion,installResearch,isResearchDraft,markResearchDraftUsed,researchForJob} from './google-research.js';
import {researchConsentWithdrawn} from './research-consent.js';
import {deleteApplication} from './delete-application.js';
import {supported,sameApplication,receipt as employerReceipt} from './local-policy.js';
import {rememberAnswers} from './local-state.js';
import {installNotifications,emailConfigured,sendBlockerEmails} from './notifications.js';
import {chat} from './assistant.js';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';import {randomUUID} from 'node:crypto';import {mkdir,writeFile,unlink} from 'node:fs/promises';import {join,resolve,extname} from 'node:path';import {db,event,now,normalizeURL} from './db.js';import {hashPassword,verifyPassword,issueToken,readToken} from './auth.js';
import {parseBoards,parseIntent,profileSearchInstruction,runSearch,SEARCH_INTERVAL_SECONDS} from './discovery.js';
import {resumeRoles,resumeText} from './resume.js';
installNotifications(db);installLibrary(db);installDrafts(db);installResearch(db);db.exec('CREATE TABLE IF NOT EXISTS work_focus(user_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,job_id TEXT)');
installArchive(db);installLanguagePolicy(db);installManualSubmitRecords(db);installContinuations(db);installPublicFill(db);installResumeEditor(db);installSavedRecovery(db);
installFunnel(db);let funnelBusy=false;async function funnelTick(){if(funnelBusy)return;funnelBusy=true;try{await processFunnel(db);}catch(error){console.error('Job funnel:',error.message);}finally{funnelBusy=false}}
const funnelTimer=setInterval(funnelTick,30000);funnelTimer.unref();setTimeout(funnelTick,2000).unref();
const savedRecoveryTick=()=>{try{recoverSavedAnswers(db);}catch(error){console.error('Saved-answer recovery:',error.message);}};
const savedRecoveryTimer=setInterval(savedRecoveryTick,60000);savedRecoveryTimer.unref();setTimeout(savedRecoveryTick,2000).unref();
const pipelineTimer=setInterval(()=>{try{queueEnabledPipelines(db);}catch(error){console.error('Application pipeline:',error.message);}},60000);pipelineTimer.unref();
let publicFillBusy=false;
async function publicFillTick(){if(publicFillBusy)return;publicFillBusy=true;try{await fillPendingPublicQuestions(db);await fillPendingFactQuestions(db);}catch(error){console.error('Public answer drafting:',error.message);}finally{publicFillBusy=false;}}
const publicFillTimer=setInterval(publicFillTick,60000);publicFillTimer.unref();setTimeout(publicFillTick,1500).unref();
let emailBusy=false;
const emailTimer=setInterval(async()=>{if(emailBusy)return;emailBusy=true;try{await sendBlockerEmails(db)}catch{console.error('Blocker notification delivery failed')}finally{emailBusy=false}},60000);emailTimer.unref();
const factsDiagnosticRuns=new Map();
const origin=process.env.PUBLIC_ORIGIN;if(!origin)throw Error('Set PUBLIC_ORIGIN');if(!process.env.REGISTRATION_CODE||process.env.REGISTRATION_CODE.length<24)throw Error('Set REGISTRATION_CODE to a random value of at least 24 characters');const attempts=new Map();const uploadDir=resolve(process.env.UPLOAD_DIR||'./data/resumes');const limit=6*1024*1024;
const send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))};
async function body(req,max=100000){let chunks=[],size=0;for await(let chunk of req){size+=chunk.length;if(size>max)throw Error('Request too large');chunks.push(chunk)}return Buffer.concat(chunks)}
const text=(v,max=500)=>String(v??'').trim().slice(0,max);
const ownJob=(uid,id)=>db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(id,uid);
function companyPolicyBlock(res,job,policy){
 if(policy.duplicate)markExactRequisitionDuplicate(db,job,policy);
 else deferForCompanyLimit(db,job,policy);
 send(res,409,{error:policy.message});return true;
}
function companyTransitionCheck(res,job){
 const policy=companyApplicationPolicy(db,job.applicant_id,job);
 return policy.allowed?false:companyPolicyBlock(res,job,policy);
}
function companyTransitionFailure(res,job,error){
 if(!isCompanyApplicationPolicyError(error))throw error;
 const current=db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id)||job;
 let policy=companyApplicationPolicy(db,current.applicant_id,current);
 if(policy.allowed)policy={...policy,allowed:false,duplicate:/Exact requisition/i.test(String(error.message||error)),message:String(error.message||error)};
 return companyPolicyBlock(res,current,policy);
}
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
 res.writeHead(200,{'content-type':path.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'"});res.end(await readFile(new URL(path.endsWith('.js')?'./web/setup.js':'./web/setup.html',import.meta.url)));return;
}
if(req.method==='GET'&&path==='/applypilot-local.zip'){const archive=await extensionArchive();res.writeHead(200,{'content-type':'application/zip','content-disposition':'attachment; filename="applypilot-local-0.6.26.zip"','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(archive);return;}
if(req.method==='GET'&&path==='/local-browser.html'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(await readFile(new URL('./web/local-browser.html',import.meta.url)));return;}
if(path==='/api/health')return send(res,200,{ok:true,release:'2026-10-06-profile-links',extensionVersion:'0.6.26',aiConfigured:!!(process.env.OPENAI_API_KEY&&process.env.OPENAI_MODEL),googleResearchConfigured:!!process.env.GEMINI_API_KEY});
if(path==='/api/register'&&req.method==='POST'){let input=JSON.parse(await body(req));if(input.registration_code!==process.env.REGISTRATION_CODE)return send(res,403,{error:'Registration code required'});let email=text(input.email,254).toLowerCase();if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return send(res,400,{error:'Valid email required'});let id=randomUUID(),hash=hashPassword(input.password);try{db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id,email,hash,now())}catch{return send(res,409,{error:'Account already exists'})}return send(res,201,{token:issueToken(id,input.remember===true)})}
if(path==='/api/login'&&req.method==='POST'){let address=req.socket.remoteAddress||'unknown',rate=attempts.get(address)||{count:0,at:Date.now()};if(Date.now()-rate.at>600000)rate={count:0,at:Date.now()};if(rate.count>=10)return send(res,429,{error:'Too many sign-in attempts. Try later.'});rate.count++;attempts.set(address,rate);let input=JSON.parse(await body(req)),u=db.prepare('SELECT * FROM users WHERE email=?').get(text(input.email,254).toLowerCase());if(!u||!verifyPassword(input.password,u.password_hash))return send(res,401,{error:'Invalid credentials'});attempts.delete(address);return send(res,200,{token:issueToken(u.id,input.remember===true)})}
let uid=readToken(req.headers.authorization?.replace(/^Bearer /i,''));if(!uid)return send(res,401,{error:'Sign in required'});

if(path==='/api/ai-status'&&req.method==='GET')return send(res,200,publicFillStatus(db,uid));
if(path==='/api/ai-facts-test'&&req.method==='POST'){
 const last=factsDiagnosticRuns.get(uid)||0;if(Date.now()-last<60000)return send(res,429,{error:'Wait one minute before testing again.'});
 const p=db.prepare('SELECT * FROM applicants WHERE user_id=? AND gemini_facts_consent=1 ORDER BY created_at LIMIT 1').get(uid);if(!p)return send(res,400,{error:'Enable Gemini professional-fact drafting in your saved profile first.'});
 factsDiagnosticRuns.set(uid,Date.now());try{return send(res,200,await draftAnswer({question:'Briefly describe your technical background and skills.',profile:p,job:{title:'Professional background check',company:''},answers:reusableAnswers(db,p)}));}catch(error){return send(res,400,{error:error.message});}
}
if(path==='/api/ai-test'&&req.method==='POST'){try{return send(res,200,await testPublicDrafting(db,uid));}catch(e){return send(res,400,{error:e.message});}}

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
const experienceRoute=path.match(/^\/api\/applicants\/([a-f0-9-]+)\/experience(?:\/([a-f0-9-]+))?$/);
if(experienceRoute){try{const [,applicant,id]=experienceRoute;if(!db.prepare('SELECT id FROM applicants WHERE id=? AND user_id=?').get(applicant,uid))return send(res,404,{error:'Profile not found.'});
 if(req.method==='GET'&&!id)return send(res,200,{facts:experienceFor(db,uid,applicant)});
 if(req.method==='DELETE'&&id){deleteExperience(db,uid,applicant,id);return send(res,200,{ok:true});}
 if(req.method==='POST'&&!id||req.method==='PUT'&&id){const result=saveExperience(db,uid,applicant,JSON.parse(await body(req)),id);db.prepare("UPDATE public_fill_attempts SET attempted_at='1970-01-01' WHERE state='needs_review' AND job_id IN (SELECT id FROM jobs WHERE user_id=? AND applicant_id=? AND local_attempt_at IS NULL)").run(uid,applicant);return send(res,200,result);}
 return send(res,405,{error:'Unsupported operation.'});
}catch(error){return send(res,400,{error:error.message});}}
const draftRoute=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/draft-answer$/);
if(draftRoute&&req.method==='POST'){try{const x=JSON.parse(await body(req));return send(res,200,await draftForJob(db,uid,draftRoute[1],x.question));}catch(e){return send(res,400,{error:e.message});}}
const researchRoute=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/research-answer$/);
if(researchRoute&&req.method==='POST'){try{const x=JSON.parse(await body(req));return send(res,200,await researchForJob(db,uid,researchRoute[1],x.question));}catch(e){return send(res,400,{error:e.message});}}
if(path==='/api/saved-answer-recovery'&&req.method==='GET')return send(res,200,savedRecoveryStatus(db,uid));
if(path==='/api/answer-library'&&req.method==='GET')return send(res,200,{answers:db.prepare('SELECT a.*,j.company,j.title FROM answer_history a JOIN jobs j ON j.id=a.job_id WHERE a.user_id=? ORDER BY a.updated_at DESC LIMIT 500').all(uid).map(a=>({...a,canReuse:canReuse(a.question)}))});
const libraryRoute=path.match(/^\/api\/answer-library\/([a-f0-9-]+)$/);
if(libraryRoute&&['PUT','DELETE'].includes(req.method)){try{if(req.method==='DELETE')deleteLibrary(db,uid,libraryRoute[1]);else{const x=JSON.parse(await body(req));updateLibrary(db,uid,libraryRoute[1],x.answer,x.reuse===true);}return send(res,200,{ok:true});}catch(e){return send(res,400,{error:e.message});}}
if(path==='/api/application-batch'&&['GET','POST'].includes(req.method)){try{if(req.method==='GET')return send(res,200,populateBatch(db,uid)||{enabled:false});const x=JSON.parse(await body(req));if(x.action==='next')return send(res,200,nextBatch(db,uid));if(x.action!=='reset')throw Error('Choose reset or next batch');const result=resetSupportBatch(db,uid,x);return send(res,200,result);}catch(e){return send(res,409,{error:e.message});}}
if(path==='/api/work-focus'&&['GET','PUT'].includes(req.method)){if(req.method==='PUT'&&batchPreferences(db,uid))return send(res,409,{error:'Batches of 20 are active. Use the batch controls.'});try{return send(res,200,req.method==='PUT'?setWorkFocus(db,uid,JSON.parse(await body(req))):ensureFocusedJob(db,uid));}catch(e){return send(res,409,{error:e.message});}}
if(path==='/api/chat'&&req.method==='POST')return send(res,200,await chat(uid,JSON.parse(await body(req))));
if(path==='/api/status'&&req.method==='GET'){const heartbeat=db.prepare('SELECT heartbeat FROM worker_status WHERE id=1').get()?.heartbeat;return send(res,200,{workerOnline:!!heartbeat&&Date.now()-Date.parse(heartbeat)<45000,heartbeat:heartbeat||null,queue:db.prepare("SELECT status,COUNT(*) AS count FROM jobs WHERE user_id=? AND status NOT IN ('duplicate','archived') GROUP BY status").all(uid)});}
const continuationCheck=job=>employerHold(db,job)?.message||(researchConsentWithdrawn(db,job.id,job.applicant_id)?'Drafting consent changed. Review saved answers before continuing.':'');
if(path==='/api/continuations'&&req.method==='GET')return send(res,200,{requests:listContinuations(db,uid)});
if(path==='/api/continuations/claim'&&req.method==='POST')return send(res,200,{request:claimContinuation(db,uid,continuationCheck)});
const continuationRoute=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/continuation$/);
if(continuationRoute){
 if(req.method==='POST')return send(res,200,requestContinuation(db,uid,continuationRoute[1],continuationCheck));
 if(req.method==='DELETE')return send(res,200,cancelContinuation(db,uid,continuationRoute[1]));
 if(req.method==='PUT'){const x=JSON.parse(await body(req));return send(res,200,settleContinuation(db,uid,continuationRoute[1],x.claimId,x.result));}
}

if(path==='/api/employer-limits'&&req.method==='GET')return send(res,200,{limits:employerLimits(db,uid)});
if(path==='/api/employer-limits'&&req.method==='POST'){const x=JSON.parse(await body(req));return send(res,200,recordEmployerLimit(db,uid,text(x.jobId,60),text(x.message,4000)));}
const heldRoute=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/(queue|continue|continuation|local\/(claim|packet|step|attempt|research-answer|answer)|handoff\/(open|click|drag|upload|text|key|resume))$/);
if(heldRoute&&(req.method==='POST'||heldRoute[2]==='local/packet'&&req.method==='GET')){
 const heldJob=ownJob(uid,heldRoute[1]),held=heldJob&&employerHold(db,heldJob);
 if(heldJob&&excludesFrench(db,uid)&&frenchApplication(heldJob)&&['queue','continue','local/claim'].includes(heldRoute[2]))return send(res,409,{error:'French-language applications are excluded by your preference.'});
 if(held&&!(heldRoute[2]==='local/packet'&&heldJob.local_attempt_at))return send(res,409,{error:held.message+' Applications to this employer are paused; other employers can continue.'});
 if(heldJob&&['queue','continue','local/claim','handoff/open'].includes(heldRoute[2])){
  const blocked=companyTransitionCheck(res,heldJob);if(blocked)return blocked;
 }
}
if(path==='/api/language-preference'&&req.method==='PUT'){const x=JSON.parse(await body(req));return send(res,200,setFrenchExclusion(db,uid,x.excludeFrench));}
if(path==='/api/pipeline'&&req.method==='GET'){const rows=db.prepare("SELECT * FROM jobs WHERE user_id=? AND status='saved'").all(uid),visible=splitApplicationCooldowns(db,uid,prioritizeApplications(db,uid,rows));return send(res,200,{...pipelineStatus(db,uid),found:visible.jobs.length,deferred:visible.deferred.length});}
if(path==='/api/pipeline'&&req.method==='PUT'){const x=JSON.parse(await body(req));try{return send(res,200,setPipeline(db,uid,x.enabled));}catch(error){return send(res,400,{error:error.message});}}
if(path==='/api/pipeline/queue-found'&&req.method==='POST')return send(res,200,queueFoundApplications(db,uid));

if(path==='/api/operations'&&req.method==='GET'){
 const rows=db.prepare("SELECT * FROM jobs WHERE user_id=? AND status NOT IN ('archived','duplicate','submitted','interview','rejected','offer')").all(uid);
 const {deferred}=splitApplicationCooldowns(db,uid,rows);
 return send(res,200,hideCooldownActions(operationSnapshot(db,uid),deferred.map(job=>job.id)));
}
if(path==='/api/activity'&&req.method==='GET')return send(res,200,{events:db.prepare('SELECT e.at,e.type,e.message,j.id AS job_id,j.title,j.company,j.applicant_id FROM events e JOIN jobs j ON j.id=e.job_id WHERE j.user_id=? AND j.status NOT IN (\'archived\',\'duplicate\') ORDER BY e.id DESC LIMIT 100').all(uid)});
if(path==='/api/me')return send(res,200,{email:db.prepare('SELECT email FROM users WHERE id=?').get(uid)?.email});
if(path==='/api/funnel'&&req.method==='GET')return send(res,200,funnelStatus(db,uid));
if(path==='/api/funnel'&&req.method==='POST'){const result=createFunnelBatch(db,uid,JSON.parse(await body(req,1100000)));setImmediate(funnelTick);return send(res,201,result);}
if(path==='/api/funnel/discovery'&&req.method==='POST'){const x=JSON.parse(await body(req)),result=enableWorldwideDiscovery(db,uid,x.applicant_id);setImmediate(()=>runSearch(result.id,uid).catch(error=>console.error('Worldwide discovery:',error.message)));return send(res,200,result);}
const funnelRetry=path.match(/^\/api\/funnel\/([a-f0-9-]+)\/retry$/);
if(funnelRetry&&req.method==='POST'){const result=retryFunnelItem(db,uid,funnelRetry[1]);setImmediate(funnelTick);return send(res,200,result);}
if(path==='/api/searches'&&req.method==='GET')return send(res,200,{intervalSeconds:SEARCH_INTERVAL_SECONDS,searches:db.prepare('SELECT * FROM searches WHERE user_id=? ORDER BY created_at DESC').all(uid).map(s=>({...s,boards:JSON.parse(s.boards_json),boards_json:undefined,last_result:s.last_result_json?JSON.parse(s.last_result_json):null,last_result_json:undefined}))});
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
if(path==='/api/applicants'&&req.method==='GET')return send(res,200,{applicants:db.prepare('SELECT id,user_id,name,email,phone,location,focus,execution_mode,answers_json,consent,ai_consent,google_research_consent,gemini_facts_consent,resume_path IS NOT NULL AS has_resume FROM applicants WHERE user_id=?').all(uid).map(p=>({...p,answers:JSON.parse(p.answers_json),reusableAnswers:{...reusableAnswers(db,p)},answers_json:undefined,user_id:undefined,resume_path:undefined}))});
if(path==='/api/applicants'&&req.method==='POST'){let x=JSON.parse(await body(req)),id=randomUUID();db.prepare('INSERT INTO applicants(id,user_id,name,email,phone,location,focus,answers_json,consent,ai_consent,google_research_consent,gemini_facts_consent,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,uid,text(x.name,150),text(x.email,254),text(x.phone,50),text(x.location,150),text(x.focus,300),JSON.stringify(x.answers||{}),x.consent===true?1:0,x.ai_consent===true?1:0,x.google_research_consent===true?1:0,x.gemini_facts_consent===true?1:0,now());db.prepare('UPDATE applicants SET execution_mode=? WHERE id=?').run(x.execution_mode==='local'?'local':'cloud',id);return send(res,201,{id})}
let m=path.match(/^\/api\/applicants\/([a-f0-9-]+)$/);if(m&&req.method==='PUT'){let x=JSON.parse(await body(req)),p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(m[1],uid);if(!p)return send(res,404,{error:'Applicant not found'});db.prepare('UPDATE applicants SET name=?,email=?,phone=?,location=?,focus=?,answers_json=?,consent=?,ai_consent=?,google_research_consent=?,gemini_facts_consent=? WHERE id=?').run(text(x.name,150),text(x.email,254),text(x.phone,50),text(x.location,150),text(x.focus,300),JSON.stringify(x.answers||{}),x.consent===true?1:0,x.ai_consent===true?1:0,x.google_research_consent===true?1:0,(x.gemini_facts_consent===undefined?!!p.gemini_facts_consent:x.gemini_facts_consent===true)?1:0,p.id);if(['local','cloud'].includes(x.execution_mode))db.prepare('UPDATE applicants SET execution_mode=? WHERE id=?').run(x.execution_mode,p.id);return send(res,200,{ok:true})}

const resumeEditRoute=path.match(/^\/api\/applicants\/([a-f0-9-]+)\/resume-edit$/);
if(resumeEditRoute&&req.method==='POST'){
 const x=JSON.parse(await body(req,100000));
 if(x.action==='preview')return send(res,200,await prepareResumeEdit(db,uid,resumeEditRoute[1],x.text));
 if(x.action==='save')return send(res,200,await saveResumeEdit(db,uid,resumeEditRoute[1],x.draftId,uploadDir));
 return send(res,400,{error:'Choose preview or save'});
}
const previousResumeRoute=path.match(/^\/api\/applicants\/([a-f0-9-]+)\/resume-previous$/);
if(previousResumeRoute&&req.method==='GET'){
 const file=previousResumePath(db,uid,previousResumeRoute[1]);
 if(!file)return send(res,404,{error:'No previous resume version is saved'});
 const bytes=await readFile(file),ext=extname(file).toLowerCase();
 return send(res,200,{name:'previous-resume'+ext,mime:ext==='.pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',base64:bytes.toString('base64')});
}

m=path.match(/^\/api\/applicants\/([a-f0-9-]+)\/resume$/);
if(m&&req.method==='GET'){
 const p=db.prepare('SELECT name,resume_path FROM applicants WHERE id=? AND user_id=?').get(m[1],uid);
 if(!p)return send(res,404,{error:'Applicant not found'});
 if(!p.resume_path)return send(res,404,{error:'No resume has been uploaded for this profile'});
 const bytes=await readFile(p.resume_path),ext=extname(p.resume_path).toLowerCase();if(bytes.length>limit)throw Error('Resume too large');
 let extracted='',previewNotice='';try{extracted=(await resumeText(p.resume_path,ext)).slice(0,100000);}catch{previewNotice='Text preview is unavailable. Download the original file to inspect it.';}
 return send(res,200,{name:'resume'+ext,applicant:p.name,mime:ext==='.pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:bytes.length,base64:bytes.toString('base64'),text:extracted,hasPrevious:!!previousResumePath(db,uid,m[1]),previewNotice});
}
if(m&&req.method==='POST'){let p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(m[1],uid);if(!p)return send(res,404,{error:'Applicant not found'});let kind=req.headers['content-type'],ext=kind==='application/pdf'?'.pdf':kind==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'?'.docx':null;if(!ext)return send(res,415,{error:'Use PDF or DOCX'});let bytes=await body(req,limit);if(bytes.length<100)return send(res,400,{error:'Resume appears empty'});if(ext==='.pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))return send(res,400,{error:'Invalid PDF'});if(ext==='.docx'&&!bytes.subarray(0,2).equals(Buffer.from('PK')))return send(res,400,{error:'Invalid DOCX'});await mkdir(uploadDir,{recursive:true,mode:0o700});let file=join(uploadDir,randomUUID()+ext);await writeFile(file,bytes,{mode:0o600});db.prepare('UPDATE applicants SET resume_path=? WHERE id=?').run(file,p.id);if(p.resume_path)await unlink(p.resume_path).catch(()=>{});let roles=[],instruction='',resumeNotice='';try{roles=await resumeRoles(file,ext);if(roles.length)instruction=createResumeSearch(uid,p,roles);else resumeNotice='No clear role titles found in the resume. Add a search manually.'}catch(e){console.error('Resume parsing:',e.message);resumeNotice='Resume saved, but its text could not be read. Add a search manually.'}return send(res,200,{ok:true,roles,instruction,resumeNotice})}
if(path==='/api/jobs'&&req.method==='GET'){const batch=populateBatch(db,uid);const focused=ensureFocusedJob(db,uid);const rows=db.prepare(`SELECT id,applicant_id,normalized_url,title,company,url,status,notes,confirmation,challenge,created_at,updated_at,required_fields_json,answers_json,handoff_available,local_phase,local_attempt_at,attempts,match_score,job_metadata_json,metadata_attempt_at,(SELECT COUNT(*) FROM manual_submit_clicks c WHERE c.job_id=jobs.id) AS manual_submit_clicks,CASE WHEN local_owner IS NULL AND EXISTS(SELECT 1 FROM work_focus f WHERE f.user_id=jobs.user_id AND f.enabled=1 AND f.auto_submit=1 AND f.job_id=jobs.id) THEN 'cloud' ELSE (SELECT execution_mode FROM applicants WHERE id=jobs.applicant_id) END AS execution_mode,(SELECT message FROM events WHERE job_id=jobs.id AND type IN ('paused','needs_review') ORDER BY id DESC LIMIT 1) AS blocker_message,(SELECT message FROM events WHERE job_id=jobs.id ORDER BY id DESC LIMIT 1) AS last_message FROM jobs WHERE user_id=? AND status NOT IN ('duplicate','archived') AND (NOT EXISTS(SELECT 1 FROM work_focus f WHERE f.user_id=jobs.user_id AND f.enabled=1) OR id=(SELECT job_id FROM work_focus f WHERE f.user_id=jobs.user_id) OR status IN ('submitted','interview','rejected','offer')) ORDER BY match_score DESC,discovery_priority,created_at DESC`).all(uid).filter(j=>!batch?.enabled||batch.job_ids.includes(j.id)||['submitted','interview','rejected','offer'].includes(j.status)).map(job=>{let questions=[];try{questions=JSON.parse(job.required_fields_json||'[]')}catch{}return {...job,official_careers:officialCareers(job),employer_hold:employerHold(db,{...job,user_id:uid}),metadata:metadataFor(job),editing_questions:db.prepare('SELECT question FROM answer_save_state WHERE job_id=? AND editing=1').all(job.id).map(r=>r.question),draft_needs:Object.fromEntries(db.prepare("SELECT question,json_extract(result_json,'$.reason') AS reason FROM professional_draft_cache WHERE job_id=? AND json_extract(result_json,'$.answer')=''").all(job.id).map(row=>[row.question,row.reason])),application_only_questions:[...new Set(questions.filter(question=>typeof question==='string'&&!canReuse(question)))]};});return send(res,200,{...splitApplicationCooldowns(db,uid,prioritizeApplications(db,uid,rows)),focus:focused,batch});}
if(path==='/api/jobs'&&req.method==='POST'){let x=JSON.parse(await body(req)),p=db.prepare('SELECT id FROM applicants WHERE id=? AND user_id=?').get(x.applicant_id,uid);if(!p)return send(res,400,{error:'Select your applicant profile'});let url=normalizeURL(x.url),id=randomUUID(),date=now();if(!supported(url))return send(res,400,{error:'Use a supported direct employer application link. Aggregator listings are not accepted.'});try{db.prepare('INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,uid,p.id,text(x.title,200),text(x.company,200),url,url,text(x.notes,2000),date,date)}catch{return send(res,409,{error:'Job already tracked for this applicant'})}event(id,'saved','Job added');return send(res,201,{id})}
// Local browser mode owns the application until a receipt is recorded.
let localRoute=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/local\/(claim|packet|progress|answer|research-answer|research-used|step|attempt|submitted|capture|assistance)$/);
if(localRoute){
 const j=ownJob(uid,localRoute[1]);if(!j)return send(res,404,{error:'Job not found'});
 const focus=db.prepare('SELECT job_id FROM work_focus WHERE user_id=? AND enabled=1').get(uid);if(focus&&focus.job_id!==j.id&&['claim','packet','step'].includes(localRoute[2]))return send(res,409,{error:'This application is parked while you work on one job at a time.'});
 if(!inActiveBatch(db,j)&&['claim','packet','step','answer'].includes(localRoute[2]))return send(res,409,{error:'This application is outside your active batch.'});
 const action=localRoute[2],owner=req.headers['x-applypilot-device'];
 if(typeof owner!=='string'||!/^[a-f0-9-]{36}$/.test(owner))return send(res,400,{error:'Update the extension and reconnect this browser'});
 if(action==='claim'&&req.method==='POST'){
  if(j.status==='local_browser'){
   if(j.local_owner&&j.local_owner!==owner)return send(res,409,{error:'This application belongs to another browser. Complete it there or record an employer receipt.'});
   if(researchConsentWithdrawn(db,j.id,j.applicant_id))return send(res,403,{error:'AI answer drafting consent was withdrawn'});
   db.prepare("UPDATE jobs SET local_owner=?,local_attempt_at=CASE WHEN local_owner IS NULL THEN COALESCE(local_attempt_at,?) ELSE local_attempt_at END WHERE id=?").run(owner,now(),j.id);
   const current=db.prepare('SELECT local_attempt_at FROM jobs WHERE id=?').get(j.id);
   return send(res,200,{ok:true,attempted:!!current.local_attempt_at,phase:j.local_phase});
  }
  if(!['saved','queued','paused','needs_review'].includes(j.status)||['Unconfirmed submission','Submission in progress'].includes(j.challenge))return send(res,409,{error:'Wait for the worker or check the employer receipt before opening a local application'});
  if(metadataFor(j).available===false)return send(res,409,{error:'This employer posting is no longer available. Choose a current match.'});
  if(!supported(j.url))return send(res,400,{error:'Use a supported direct employer application link'});
  const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,uid);
  if(!p?.consent||!p.email||!p.resume_path)return send(res,400,{error:'Applicant consent, email and resume required'});
  if(researchConsentWithdrawn(db,j.id,p.id))return send(res,403,{error:'AI answer drafting consent was withdrawn'});
  if(j.handoff_available){
   try{const r=await fetch('http://127.0.0.1:8081/'+j.id+'/close',{method:'POST',headers:{authorization:req.headers.authorization,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error();}
   catch{return send(res,409,{error:'Close the existing live session before switching to your browser'});}
  }
  let result;try{result=db.prepare("UPDATE jobs SET status='local_browser',handoff_available=0,challenge='Local browser',local_owner=?,local_phase='ready',updated_at=? WHERE id=? AND status=? AND COALESCE(challenge,'')=COALESCE(?,'')").run(owner,now(),j.id,j.status,j.challenge);}
  catch(error){companyTransitionFailure(res,j,error);return;}
  if(!result.changes)return send(res,409,{error:'Application changed. Refresh before continuing'});
  event(j.id,'local_browser','Opening in your browser. Cloud retries disabled for this application.');return send(res,200,{ok:true});
 }
 if(j.local_owner!==owner)return send(res,409,{error:'Application belongs to another browser'});
 if(['submitted','interview','rejected','offer'].includes(j.status)&&action==='attempt')return send(res,200,{ok:true,confirmed:true});
 if(j.status==='submitted'&&action==='submitted'&&employerReceipt(j.confirmation))return send(res,200,{ok:true});
 if(j.status!=='local_browser'&&!(j.status==='submitted'&&j.challenge==='Applicant reported submission'&&action==='submitted'))return send(res,409,{error:'This application is not active in your browser'});
 if(action==='assistance'&&req.method==='POST'){
   const x=JSON.parse(await body(req));
   if(!['human','tracking','partial'].includes(x.kind))return send(res,400,{error:'Unknown assistance record'});
   if(x.kind==='human'&&!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type='human_assistance'").get(j.id))event(j.id,'human_assistance','Applicant interacted with the employer form.');
   if(x.kind==='tracking'&&!j.local_attempt_at&&!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('completion_tracking','assistance_boundary','filled','human_assistance')").get(j.id))event(j.id,'completion_tracking','Form assistance tracking started before a fresh employer page.');
   if(x.kind==='partial'&&!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type IN ('completion_tracking','assistance_boundary')").get(j.id))event(j.id,'assistance_boundary','An existing employer page was reused; earlier assistance is unknown.');
   return send(res,200,{ok:true});
  }
  if(action==='capture'&&req.method==='POST'){const x=JSON.parse(await body(req)),fields=Array.isArray(x.fields)?x.fields.filter(f=>typeof f?.question==='string'&&!hasResearchDraftForQuestion(db,j.id,f.question.trim())&&!hasFactDraft(db,j.id,f.question.trim())):x.fields;return send(res,200,{saved:captureAnswers(db,j,fields)});}
 if(action==='packet'&&req.method==='GET'){
  const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,uid);
  if(!p?.consent)return send(res,403,{error:'Applicant consent required'});
  if(researchConsentWithdrawn(db,j.id,p.id))return send(res,403,{error:'AI answer drafting consent was withdrawn'});
  const bytes=await readFile(p.resume_path);if(bytes.length>limit)throw Error('Resume too large');
  const applicationAnswers=JSON.parse(j.answers_json||'{}');if(!p.google_research_consent)for(const [question,answer] of Object.entries(applicationAnswers))if(isResearchDraft(db,j.id,question,answer))delete applicationAnswers[question];
  return send(res,200,{autonomousSubmit:focusAllowsSubmit(db,j),job:{id:j.id,url:j.url,title:j.title,company:j.company,attempted:!!j.local_attempt_at,phase:j.local_phase},profile:{name:p.name,email:p.email,phone:p.phone,location:p.location},answers:{...reusableAnswers(db,p),...applicationAnswers},aiAssistance:!!((p.google_research_consent||p.gemini_facts_consent)&&process.env.GEMINI_API_KEY||p.ai_consent&&process.env.OPENAI_API_KEY&&process.env.OPENAI_MODEL),applicationOnlyQuestions:db.prepare('SELECT question FROM research_drafts WHERE job_id=? UNION SELECT question FROM fact_drafts WHERE job_id=?').all(j.id,j.id).map(row=>row.question),excludeFrench:excludesFrench(db,uid),resume:{name:'resume'+extname(p.resume_path),base64:bytes.toString('base64')}});
 }
 if(action==='answer'&&req.method==='POST'){
  const x=JSON.parse(await body(req));try{return send(res,200,await prepareFormAnswer(db,uid,j.id,x.question,{expectedOwner:owner,choices:x.choices,answerFormat:x.answerFormat==='number'?'number':'text',maxLength:Number.isInteger(x.maxLength)&&x.maxLength>0?Math.min(x.maxLength,4000):4000,fieldHelp:text(x.fieldHelp,2000),check:job=>{const focus=db.prepare('SELECT job_id FROM work_focus WHERE user_id=? AND enabled=1').get(uid);return focus&&focus.job_id!==job.id?'This application is parked.':employerHold(db,job)?.message||((policy=>policy.allowed?'':policy.message)(companyApplicationPolicy(db,job.applicant_id,job)))||'';}}));}catch(error){return send(res,400,{error:error.message});}
 }
 if(action==='research-answer'&&req.method==='POST'){
  const x=JSON.parse(await body(req)),question=text(x.question,4000);if(!question)return send(res,400,{error:'A public job-page question is required'});
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
  const x=JSON.parse(await body(req)),questions=Array.isArray(x.questions)?x.questions.filter(question=>typeof question==='string'&&question.trim()&&question.length<=4000).slice(0,100):[];
  if(!questions.length)return send(res,400,{error:'Research-backed fields required'});
  let marked=0;for(const question of questions)if(markResearchDraftUsed(db,j.id,question))marked++;
  if(!marked)return send(res,400,{error:'Research provenance not found for these fields'});
  if(researchConsentWithdrawn(db,j.id,j.applicant_id))return send(res,403,{error:'AI answer drafting consent was withdrawn'});
  return send(res,200,{marked});
 }
 if(action==='step'&&req.method==='POST'){
  const p=db.prepare('SELECT consent FROM applicants WHERE id=?').get(j.applicant_id);
  if(!p?.consent)return send(res,403,{error:'Applicant consent was withdrawn'});
  if(researchConsentWithdrawn(db,j.id,j.applicant_id))return send(res,403,{error:'AI answer drafting consent was withdrawn'});
  return send(res,200,{ok:true});
 }
 if(action==='attempt'&&req.method==='POST'){
  const x=JSON.parse(await body(req));
  if(applicationLimit(x.before)){recordEmployerLimit(db,uid,j.id,x.before,{source:'Employer page observed by browser helper'});return send(res,409,{error:'Employer application limit reached. Other employers can continue.'});}

  const p=db.prepare('SELECT consent FROM applicants WHERE id=?').get(j.applicant_id);
  if(!p?.consent)return send(res,403,{error:'Applicant consent was withdrawn'});
  if(researchConsentWithdrawn(db,j.id,j.applicant_id))return send(res,403,{error:'AI answer drafting consent was withdrawn'});
  if(typeof x.before!=='string'||!sameApplication(x.url,j.url)||employerReceipt(x.before))return send(res,409,{error:'Application requires human review before submission'});
  if(x.human!==true){if(submissionDeclaration(x.before))return send(res,409,{error:'The employer declaration needs your review and Submit click.'});if(x.automatic!==true)return send(res,409,{error:'A submission authorization is required.'});try{return send(res,200,reserveAutonomousAttempt(db,j.id,uid,owner));}catch(e){return send(res,409,{error:e.message});}}
  return send(res,200,recordManualSubmit(db,j,x.clickId||'legacy',x.humanAssisted===true));
 }
 if(action==='progress'&&req.method==='POST'){
  const x=JSON.parse(await body(req)),fields=Array.isArray(x.fields)?x.fields.filter(v=>typeof v==='string').slice(0,100).map(v=>text(v,4000)):[];
  saveFormProgress(db,j.id,x.progress);
  const message=text(x.message,500)||'Continue in your employer tab';
  if(excludesFrench(db,uid)&&frenchApplication({...j,language:x.formLanguage==='fr'?'fr':'',required_fields_json:JSON.stringify(fields)})){db.prepare('UPDATE jobs SET required_fields_json=?,job_metadata_json=? WHERE id=?').run(JSON.stringify(fields),JSON.stringify({...metadataFor(j),frenchApplication:true}),j.id);archiveFrench(db,uid);return send(res,200,{ok:true,excluded:true});}
  if(applicationLimit(message)){recordEmployerLimit(db,uid,j.id,message,{source:'Employer page reported by browser helper'});return send(res,200,{ok:true,held:true});}
  const held=employerHold(db,j);if(held)return send(res,409,{error:held.message});
   if(j.local_attempt_at)return send(res,200,{ok:true,awaitingReceipt:true});
   if(x.blocked===true&&!j.local_attempt_at&&!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type='assistance_boundary'").get(j.id))event(j.id,'assistance_boundary','The employer form paused for review; completion may need applicant assistance.');
  const previous=db.prepare("SELECT message FROM events WHERE job_id=? AND type='local_browser' ORDER BY id DESC LIMIT 1").get(j.id)?.message;
  db.prepare('UPDATE jobs SET required_fields_json=?,local_phase=?,updated_at=? WHERE id=?').run(JSON.stringify(fields),j.local_attempt_at?(x.blocked===true?'uncertain':'verifying'):x.blocked===true?'blocked':'ready',now(),j.id);
  if(message!==previous){event(j.id,'local_browser',message);if(Number.isInteger(x.filled)&&x.filled>0&&x.filled<=150)event(j.id,'filled','Filled '+x.filled+' saved fields in the employer browser');}return send(res,200,{ok:true});
 }
 if(action==='submitted'&&req.method==='POST'){
  const x=JSON.parse(await body(req)),receipt=text(x.receipt,300);
  if(applicationLimit(x.receipt)){recordEmployerLimit(db,uid,j.id,x.receipt,{source:'Employer response reported by browser helper'});return send(res,409,{error:'The employer limit message is not a submission receipt.'});}
  if(!j.local_attempt_at||!sameApplication(x.url,j.url)||x.afterSubmit!==true||!employerReceipt(receipt))return send(res,400,{error:'An employer receipt after submission is required'});
  db.prepare("UPDATE jobs SET status='submitted',confirmation=?,challenge=NULL,updated_at=? WHERE id=? AND (status='local_browser' OR status='submitted' AND challenge='Applicant reported submission')").run('Browser extension observed: '+receipt,now(),j.id);
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
  if(researchConsentWithdrawn(db,j.id,j.applicant_id))return send(res,403,{error:'AI answer drafting consent was withdrawn'});
  if(j.handoff_available)return send(res,200,{available:true});
  if(!['paused','needs_review'].includes(j.status)||['Unconfirmed submission','Submission in progress'].includes(j.challenge))return send(res,409,{error:'This application cannot restart until its submission status is checked'});
  const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,uid);
  if(!p?.consent||!p.email||!p.resume_path)return send(res,400,{error:'Applicant consent, email and resume required'});
  if(!supported(j.url))return send(res,400,{error:'Supported employer link required'});
  try{db.prepare("UPDATE jobs SET status='queued',challenge=NULL,updated_at=? WHERE id=? AND status IN ('paused','needs_review')").run(now(),j.id);}
  catch(error){companyTransitionFailure(res,j,error);return;}
  event(j.id,'queued','Preparing a live application browser for applicant takeover');return send(res,200,{preparing:true});
 }
 if(!j.handoff_available)return send(res,409,{error:'The live browser has expired or restarted. Reopen the application to prepare another.'});
 const input=await body(req,action==='upload'?9000000:20000);
 try{const response=await fetch('http://127.0.0.1:8081/'+j.id+'/'+action,{method:'POST',headers:{authorization:req.headers.authorization,'content-type':'application/json'},body:input.length?input:'{}',signal:AbortSignal.timeout(20000)});const result=await response.json();if(response.ok&&['click','drag','upload','text','key'].includes(action)&&!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type='human_assistance'").get(j.id))event(j.id,'human_assistance','Applicant interacted with the live employer form.');return send(res,response.status,result);}
 catch{return send(res,503,{error:'The live browser is unavailable. Check the worker status and try again.'})}
}
let continueRoute=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/continue$/);
if(continueRoute&&req.method==='POST'){
 const j=ownJob(uid,continueRoute[1]);if(!j)return send(res,404,{error:'Job not found'});
 if(j.handoff_available)return send(res,409,{error:'Use Take over and Resume worker to continue in the existing browser'});
 if(!['needs_review','paused'].includes(j.status)||['Unconfirmed submission','Submission in progress','CAPTCHA','Sign-in'].includes(j.challenge))return send(res,409,{error:'This application requires employer-site action before it can continue'});
 const p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,uid);
 if(!p?.consent||!p.email||!p.resume_path)return send(res,400,{error:'Applicant consent, email and resume required'});
 if(researchConsentWithdrawn(db,j.id,p.id))return send(res,403,{error:'AI answer drafting consent was withdrawn'});
 if(!supported(j.url))return send(res,400,{error:'A supported employer application link is required'});
 const x=JSON.parse(await body(req)),entries=Object.entries(x.answers||{});
 if(!entries.length||entries.length>100)return send(res,400,{error:'Enter the missing answers'});
 if(!p.google_research_consent&&entries.some(([question])=>hasResearchDraftForQuestion(db,j.id,question)))return send(res,403,{error:'AI answer drafting consent was withdrawn'});
 const answers=JSON.parse(j.answers_json||'{}');for(const [question,answer] of entries){if(typeof answer!=='string'||!question.trim()||question.length>4000||!answer.trim()||answer.length>4000)return send(res,400,{error:'Complete each answer (maximum 4,000 characters)'});Object.defineProperty(answers,question,{value:answer.trim(),enumerable:true,configurable:true,writable:true});}
 if(Object.keys(answers).length>100)return send(res,400,{error:'Answer limit reached'});
 let result;try{result=db.prepare("UPDATE jobs SET answers_json=?,status='queued',challenge=NULL,updated_at=? WHERE id=? AND status=? AND COALESCE(challenge,'')=COALESCE(?,'')").run(JSON.stringify(answers),now(),j.id,j.status,j.challenge);}
 catch(error){companyTransitionFailure(res,j,error);return;}
 if(!result.changes)return send(res,409,{error:'Application changed. Refresh to see its current status'});
 for(const [question] of entries)markResearchDraftUsed(db,j.id,question);
 if(x.remember===true)rememberAnswers(j.applicant_id,entries.filter(([q])=>canReuse(q.trim())&&!hasResearchDraftForQuestion(db,j.id,q.trim())&&!hasFactDraft(db,j.id,q.trim())));
 event(j.id,'queued','Missing answers saved; application queued to continue');return send(res,200,{ok:true});
}
let answerRoute=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/answers$/);
if(answerRoute){const j=ownJob(uid,answerRoute[1]);if(!j)return send(res,404,{error:'Job not found'});
 if(req.method==='GET')return send(res,200,{answers:JSON.parse(j.answers_json||'{}')});
 if(req.method==='PUT'){
  if(['running','queued','submitted','interview','rejected','offer','archived','duplicate'].includes(j.status))return send(res,409,{error:'Answers cannot change while queued, running or submitted'});
  const x=JSON.parse(await body(req)),question=text(x.question,4000),answer=text(x.answer,4000);
  if(!question||!answer)return send(res,400,{error:'Enter the exact question and your answer'});
  if(x.autosave===true&&!canCapture(question))return send(res,400,{error:'Complete this protected question directly with the employer.'});
  const answers=JSON.parse(j.answers_json||'{}');if(Object.keys(answers).length>=100&&!Object.hasOwn(answers,question))return send(res,400,{error:'Answer limit reached'});
  Object.defineProperty(answers,question,{value:answer,enumerable:true,configurable:true,writable:true});
  db.prepare('UPDATE jobs SET answers_json=?,updated_at=? WHERE id=?').run(JSON.stringify(answers),now(),j.id);
  markResearchDraftUsed(db,j.id,question);
  if(x.autosave===true)db.prepare('INSERT INTO answer_save_state VALUES(?,?,?) ON CONFLICT(job_id,question) DO UPDATE SET editing=excluded.editing').run(j.id,question,x.resume===true?0:1);
  const reusable=x.remember===true&&(!x.autosave||x.resume===true)&&canReuse(question)&&!hasResearchDraftForQuestion(db,j.id,question)&&!hasFactDraft(db,j.id,question);
  if(reusable)rememberAnswers(j.applicant_id,[[question,answer]]);
  event(j.id,'answer_saved',reusable?'Saved applicant-approved answer for reuse':'Saved an answer for this application');if(x.autosave===true&&x.resume===true){
   const latest=ownJob(uid,j.id),questions=JSON.parse(latest.required_fields_json||"[]"),a=JSON.parse(latest.answers_json||"{}");
   if(questions.length&&questions.every(q=>canCapture(q)&&a[q]?.trim())&&!db.prepare('SELECT 1 FROM answer_save_state WHERE job_id=? AND editing=1').get(j.id)&&!latest.local_attempt_at&&!["CAPTCHA","Sign-in","Sensitive action","Unconfirmed submission","Submission in progress","Upload needs review","Ready to submit"].includes(latest.challenge)){
    try{if(latest.status==="local_browser")requestContinuation(db,uid,j.id,continuationCheck);
    else if(["paused","needs_review"].includes(latest.status)&&!employerHold(db,latest)&&!researchConsentWithdrawn(db,latest.id,latest.applicant_id)){
     if(latest.handoff_available){fetch("http://127.0.0.1:8081/"+j.id+"/resume",{method:"POST",headers:{authorization:req.headers.authorization,"content-type":"application/json"},body:"{}",signal:AbortSignal.timeout(10000)}).catch(()=>{});}
     else if(db.prepare("SELECT consent FROM applicants WHERE id=?").get(latest.applicant_id)?.consent){db.prepare("UPDATE jobs SET status=?,challenge=NULL,updated_at=? WHERE id=? AND status=?").run("queued",now(),j.id,latest.status);event(j.id,"queued","All recorded answers autosaved; resuming preparation.");}
    }}catch{/* Answers remain saved when a browser or employer step cannot resume. */}
   }
  }return send(res,200,{ok:true,reusable});
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
m=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/queue$/);if(m&&req.method==='POST'){let j=ownJob(uid,m[1]);if(!j)return send(res,404,{error:'Job not found'});if(priorApplication(db,uid,j))return send(res,409,{error:'This role was already applied to or is in progress. Repeat application blocked.'});if(j.handoff_available)return send(res,409,{error:'Resume the existing live browser instead of queuing a duplicate attempt'});if(metadataFor(j).available===false)return send(res,409,{error:'This employer posting is no longer available. Choose a current match.'});if(!supported(j.url))return send(res,400,{error:'Add the direct employer application link before queuing'});if(['Unconfirmed submission','Submission in progress'].includes(j.challenge))return send(res,409,{error:'The employer may have received this application. Check the employer site and record confirmation before trying again.'});let p=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(j.applicant_id,uid);if(!p.consent||!p.email||!p.resume_path)return send(res,400,{error:'Applicant consent, email and resume required'});if(researchConsentWithdrawn(db,j.id,p.id))return send(res,403,{error:'AI answer drafting consent was withdrawn'});if(!['saved','needs_review','paused'].includes(j.status))return send(res,409,{error:'This job cannot be queued from its current state'});try{db.prepare("UPDATE jobs SET status='queued',challenge=NULL,updated_at=? WHERE id=?").run(now(),j.id);}catch(error){companyTransitionFailure(res,j,error);return;}event(j.id,'queued','Application queued');return send(res,200,{ok:true})}
m=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/confirm$/);if(m&&req.method==='POST'){let j=ownJob(uid,m[1]);if(!j)return send(res,404,{error:'Job not found'});if(['queued','running'].includes(j.status))return send(res,409,{error:'Wait until the worker finishes before recording a manual confirmation'});let x=JSON.parse(await body(req)),receipt=text(x.receipt,300);if(applicationLimit(x.receipt)){recordEmployerLimit(db,uid,j.id,x.receipt);return send(res,409,{error:'The employer limit message is not a submission receipt.'});}if(!employerReceipt(receipt)||/placeholder|example\.com|github\.com|not (?:yet )?(?:submitted|confirmed)|unconfirmed|simulat|test receipt/i.test(receipt))return send(res,400,{error:'Paste the employer message confirming that your application was received or submitted. Profile links and placeholders are not receipts.'});db.prepare("UPDATE jobs SET status='submitted',confirmation=?,challenge=NULL,updated_at=? WHERE id=?").run('Applicant verified: '+receipt,now(),j.id);confirmLibrary(db,j);event(j.id,'manual_confirmation','Applicant recorded employer confirmation: '+receipt);return send(res,200,{ok:true})}
m=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/report-submitted$/);if(m&&req.method==='POST'){const x=JSON.parse(await body(req));if(x.reported!==true)return send(res,400,{error:'Confirm that you already submitted this application.'});return send(res,200,recordReportedSubmission(db,uid,m[1]));}
m=path.match(/^\/api\/jobs\/([a-f0-9-]+)\/events$/);if(m&&req.method==='GET'){if(!ownJob(uid,m[1]))return send(res,404,{error:'Job not found'});return send(res,200,{events:db.prepare('SELECT at,type,message FROM events WHERE job_id=? ORDER BY id').all(m[1])})}
return send(res,404,{error:'Not found'});
}catch(e){console.error(e);return send(res,e.message==='Request too large'?413:400,{error:e.message||'Request failed'})}}).listen(Number(process.env.PORT||8080),process.env.BIND_HOST||'0.0.0.0',()=>console.log('ApplyPilot API listening'));
