import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID,createHmac} from 'node:crypto';

test('public signup, existing owner preservation, tenant boundaries and durable logout',{timeout:45000},async()=>{
 // All names, contacts and resume markers below are synthetic fixtures in a temporary database.
 const ownerPassword=randomUUID(),newPassword=randomUUID();
 const dir=mkdtempSync(join(tmpdir(),'applypilot-accounts-'));
 process.env.DATABASE_PATH=join(dir,'test.sqlite');process.env.SESSION_SECRET=randomUUID()+randomUUID();
 const {db}=await import('../db.js'),{issueToken,hashPassword,verifyPassword,readToken}=await import('../auth.js');
 const {installAccounts,allowAuthAttempt,authClientAddress}=await import('../account-security.js');installAccounts(db);
 const owner=randomUUID(),profile=randomUUID(),job=randomUUID(),answer=randomUUID(),search=randomUUID(),resume=join(dir,'owner.pdf');
 writeFileSync(resume,'%PDF-1.4\nPRIVATE ORIGINAL OWNER RESUME');
 db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(owner,'owner@example.test',hashPassword(ownerPassword),'2026');
 db.prepare("INSERT INTO applicants(id,user_id,name,email,resume_path,answers_json,created_at) VALUES(?,?,?,?,?,'{\"Phone\":\"PRIVATE OWNER PHONE\"}','2026')").run(profile,owner,'Original Owner','owner@example.test',resume);
 db.prepare("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,created_at,updated_at) VALUES(?,?,?,'Private Role','Private Company','https://jobs.lever.co/private/role','https://jobs.lever.co/private/role','saved','2026','2026')").run(job,owner,profile);
 db.prepare("INSERT INTO searches(id,user_id,applicant_id,instruction,boards_json,enabled,created_at) VALUES(?,?,?,'private search','[]',0,'2026')").run(search,owner,profile);
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const base='http://127.0.0.1:'+port;let child,log='';
 const api=async(path,{token,method='GET',data,raw,headers={}}={})=>{const response=await fetch(base+path,{method,signal:AbortSignal.timeout(5000),headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json',...headers},body:raw??(data===undefined?undefined:JSON.stringify(data))});const body=await response.text();let result;try{result=JSON.parse(body);}catch{result=body;}return {status:response.status,data:result,headers:response.headers};};
 const stop=async()=>{if(child?.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}};
 const start=async()=>{child=spawn(process.execPath,['server.js'],{cwd:resolve('.'),env:{...process.env,PORT:String(port),BIND_HOST:'127.0.0.1',PUBLIC_ORIGIN:base,PUBLIC_SIGNUP:'true'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);for(let i=0;i<80;i++){try{if((await api('/api/health')).status===200)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error(log);};
 try{
  await start();
  assert.equal((await api('/api/health')).data.release,'2026-10-11-draft-citations');
  const dashboard=await api('/assistant'),csp=dashboard.headers.get('content-security-policy');
  assert.match(csp,/img-src 'self' data:;/);assert.match(csp,/script-src 'self';/);assert.match(csp,/connect-src 'self';/);assert.doesNotMatch(csp,/script-src[^;]*(?:data:|unsafe-inline|unsafe-eval|\*)/);
  const homepage=await api('/');assert.equal(homepage.status,200);assert.equal(homepage.headers.get('x-robots-tag'),'index, follow');assert.match(homepage.data,/<h1[ >]/);
  const sitemap=await api('/sitemap.xml');assert.equal(sitemap.status,200);assert(!/\/(?:assistant|signup|login|setup|api)\b/.test(sitemap.data));
  db.prepare("INSERT INTO answer_history(id,user_id,applicant_id,job_id,question,answer,updated_at) VALUES(?,?,?,?,'Phone','PRIVATE OWNER PHONE','2026')").run(answer,owner,profile,job);
  const ownerToken=issueToken(owner);
  const preferencePath='/api/searches/'+search+'/preferences',preferenceScope={roles:['Platform Engineer'],aliases:['SRE'],localPlaces:['ontario'],remotePlaces:['canada'],remoteWorldwide:true,remoteFromCountry:'canada',authorizedCountries:['canada'],preferBusinessContract:true,allowEmploymentFallback:true,preferRemote:false};
  assert.equal((await api(preferencePath,{method:'PUT',data:{preferRemote:true}})).status,401);
  assert.equal((await api(preferencePath,{token:ownerToken,method:'PUT',data:{preferRemote:true}})).status,400,'legacy scope cannot be silently replaced');
  db.prepare('UPDATE searches SET scope_json=? WHERE id=?').run(JSON.stringify(preferenceScope),search);
  const preferences=await api(preferencePath,{token:ownerToken,method:'PUT',data:{preferRemote:true}});
  assert.equal(preferences.status,200);assert.equal(preferences.data.scope.preferRemote,true);assert.deepEqual(preferences.data.scope.roles,preferenceScope.roles);assert.deepEqual(preferences.data.scope.authorizedCountries,['canada']);
  assert.equal(db.prepare('SELECT enabled FROM searches WHERE id=?').get(search).enabled,0,'ranking never enables paused discovery');
  assert.equal((await api(preferencePath,{token:ownerToken,method:'PUT',data:{preferRemote:'false'}})).status,400);
  assert.equal((await api(preferencePath,{token:ownerToken,method:'PUT',data:{preferRemote:false,authorizedCountries:['usa']}})).status,400,'ranking cannot change applicant eligibility');
  assert.equal(JSON.parse(db.prepare('SELECT scope_json FROM searches WHERE id=?').get(search).scope_json).preferRemote,true,'rejected changes leave ranking intact');
  for(const path of ['/api/me','/api/applicants','/api/jobs','/api/answer-library','/api/applicants/'+profile+'/resume'])assert.equal((await api(path)).status,401,path);
  assert.equal((await api('/api/signup',{method:'POST',data:{email:'bad',password:'short'}})).status,400);
  assert.equal((await api('/api/signup',{method:'POST',raw:'{"email":'})).status,400,'interrupted payload creates no account');
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n,1);
  const signup=await api('/api/signup',{method:'POST',data:{email:' New@Example.Test ',password:newPassword}});assert.equal(signup.status,201,JSON.stringify(signup));
  const token=signup.data.token,uid=signup.data.user.id;assert.notEqual(uid,owner);assert.equal(signup.data.user.email,'new@example.test');assert.equal(signup.data.user.emailVerified,false);
  for(const table of ['applicants','jobs','searches','work_focus','application_batch_preferences','notification_preferences'])assert.equal(db.prepare('SELECT COUNT(*) n FROM '+table+' WHERE user_id=?').get(uid).n,0,'new account has no copied data or automatically enabled work: '+table);
  assert.equal((await api('/api/me',{token})).data.user.id,uid);
  assert.equal((await api('/api/notifications',{token,method:'PUT',data:{enabled:true}})).status,403,'unverified public account cannot opt into email');
  const notificationState=await api('/api/notifications',{token});assert.equal(notificationState.data.emailVerificationRequired,true);assert.equal(notificationState.data.enabled,false);assert.equal(notificationState.data.configured,false);
  assert.equal((await api('/api/notifications',{token:ownerToken,method:'PUT',data:{enabled:true}})).status,200,'existing owner notification permissions preserved');
  assert.equal((await api('/api/notifications',{token:ownerToken,method:'PUT',data:{enabled:false}})).status,200);

  assert.equal((await api('/api/signup',{method:'POST',data:{email:'NEW@example.test',password:newPassword}})).status,409);
  assert.equal((await api('/api/login',{method:'POST',data:{email:'new@example.test',password:'wrong'}})).status,401);
  assert.equal((await api('/api/login',{method:'POST',data:{email:'new@example.test',password:{bad:true}}})).status,401);
  const login=await api('/api/login',{method:'POST',data:{email:'new@example.test',password:newPassword,remember:true}});assert.equal(login.status,200);assert.notEqual(login.data.token,token);
  for(const [path,key]of [['/api/applicants','applicants'],['/api/jobs','jobs'],['/api/answer-library','answers'],['/api/searches','searches'],['/api/activity','events'],['/api/application-history','records']]){const r=await api(path,{token});assert.equal(r.status,200,path);assert.deepEqual(r.data[key],[],path);}
  assert.equal((await api(preferencePath,{token,method:'PUT',data:{preferRemote:false}})).status,404,'another account cannot change search ranking');
  for(const [path,method,data]of [
   ['/api/applicants/'+profile,'PUT',{name:'Intruder'}],['/api/applicants/'+profile+'/resume','GET'],['/api/applicants/'+profile+'/resume','POST',{}],['/api/applicants/'+profile+'/resume-previous','GET'],['/api/applicants/'+profile+'/experience','GET'],
   ['/api/jobs/'+job+'/events','GET'],['/api/jobs/'+job+'/answers','PUT',{question:'Phone',answer:'Stolen'}],['/api/jobs/'+job+'/queue','POST',{}],['/api/jobs/'+job+'/local/claim','POST',{}],['/api/jobs/'+job+'/local/packet','GET'],['/api/jobs/'+job+'/handoff/view','POST',{}],['/api/searches/'+search+'/toggle','POST',{}]
  ])assert.equal((await api(path,{token,method,data})).status,404,path);
  for(const [path,method,data]of [['/api/answer-library/'+answer,'PUT',{answer:'Stolen',reuse:true}],['/api/answer-library/'+answer,'DELETE',{}],['/api/jobs','POST',{applicant_id:profile,url:'https://jobs.lever.co/x/y'}],['/api/searches','POST',{applicant_id:profile,instruction:'test'}]])assert((await api(path,{token,method,data})).status>=400,path);
  assert.equal(db.prepare('SELECT name FROM applicants WHERE id=?').get(profile).name,'Original Owner');assert.equal(db.prepare('SELECT resume_path FROM applicants WHERE id=?').get(profile).resume_path,resume);assert.equal(db.prepare('SELECT answer FROM answer_history WHERE id=?').get(answer).answer,'PRIVATE OWNER PHONE');
  assert.equal((await api('/api/applicants/'+profile+'/resume',{token:ownerToken})).status,200);
  assert.throws(()=>db.prepare('UPDATE jobs SET user_id=? WHERE id=?').run(uid,job),/does not belong/);
  assert.throws(()=>db.prepare('UPDATE searches SET user_id=? WHERE id=?').run(uid,search),/does not belong/);
  assert.equal((await api('/api/me',{token:issueToken('nonexistent')})).status,401);
  const payload=Buffer.from(JSON.stringify({id:uid,expires:Date.now()-60000})).toString('base64url'),expired=payload+'.'+createHmac('sha256',process.env.SESSION_SECRET).update(payload).digest('base64url');
  assert.equal((await api('/api/me',{token:expired})).status,401);assert.equal(readToken(token+'.extra'),null);assert.equal(verifyPassword('abc','malformed'),false);
  for(const path of ['/assistant','/signup','/login','/setup','/api/me'])assert.match((await api(path,{token})).headers.get('x-robots-tag'),/noindex/);
  assert.equal((await api('/api/logout',{token,method:'POST',data:{}})).status,200);
  assert.equal((await api('/api/me',{token})).status,401);
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for(const char of alphabet){const variant=token.slice(0,-1)+char;assert.equal(readToken(variant,db),null,'alternate signature encoding must not bypass logout');}
  assert.equal((await api('/api/me',{token:login.data.token})).status,200,'logout revokes only current session');
  await stop();await start();assert.equal((await api('/api/me',{token})).status,401,'logout survives server restart');assert.equal((await api('/api/me',{token:ownerToken})).status,200,'existing signed session survives additive upgrade');
  const proxyRequest={socket:{remoteAddress:'::ffff:10.0.0.1'},headers:{'x-forwarded-for':'198.51.100.7, 203.0.113.9'}};
  assert.equal(authClientAddress(proxyRequest,{}),'10.0.0.1','forwarding headers ignored by default');
  assert.equal(authClientAddress(proxyRequest,{AUTH_TRUSTED_PROXY_IPS:'10.0.0.1'}),'203.0.113.9','nearest untrusted address wins, not attacker-controlled first value');
  assert.equal(authClientAddress(proxyRequest,{AUTH_TRUSTED_PROXY_IPS:'10.0.0.1,203.0.113.9'}),'198.51.100.7');
  assert.equal(authClientAddress({...proxyRequest,headers:{'x-forwarded-for':'spoofed'}},{AUTH_TRUSTED_PROXY_IPS:'10.0.0.1'}),'10.0.0.1');
  assert.throws(()=>authClientAddress(proxyRequest,{AUTH_TRUSTED_PROXY_IPS:'*'}),/exact proxy IP/);
  for(let i=0;i<12;i++)assert(allowAuthAttempt(db,'unit-rate-ip','rate@example.test'));assert.equal(allowAuthAttempt(db,'unit-rate-ip','rate@example.test'),false);
 }finally{await stop();db.close();rmSync(dir,{recursive:true,force:true});}
});
