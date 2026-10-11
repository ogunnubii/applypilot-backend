import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {normalizeSearchScope,scopeIntent} from '../search-scope.js';
import {jobIntelligence} from '../job-intelligence.js';
test('real campaign API gives Chrome manual preparation packets, prevents other queue execution and measures filled evidence',{timeout:40000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'applypilot-preparation-'));process.env.DATABASE_PATH=join(dir,'test.sqlite');process.env.SESSION_SECRET=randomUUID()+randomUUID();
 const {db}=await import('../db.js'),{issueToken}=await import('../auth.js');
 const resume=join(dir,'fixture.pdf');writeFileSync(resume,'%PDF-1.4 synthetic resume');
 db.exec("INSERT INTO users VALUES('u','fixture@example.test','fixture','2026');INSERT INTO users VALUES('other','other@example.test','fixture','2026')");
 db.prepare("INSERT INTO applicants(id,user_id,name,email,resume_path,consent,execution_mode,focus,created_at) VALUES('p','u','Fixture','fixture@example.test',?,1,'cloud','Platform Engineer','2026')").run(resume);
 const scope=normalizeSearchScope({roles:['Platform Engineer'],localPlaces:[],remotePlaces:['canada'],remoteFromCountry:'canada',authorizedCountries:['canada'],allowEmploymentFallback:true});
 db.prepare("INSERT INTO searches(id,user_id,applicant_id,instruction,scope_json,boards_json,enabled,created_at) VALUES('s','u','p','Fixture',?,'[]',1,'2026')").run(JSON.stringify(scope));
 const ids=[];for(let i=0;i<22;i++){const id=randomUUID(),url='https://jobs.lever.co/company'+i+'/'+id;ids.push(id);const metadata=jobIntelligence({title:'Platform Engineer',remote:true,location:'Remote Canada',description:'Full-time employment. Remote within Canada.'},scopeIntent(scope));db.prepare("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,created_at,updated_at,job_metadata_json) VALUES(?,'u','p','Platform Engineer',?,?,?,'saved','2026','2026',?)").run(id,'company'+i,url,url,JSON.stringify(metadata));}
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:resolve('.'),env:{...process.env,PORT:String(port),BIND_HOST:'127.0.0.1',PUBLIC_ORIGIN:base},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);const exited=new Promise(r=>child.once('exit',r));
 const api=async(path,method='GET',data,user='u')=>{const r=await fetch(base+'/api'+path,{method,signal:AbortSignal.timeout(5000),headers:{Authorization:'Bearer '+issueToken(user),'Content-Type':'application/json','X-ApplyPilot-Device':'11111111-1111-1111-1111-111111111111'},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,data:await r.json()};};
 try{
  let ready=false;for(let i=0;i<60;i++){try{if((await api('/health')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert(ready,log);
  const campaign=await api('/preparation-campaign','POST',{applicant_id:'p',target:200,batch_size:20});assert.equal(campaign.status,200,JSON.stringify(campaign));assert.equal(campaign.data.selected,20);
  const listing=await api('/jobs');assert.equal(listing.status,200);assert.equal(listing.data.jobs.filter(j=>j.preparation).length,20);assert(listing.data.jobs.filter(j=>j.preparation).every(j=>j.execution_mode==='local'));assert.equal(db.prepare("SELECT execution_mode FROM applicants WHERE id='p'").get().execution_mode,'cloud');
  const job=listing.data.jobs.find(j=>j.preparation),outside=listing.data.jobs.find(j=>!j.preparation);
  assert.equal((await api('/jobs/'+outside.id+'/local/claim','POST',{})).status,409);
  assert.equal((await api('/jobs/'+job.id+'/local/claim','POST',{})).status,200);
  const packet=await api('/jobs/'+job.id+'/local/packet');assert.equal(packet.status,200);assert.equal(packet.data.prepareSteps,true);assert.equal(packet.data.autonomousSubmit,false);
  assert.equal((await api('/work-focus','PUT',{enabled:true,auto_submit:true})).status,409);
  assert.equal((await api('/jobs/'+job.id+'/local/attempt','POST',{automatic:true,human:false,clickId:randomUUID(),url:job.url,before:'Fixture'})).status,409);
  const progress=await api('/jobs/'+job.id+'/local/progress','POST',{readyForSubmit:true,url:job.url,blocked:true,fields:[],filled:3,message:'Ready to submit',progress:{required:3,filled:3}});assert.equal(progress.status,200,JSON.stringify(progress));
  const counts=(await api('/preparation-campaign')).data;assert.equal(counts.prepared,1);assert.equal(counts.ready,1);assert.equal(counts.completed,0);
  assert.equal((await api('/preparation-campaign','GET',undefined,'other')).data.enabled,false);
  assert.equal((await api('/jobs/'+job.id+'/local/packet','GET',undefined,'other')).status,404);
  assert.equal((await api('/preparation-campaign','PUT',{enabled:false})).status,200);
  assert.equal((await api('/jobs/'+job.id+'/local/packet')).data.prepareSteps,false);
 }finally{child.kill();await exited;db.close();}
});

