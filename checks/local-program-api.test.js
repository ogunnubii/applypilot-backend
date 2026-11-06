// Local Windows program checks against an isolated server and SQLite file.
// Synthetic data only; no job board or employer is contacted.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';

test('local program: persisted Start/Stop, board import with cross-source dedup, profile/history import with uncertain-attempt protection',{timeout:40000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'applypilot-local-'));process.env.DATABASE_PATH=join(dir,'test.sqlite');process.env.SESSION_SECRET=randomUUID()+randomUUID();
 const {db}=await import('../db.js'),{issueToken}=await import('../auth.js');
 const resume=join(dir,'fixture.pdf');writeFileSync(resume,'%PDF-1.4 synthetic resume');
 db.exec("INSERT INTO users VALUES('u','fixture@example.test','fixture','2026')");
 db.prepare("INSERT INTO applicants(id,user_id,name,email,phone,location,resume_path,consent,execution_mode,focus,answers_json,created_at) VALUES('p','u','Fixture','fixture@example.test','','Thornhill, Ontario, Canada',?,1,'local','Site Reliability Engineer',?,'2026')").run(resume,JSON.stringify({'Are you legally entitled to work in Canada?':'Yes'}));
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));const base='http://127.0.0.1:'+port;
 const start=()=>{const child=spawn(process.execPath,['server.js'],{cwd:resolve('.'),env:{...process.env,PORT:String(port),BIND_HOST:'127.0.0.1',PUBLIC_ORIGIN:base,LOCAL_BROWSER_ONLY:'true'},stdio:['ignore','pipe','pipe']});child.log='';child.stdout.on('data',x=>child.log+=x);child.stderr.on('data',x=>child.log+=x);child.exited=new Promise(r=>child.once('exit',r));return child;};
 const api=async(path,method='GET',data)=>{const r=await fetch(base+'/api'+path,{method,signal:AbortSignal.timeout(5000),headers:{Authorization:'Bearer '+issueToken('u'),'Content-Type':'application/json','X-ApplyPilot-Device':'11111111-1111-1111-1111-111111111111'},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,data:await r.json()};};
 const ready=async child=>{for(let i=0;i<60;i++){try{if((await api('/health')).status===200)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error(child.log);};
 let child=start();
 try{
  await ready(child);
  // Start/Stop: unset by default (existing behavior), persisted, and it drives queueing.
  assert.deepEqual((await api('/autopilot')).data,{configured:false,running:null,updatedAt:null,source:null});
  const started=(await api('/autopilot','PUT',{running:true})).data;assert.equal(started.running,true);assert.equal(started.pipeline.enabled,true);
  assert.equal((await api('/autopilot','PUT',{running:'yes'})).status,400);
  const stopped=(await api('/autopilot','PUT',{running:false,source:'extension'})).data;assert.equal(stopped.running,false);assert.equal(stopped.pipeline.enabled,false);assert.equal(stopped.source,'extension');
  assert.equal((await api('/pipeline','PUT',{enabled:true})).status,409,'cannot re-enable queueing while stopped');
  // Restart the program: the stopped state is remembered.
  child.kill();await child.exited;child=start();await ready(child);
  assert.equal((await api('/autopilot')).data.running,false);

  // An earlier direct application (Greenhouse) for the same employer role.
  const gh='https://boards.greenhouse.io/acmecloud/jobs/123',ghId=randomUUID();
  db.prepare("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,created_at,updated_at) VALUES(?,'u','p','Senior Site Reliability Engineer','Acme Cloud',?,?,'submitted','2026','2026')").run(ghId,gh,gh);
  // Board import: one click from a results page; canonical ids; repeats blocked.
  const cards=[{url:'https://www.linkedin.com/jobs/view/4012345678/?trk=x',title:'Senior Site Reliability Engineer',company:'Acme Cloud',location:'Canada (Remote)'},{url:'https://www.linkedin.com/jobs/view/4012345679',title:'Platform Engineer',company:'Globex',location:'Canada (Remote)'},{url:'https://www.indeed.com/viewjob?jk=0123456789abcdef',title:'x',company:'y'},{url:'https://evil.example/jobs/view/1'}];
  const first=(await api('/jobs/board-import','POST',{board:'linkedin',jobs:cards})).data;
  assert.deepEqual({added:first.added,existing:first.existing,duplicates:first.duplicates,rejected:first.rejected},{added:1,existing:0,duplicates:1,rejected:2});
  const added=db.prepare('SELECT url,status,job_metadata_json FROM jobs WHERE id=?').get(first.ids[0]);
  assert.equal(added.url,'https://www.linkedin.com/jobs/view/4012345679');assert.equal(added.status,'saved');assert.equal(JSON.parse(added.job_metadata_json).foundVia,'linkedin-search');
  assert.equal(db.prepare("SELECT status FROM jobs WHERE url='https://www.linkedin.com/jobs/view/4012345678'").get().status,'duplicate','already applied directly');
  assert.equal((await api('/jobs/board-import','POST',{board:'linkedin',jobs:cards})).status,429,'paced');
  db.prepare("UPDATE events SET at='2000-01-01T00:00:00.000Z' WHERE type='board_import'").run();
  const again=(await api('/jobs/board-import','POST',{board:'linkedin',jobs:cards.slice(0,2)})).data;assert.equal(again.added,0);assert.equal(again.existing,2);
  assert.equal((await api('/jobs/board-import','POST',{board:'monster',jobs:cards})).status,400);

  // Profile and history import.
  const bundle={profile:{name:'Ignored Because Set',phone:'+1 416 555 0100',answers:{'Are you legally entitled to work in Canada?':'No','Do you require sponsorship?':'No'}},
   applications:[{company:'Initech',title:'Cloud Engineer',status:'submitted',url:'https://jobs.lever.co/initech/aaaa-1111',appliedAt:'2026-10-20',confirmation:'Thanks for applying'},
    {company:'Hooli',title:'DevOps Engineer',status:'uncertain',url:'https://www.indeed.com/viewjob?jk=fedcba9876543210&from=serp',notes:'Browser closed after Submit'}]};
  const imported=(await api('/import','POST',{bundle})).data;
  assert.equal(imported.applicant,'p');assert.deepEqual(imported.updatedFields,['phone']);assert.equal(imported.answersAdded,1);
  assert.deepEqual(imported.answerConflicts.map(c=>c.field).sort(),['Are you legally entitled to work in Canada?','name'],'saved facts are never overwritten');
  const p=db.prepare("SELECT phone,answers_json FROM applicants WHERE id='p'").get();assert.equal(p.phone,'+1 416 555 0100');assert.equal(JSON.parse(p.answers_json)['Are you legally entitled to work in Canada?'],'Yes');
  assert.equal(imported.history.added,2);
  const statuses=Object.fromEntries(db.prepare("SELECT company,status FROM external_application_history WHERE user_id='u'").all().map(r=>[r.company,r.status]));assert.deepEqual(statuses,{Initech:'applied',Hooli:'uncertain'});
  // The uncertain attempt blocks the same posting by link even with a different title, and it never counts as confirmed.
  const later=(await api('/jobs','POST',{applicant_id:'p',url:'https://ca.indeed.com/viewjob?jk=FEDCBA9876543210',title:'Senior DevOps Engineer (Remote)',company:'Hooli'})).data;
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(later.id).status,'duplicate');
  assert.equal((await api('/jobs/'+later.id+'/queue','POST',{})).status>=400,true);
  const ops=(await api('/operations')).data;assert.equal(ops.bySource.indeed.confirmed,0);
  // Re-importing an "uncertain" record never downgrades a confirmed one.
  await api('/import','POST',{bundle:{applications:[{company:'Initech',title:'Cloud Engineer',status:'uncertain'}]}});
  assert.equal(db.prepare("SELECT status FROM external_application_history WHERE company='Initech'").get().status,'applied');
  for(const bad of [{},{applications:[{company:'A',title:'B',status:'maybe'}]},{applications:[{company:'A',title:'B',url:'http://insecure.example/job'}]}])assert.equal((await api('/import','POST',{bundle:bad})).status,400,JSON.stringify(bad));
 }finally{child.kill();await child.exited;db.close();}
});
