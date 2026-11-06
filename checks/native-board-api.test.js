// Isolated API checks for LinkedIn/Indeed native applications. Temporary
// SQLite database and fixture resume; no job board or employer is contacted.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {normalizeSearchScope} from '../search-scope.js';

test('native board API: canonical job, posting gate, one reserved attempt, employer-specific receipt, separate source counts',{timeout:40000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'applypilot-native-'));process.env.DATABASE_PATH=join(dir,'test.sqlite');process.env.SESSION_SECRET=randomUUID()+randomUUID();
 const {db}=await import('../db.js'),{issueToken}=await import('../auth.js');
 const resume=join(dir,'fixture.pdf');writeFileSync(resume,'%PDF-1.4 synthetic resume');
 db.exec("INSERT INTO users VALUES('u','fixture@example.test','fixture','2026')");
 db.prepare("INSERT INTO applicants(id,user_id,name,email,phone,location,resume_path,consent,execution_mode,focus,created_at,ai_consent,gemini_facts_consent,google_research_consent) VALUES('p','u','Fixture','fixture@example.test','+1 416 555 0100','Thornhill, Ontario, Canada',?,1,'local','Site Reliability Engineer','2026',1,1,1)").run(resume);
 const scope=normalizeSearchScope({roles:['Site Reliability Engineer'],localPlaces:[],remotePlaces:['canada','thornhill'],remoteFromCountry:'canada',authorizedCountries:['canada'],preferBusinessContract:true,allowEmploymentFallback:false,minimumAnnualCAD:60000});
 db.prepare("INSERT INTO searches(id,user_id,applicant_id,instruction,scope_json,boards_json,enabled,created_at) VALUES('s','u','p','Fixture',?,'[]',1,'2026')").run(JSON.stringify(scope));
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:resolve('.'),env:{...process.env,PORT:String(port),BIND_HOST:'127.0.0.1',PUBLIC_ORIGIN:base,GEMINI_API_KEY:'',OPENAI_API_KEY:'',OPENAI_MODEL:''},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);const exited=new Promise(r=>child.once('exit',r));
 const api=async(path,method='GET',data)=>{const r=await fetch(base+'/api'+path,{method,signal:AbortSignal.timeout(5000),headers:{Authorization:'Bearer '+issueToken('u'),'Content-Type':'application/json','X-ApplyPilot-Device':'11111111-1111-1111-1111-111111111111'},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,data:await r.json()};};
 const LI='https://www.linkedin.com/jobs/view/4012345678';
 const b2b='Remote within Canada. Engagement: B2B contract with an incorporated consultant. C2C accepted.';
 const page=over=>({url:LI+'/?trk=fixture',title:'Senior Site Reliability Engineer',company:'Acme Cloud',location:'Canada',workplace:'remote',description:b2b,salaryText:'$120K/yr - $150K/yr',postedText:'2 days ago',applicantsText:'18 applicants',signals:['Actively recruiting'],nativeApply:true,external:false,...over});
 try{
  let ready=false;for(let i=0;i<60;i++){try{if((await api('/health')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert(ready,log);
  assert.equal((await api('/notifications','PUT',{submissionEmail:'not-an-email'})).status,400);
  const recipient=await api('/notifications','PUT',{submissionEmail:'JJWorks81@gmail.com'});assert.equal(recipient.status,200);assert.equal(recipient.data.submissionEmail,'jjworks81@gmail.com');
  assert.equal(db.prepare("SELECT enabled FROM notification_preferences WHERE user_id='u'").get()?.enabled??0,0,'blocker emails unchanged');
  const created=await api('/jobs','POST',{applicant_id:'p',url:LI+'/?refId=abc&trackingId=def'});assert.equal(created.status,201,JSON.stringify(created.data));
  const id=created.data.id;assert.equal(db.prepare('SELECT url FROM jobs WHERE id=?').get(id).url,LI);
  assert.equal((await api('/jobs','POST',{applicant_id:'p',url:LI+'/?refId=other'})).status,409,'same LinkedIn job id is one job');
  assert.equal((await api('/jobs','POST',{applicant_id:'p',url:'https://www.linkedin.com/jobs/search/?currentJobId=4012345678'})).status,400,'search pages are not jobs');
  assert.equal((await api('/work-focus','PUT',{enabled:true,auto_submit:true})).data.job_id,id,'unchecked native job is selectable; its eligibility is unknown, not assumed');
  assert.equal((await api('/jobs/'+id+'/local/claim','POST',{})).status,200);
  const packet=(await api('/jobs/'+id+'/local/packet')).data;assert.equal(packet.aiAssistance,false,'no Gemini key configured');assert.equal(packet.nativeBoard,'linkedin');
  assert.equal((await api('/jobs/'+id+'/local/research-answer','POST',{question:'Why do you want to work at Acme Cloud?'})).status,403);
  const draft=(await api('/jobs/'+id+'/local/answer','POST',{question:'Describe your experience operating Kubernetes in production.'})).data;assert.equal(draft.answer,'');assert.match(draft.reason,/Gemini/,'without a key: save the answer or configure Gemini');
  const held=(await api('/jobs/'+id+'/local/answer','POST',{question:'Will you now or in the future require visa sponsorship?'})).data;assert.equal(held.answer,'');
  const attempt=()=>api('/jobs/'+id+'/local/attempt','POST',{url:LI+'/',before:'Review your application',automatic:true,human:false,clickId:randomUUID()});
  const early=await attempt();assert.equal(early.status,409);assert.match(early.data.error,/fresh eligible/);
  const hybridResponse=await api('/jobs/'+id+'/local/posting','POST',page({workplace:'hybrid'})),hybrid=hybridResponse.data;assert.equal(hybrid.eligible,false,JSON.stringify(hybridResponse));assert.match(hybrid.blocker,/remote/);
  assert.equal((await attempt()).status,409);
  const low=(await api('/jobs/'+id+'/local/posting','POST',page({salaryText:'$40K/yr - $50K/yr'}))).data;assert.equal(low.eligible,false);assert.match(low.blocker,/CAD 60,000/);
  const ok=(await api('/jobs/'+id+'/local/posting','POST',page())).data;assert.equal(ok.eligible,true,ok.blocker);assert.equal(ok.rank.payCurrency,'CAD');assert.equal(ok.rank.payAnnualMax,150000);
  const saved=db.prepare('SELECT title,company,job_metadata_json FROM jobs WHERE id=?').get(id);assert.equal(saved.company,'Acme Cloud');assert.equal(JSON.parse(saved.job_metadata_json).foundVia,'linkedin');
  const granted=await attempt();assert.equal(granted.status,200,JSON.stringify(granted.data));assert.equal(granted.data.permitted,true);
  assert.equal((await attempt()).status,409,'one durable submit attempt per job');
  assert.equal((await api('/jobs/'+id+'/local/posting','POST',page())).status,409,'no re-check after an attempt');
  const wrong=await api('/jobs/'+id+'/local/submitted','POST',{url:LI+'/',afterSubmit:true,receipt:'Your application was sent to Globex!'});assert.equal(wrong.status,400);
  const right=await api('/jobs/'+id+'/local/submitted','POST',{url:LI+'/',afterSubmit:true,receipt:'Your application was sent to Acme Cloud!'});assert.equal(right.status,200,JSON.stringify(right.data));
  const ops=(await api('/operations')).data;assert.equal(ops.bySource.linkedin.confirmed,1);assert.equal(ops.bySource.direct.confirmed,0);assert.equal(ops.bySource.indeed.confirmed,0);
  // Cross-source duplicate: the same employer role on the employer's own board is blocked.
  const gh='https://boards.greenhouse.io/acmecloud/jobs/123',ghId=randomUUID();
  db.prepare("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,created_at,updated_at) VALUES(?,'u','p','Senior Site Reliability Engineer','Acme Cloud',?,?,'saved','2026','2026')").run(ghId,gh,gh);
  assert.equal((await api('/jobs/'+ghId+'/queue','POST',{})).status,409,'already applied through LinkedIn');
 }finally{child.kill();await exited;db.close();}
});
