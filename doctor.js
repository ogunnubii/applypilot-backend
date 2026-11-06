// Setup health check for the local program (ApplyPilot.cmd doctor). Reports
// what is configured and what will stop applications. It never prints a secret
// value: API keys are reported only as configured / not configured.
import {createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {EMPLOYMENT_KEYS} from './employment-answers.js';

export function doctorReport({env=process.env,db=null,version=process.versions.node}={}){
 const checks=[],add=(area,ok,detail,action='')=>checks.push({area,status:ok===true?'ok':ok===false?'action':'info',detail,action});
 const major=Number(String(version).split('.')[0]);
 add('Node.js',major>=24,'Node.js '+version,major>=24?'':'Install Node.js 24 or newer.');
 const port=Number(env.PORT||8080),origin=String(env.PUBLIC_ORIGIN||'');
 add('Local address',!origin||origin==='http://localhost:'+port,'Port '+port+(origin?' · '+origin:''),origin&&origin!=='http://localhost:'+port?'Run ApplyPilot.cmd restart -Port '+port+' to bring PUBLIC_ORIGIN in line.':'');
 add('Gemini',env.GEMINI_API_KEY?true:null,env.GEMINI_API_KEY?'API key configured (value hidden) · model '+(String(env.GEMINI_MODEL||'').trim()||'default'):'Not configured: routine professional questions need your saved answer.',env.GEMINI_API_KEY?'':'Optional: ApplyPilot.cmd gemini');
 add('Submission email',env.RESEND_API_KEY&&env.BLOCKER_EMAIL_FROM&&/^https:/.test(origin)?true:null,env.RESEND_API_KEY&&env.BLOCKER_EMAIL_FROM?'Sender configured (value hidden)':'No email sender: summaries are recorded but not sent.');
 if(!db){add('Database',false,'Not found','Start ApplyPilot once and create your account at /setup.');return checks;}
 const profiles=db.prepare("SELECT * FROM applicants WHERE execution_mode='local' ORDER BY created_at").all();
 add('Profiles',profiles.length>0,profiles.length+' local profile(s)',profiles.length?'':'Create a profile and choose My Windows browser.');
 for(const p of profiles){
  const label='Profile '+(p.name||p.id.slice(0,8));
  add(label+' · consent',!!p.consent,p.consent?'Consent recorded':'Consent not confirmed','Confirm consent in setup.');
  if(p.resume_path&&existsSync(p.resume_path)){const bytes=readFileSync(p.resume_path);add(label+' · resume',true,'resume'+(p.resume_path.match(/\.\w+$/)?.[0]||'')+' · '+Math.round(bytes.length/1024)+' KB · SHA-256 '+createHash('sha256').update(bytes).digest('hex').slice(0,16)+'…');}
  else add(label+' · resume',false,'No resume file','Upload your resume in setup.');
  add(label+' · Gemini drafting',p.gemini_facts_consent?(env.GEMINI_API_KEY?true:false):null,p.gemini_facts_consent?'Enabled for routine professional questions'+(env.GEMINI_API_KEY?'':' — but no API key'):'Off: professional questions need saved answers',p.gemini_facts_consent&&!env.GEMINI_API_KEY?'Run ApplyPilot.cmd gemini, or turn the profile option off.':'');
  let saved={};try{saved=JSON.parse(p.answers_json||'{}');}catch{}
  for(const [key,name] of [['canadaAuthorization','Authorized to work in Canada'],['canadaSponsorship','Visa sponsorship in Canada'],['foreignAuthorization','Authorized outside Canada'],['foreignSponsorship','Visa sponsorship outside Canada']]){
   const value=saved[EMPLOYMENT_KEYS[key]];
   add(label+' · '+name,value?true:null,value?'Saved: '+value:'Not set — questions about this stop and ask you (never guessed)');
  }
 }
 try{const scopes=db.prepare('SELECT COUNT(*) AS n FROM searches WHERE enabled=1 AND scope_json IS NOT NULL').get().n;add('Search scope',scopes>0,scopes+' enabled structured search(es)',scopes?'':'Save a structured search scope (roles, remote places, authorization).');}catch{}
 try{const a=db.prepare('SELECT running FROM autopilot_state').all();add('Start/Stop',null,a.length?(a.some(r=>r.running)?'Running':'Stopped'):'Not started yet');}catch{}
 try{
  const last=db.prepare('SELECT max(last_seen_at) AS at FROM browser_helper_checkins').get().at;
  add('Chrome helper',last&&Date.now()-Date.parse(last)<120000?true:null,last?'Last authenticated helper check-in '+last:'Waiting for the signed-in helper to check in');
 }catch{}
 try{
  const history=db.prepare('SELECT COUNT(*) AS n FROM external_application_history').get().n,holds=db.prepare('SELECT COUNT(*) AS n FROM history_employer_holds WHERE released_at IS NULL').get().n;
  add('Imported history',null,history+' protection record(s) (not counted as submissions) · '+holds+' active employer hold(s)');
 }catch{}
 try{
  const row=db.prepare(`SELECT
   SUM(status IN ('submitted','interview','rejected','offer') AND confirmation IS NOT NULL AND confirmation<>'') AS confirmed,
   SUM(local_attempt_at IS NOT NULL AND NOT (status IN ('submitted','interview','rejected','offer') AND confirmation IS NOT NULL AND confirmation<>'')) AS attempted,
   SUM(status='local_browser' AND local_phase='blocked' AND local_attempt_at IS NULL) AS blocked,
   SUM(status='local_browser' AND local_phase='prepared' AND local_attempt_at IS NULL) AS prepared FROM jobs`).get();
  add('Applications',null,`${row.confirmed||0} confirmed by employer receipt · ${row.attempted||0} submitted without a confirmed receipt · ${row.blocked||0} blocked · ${row.prepared||0} prepared`);
 }catch{}
 // LinkedIn/Indeed pipeline: where those jobs stop (counts and reasons only).
 try{
  const f=db.prepare('SELECT enabled,auto_submit,search_queue_only FROM work_focus').all();
  const auto=f.some(r=>r.enabled&&r.auto_submit);
  add('Automatic submit',auto?true:null,f.length?(auto?'On (one job at a time'+(f.some(r=>r.search_queue_only)?', saved-search queue':'')+')':'Off: jobs are prepared but not submitted'):'Not chosen yet',auto?'':'Choose “Apply automatically” for the saved-search queue in the dashboard.');
 }catch{}
 try{
  for(const [board,like] of [['LinkedIn','%linkedin.com/jobs/view/%'],['Indeed','%indeed.com/viewjob%']]){
   const jobs=db.prepare('SELECT status,local_attempt_at,confirmation,job_metadata_json FROM jobs WHERE url LIKE ?').all(like);
   if(!jobs.length){add(board,null,'No jobs added yet','Open a '+board+' job search page in Chrome (signed in) and click the ApplyPilot “Add … jobs” button. ApplyPilot does not crawl '+board+'.');continue;}
   let waiting=0,eligible=0,held=0,attempted=0,confirmed=0;const reasons=new Map();
   for(const j of jobs){let m={};try{m=JSON.parse(j.job_metadata_json||'{}');}catch{}
    if(['submitted','interview','rejected','offer'].includes(j.status)&&j.confirmation){confirmed++;continue;}
    if(j.local_attempt_at){attempted++;continue;}
    const c=m.listingCheck;if(!c){waiting++;continue;}
    if(c.eligible)eligible++;else{held++;const r=String(c.blocker||'held').replace(/\s+/g,' ').slice(0,90);reasons.set(r,(reasons.get(r)||0)+1);}
   }
   const top=[...reasons].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([r,n])=>n+'× '+r).join(' | ');
   add(board,null,`${jobs.length} added · ${waiting} waiting for listing check · ${eligible} eligible · ${held} held · ${attempted} submitted without receipt · ${confirmed} confirmed`+(top?' · top reasons: '+top:''),waiting&&!eligible?'Keep ApplyPilot running with Chrome open and helper 0.7.4 loaded; listings are checked about every 2 minutes per board.':'');
  }
 }catch{}
 return checks;
}
export function formatDoctor(checks){
 const mark={ok:'OK   ',action:'FIX  ',info:'INFO '};
 return checks.map(c=>mark[c.status]+c.area+': '+c.detail+(c.action?'\n       → '+c.action:'')).join('\n');
}
if(process.argv[1]&&import.meta.url.endsWith(process.argv[1].replace(/\\/g,'/').split('/').pop())){
 const path=process.env.DATABASE_PATH||'./data/applypilot.sqlite';
 let db=null;try{if(existsSync(path))db=new DatabaseSync(path,{readOnly:true});}catch{}
 const checks=doctorReport({db});console.log(formatDoctor(checks));db?.close();
 process.exitCode=checks.some(c=>c.status==='action')?1:0;
}
