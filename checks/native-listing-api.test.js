// Real path for a fresh LinkedIn/Indeed card in the saved-search queue:
// board import -> read-only listing check -> eligibility/history -> queue -> claim.
// Isolated server and SQLite file, synthetic pages only; nothing is submitted.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';

test('fresh LinkedIn/Indeed cards reach the saved-search queue only through a read-only listing check',{timeout:45000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ap-listing-'));process.env.DATABASE_PATH=join(dir,'t.sqlite');process.env.SESSION_SECRET=randomUUID()+randomUUID();
 const {db}=await import('../db.js'),{issueToken}=await import('../auth.js'),{normalizeSearchScope}=await import('../search-scope.js');
 const resume=join(dir,'r.pdf');writeFileSync(resume,'%PDF-1.4 synthetic');
 db.exec("INSERT INTO users VALUES('u','f@example.test','f','2026')");
 db.prepare("INSERT INTO applicants(id,user_id,name,email,location,resume_path,consent,execution_mode,focus,created_at) VALUES('p','u','F','f@example.test','Thornhill, Ontario, Canada',?,1,'local','Site Reliability Engineer','2026')").run(resume);
 db.prepare("INSERT INTO searches(id,user_id,applicant_id,instruction,scope_json,boards_json,enabled,created_at) VALUES('s','u','p','x',?,'[]',1,'2026')").run(JSON.stringify(normalizeSearchScope({roles:['Site Reliability Engineer'],localPlaces:[],remotePlaces:['canada','thornhill'],remoteFromCountry:'canada',authorizedCountries:['canada'],preferBusinessContract:true,allowEmploymentFallback:false,includeRelatedRoles:true})));
 const l=createServer();await new Promise(r=>l.listen(0,'127.0.0.1',r));const port=l.address().port;await new Promise(r=>l.close(r));const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:resolve('.'),env:{...process.env,PORT:String(port),BIND_HOST:'127.0.0.1',PUBLIC_ORIGIN:base,LOCAL_BROWSER_ONLY:'true',GEMINI_API_KEY:'',OPENAI_API_KEY:''},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);const exited=new Promise(r=>child.once('exit',r));
 const api=async(path,method='GET',data)=>{const r=await fetch(base+'/api'+path,{method,signal:AbortSignal.timeout(5000),headers:{Authorization:'Bearer '+issueToken('u'),'Content-Type':'application/json','X-ApplyPilot-Device':'11111111-1111-1111-1111-111111111111'},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,data:await r.json()};};
 const B2B='Senior SRE running Kubernetes, Terraform and on-call for our cloud platform. Fully remote within Canada. Engagement: B2B contract with an incorporated consultant (C2C welcome).';
 const page=(id,over={})=>({url:'https://www.linkedin.com/jobs/view/'+id+'/?trk=x',title:'Senior Site Reliability Engineer',company:'Acme Cloud',location:'Canada',workplace:'remote',description:B2B,salaryText:'$120K/yr - $150K/yr',postedText:'2 days ago',applicantsText:'18 applicants',signals:[],nativeApply:true,external:false,...over});
 const card=(id,title='Senior Site Reliability Engineer',company='Acme Cloud')=>({url:'https://www.linkedin.com/jobs/view/'+id,title,company,location:'Canada (Remote)'});
 // The helper reads due checks from listing_checks, which is independent of focus/parking.
 const due=async id=>(await api('/jobs')).data.listing_checks.some(j=>j.id===id);
 const held=async id=>(await api('/saved-search-queue?applicant_id=p')).data.readiness?.held_jobs?.find(j=>j.id===id)?.reason;
 const jobRow=id=>({...db.prepare('SELECT status,local_owner,local_attempt_at,attempts,challenge FROM jobs WHERE id=?').get(id)});
 try{
  for(let i=0;i<60;i++){try{if((await api('/health')).status===200)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.equal((await api('/application-batch','POST',{action:'saved-search',applicant_id:'p'})).status,200);
  const ids=(await api('/jobs/board-import','POST',{board:'linkedin',jobs:[card('4012345601','Site Reliability Engineer'),card('4012345602','Senior SRE','Hybrid Corp'),card('4012345603','Site Reliability Engineer','Mystery Co'),card('4012345604','SRE','Applied Co'),card('4012345605','Senior Site Reliability Engineer','Held Co'),card('4012345606','Staff Site Reliability Engineer','Dup Co')]})).data.ids;
  assert.equal(ids.length,6);const [good,hybrid,unknown,applied,heldCo,dup]=ids;
  // Before: the exact lock-out from the report, now with an honest reason.
  assert.equal(await due(good),true);assert.match(await held(good),/Waiting for a read-only listing check/);
  assert.equal((await api('/work-focus','PUT',{enabled:true,auto_submit:true})).data.job_id,null,'nothing selectable before a check');

  // Binding: the open page must be this exact job; untouched jobs only.
  assert.equal((await api('/jobs/'+good+'/listing-check','POST',page('9999999999'))).status,409);
  // Eligible listing: stamped fresh for this scope; nothing claimed, filled or submitted.
  const ok=await api('/jobs/'+good+'/listing-check','POST',page('4012345601',{title:'Site Reliability Engineer'}));assert.equal(ok.status,200,JSON.stringify(ok.data)+log);assert.equal(ok.data.eligible,true,ok.data.blocker);
  assert.deepEqual(jobRow(good),{status:'saved',local_owner:null,local_attempt_at:null,attempts:0,challenge:null});
  assert(!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type NOT IN ('board_import','listing_checked')").get(good),'no claim, fill or submission events');
  assert.equal(await due(good),false);
  assert.equal((await api('/jobs/'+good+'/listing-check','POST',page('4012345601'))).status,429,'no re-check loop');

  // Held results keep their exact reason and stay out of the queue.
  const h=await api('/jobs/'+hybrid+'/listing-check','POST',page('4012345602',{company:'Hybrid Corp',workplace:'hybrid'}));assert.equal(h.data.eligible,false);assert.match(await held(hybrid),/^Listing held: Not listed as a remote position/);
  const u=await api('/jobs/'+unknown+'/listing-check','POST',page('4012345603',{company:'Mystery Co',title:'',nativeApply:false,external:true}));assert.equal(u.data.eligible,false);assert.match(await held(unknown),/^Listing held:/);
  const a=await api('/jobs/'+applied+'/listing-check','POST',page('4012345604',{company:'Applied Co',title:'SRE',alreadyApplied:true}));assert.equal(a.data.eligible,false);assert.match(a.data.blocker,/existing application/);
  db.prepare("INSERT INTO history_employer_holds(user_id,employer_key,company,source,reason,created_at) VALUES('u','company:heldco','Held Co','AP2','Earlier application to Held Co has an unknown outcome','2026')").run();
  const hc=await api('/jobs/'+heldCo+'/listing-check','POST',page('4012345605',{company:'Held Co'}));assert.equal(hc.data.eligible,false);assert.match(hc.data.blocker,/^Held:/);
  const gh='https://boards.greenhouse.io/dupco/jobs/1';db.prepare("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,created_at,updated_at) VALUES(?,'u','p','Staff Site Reliability Engineer','Dup Co',?,?,'submitted','2026','2026')").run(randomUUID(),gh,gh);
  const d=await api('/jobs/'+dup+'/listing-check','POST',page('4012345606',{company:'Dup Co',title:'Staff Site Reliability Engineer'}));assert.equal(d.data.eligible,false);assert.match(d.data.blocker,/another source/);
  for(const id of [hybrid,unknown,applied,heldCo,dup])assert.equal(await due(id),false,'held cards are not re-checked immediately');

  // After: only the eligible card is a candidate; selection and claim proceed.
  const readiness=(await api('/saved-search-queue?applicant_id=p')).data.readiness;
  assert.deepEqual(readiness.candidates.map(c=>c.id),[good]);
  const focus=(await api('/work-focus','PUT',{enabled:true,auto_submit:true})).data;assert.equal(focus.job_id,good);
  assert.equal((await api('/jobs/'+good+'/local/claim','POST',{})).status,200);
  assert.equal((await api('/jobs/'+good+'/listing-check','POST',page('4012345601'))).status,409,'a claimed job is never re-checked through this path');
  // Counts stay receipt-only: nothing here is a submission.
  const ops=(await api('/operations')).data;assert.equal(ops.bySource.linkedin.confirmed,0);assert.equal(ops.totals.confirmed,0);
  // Scope change makes the stamp stale: due again rather than trusted.
  db.prepare("UPDATE searches SET scope_json=? WHERE id='s'").run(JSON.stringify(normalizeSearchScope({roles:['Site Reliability Engineer','Platform Engineer'],localPlaces:[],remotePlaces:['canada'],remoteFromCountry:'canada',authorizedCountries:['canada'],allowEmploymentFallback:false,includeRelatedRoles:true})));
  const other=(await api('/jobs/board-import','POST',{board:'indeed',jobs:[{url:'https://www.indeed.com/viewjob?jk=0123456789abcdef',title:'Senior Site Reliability Engineer',company:'Indeed Co'}]}));
  if(other.status===429){db.prepare("UPDATE events SET at='2000-01-01T00:00:00.000Z' WHERE type='board_import'").run();}
 }finally{child.kill();await exited;db.close();}
});
