import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

test('public-origin auth and both async API slices retain native state across a synthetic restart',async()=>{
 const root=mkdtempSync(join(tmpdir(),'applypilot-hosted-http-')),wrapper=join(root,'server.mjs');
 const url=name=>new URL('../'+name,import.meta.url).href;
 writeFileSync(wrapper,`
 import {Server} from 'node:http';
 import childProcess from 'node:child_process';
 import {syncBuiltinESMExports} from 'node:module';
 let workers=0,network=0;
 globalThis.fetch=async()=>{network++;throw Error('external calls blocked')};
 childProcess.spawn=()=>{workers++;throw Error('workers blocked')};syncBuiltinESMExports();
 const callbacks=[];globalThis.setInterval=fn=>{callbacks.push(fn);return {unref(){}}};globalThis.setTimeout=fn=>{callbacks.push(fn);return {unref(){}}};
 const {db}=await import(${JSON.stringify(url('db.js'))});
 const {hashPassword}=await import(${JSON.stringify(url('auth.js'))});
 db.prepare('INSERT OR IGNORE INTO users VALUES(?,?,?,?)').run('fictional','fictional@example.invalid',hashPassword('Synthetic-login-fixture-42'),'2026-01-01');
 db.prepare('INSERT OR IGNORE INTO applicants(id,user_id,name,created_at) VALUES(?,?,?,?)').run('11111111-1111-4111-8111-111111111111','fictional','Synthetic profile','2026-01-01');
 const listen=Server.prototype.listen;
 Server.prototype.listen=function(...args){this.once('listening',()=>process.send({port:this.address().port}));return listen.apply(this,args)};
 await import(${JSON.stringify(url('start.js'))});
 const before=db.prepare('SELECT total_changes() n').get().n;for(const callback of callbacks)await callback();
 process.send({checked:true,workers,network,background_changes:db.prepare('SELECT total_changes() n').get().n-before});
 `);
 const origin='https://fictional.onrender.com';
 const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:root,TMP:root,DATABASE_PATH:join(root,'synthetic.sqlite'),UPLOAD_DIR:join(root,'resumes'),SESSION_SECRET:'SYNTHETIC_HTTP_SESSION_SENTINEL_ONLY',REGISTRATION_CODE:'SYNTHETIC_ONLY',PUBLIC_ORIGIN:origin,SERVICE_ORIGIN:origin,PORT:'0',BIND_HOST:'127.0.0.1',LOCAL_BROWSER_ONLY:'true',APPLYPILOT_BACKGROUND_TASKS:'paused',PUBLIC_SIGNUP:'false'};
 let child;
 async function start(){
  child=fork(wrapper,[],{cwd:fileURLToPath(new URL('../',import.meta.url)),env,stdio:['ignore','ignore','ignore','ipc']});
  const status=await new Promise((accept,reject)=>{
   let port,checked;const timer=setTimeout(()=>reject(Error('synthetic HTTP startup timeout')),15000);
   child.once('error',error=>{clearTimeout(timer);reject(error)});child.once('exit',()=>{clearTimeout(timer);reject(Error('synthetic HTTP child stopped'))});
   child.on('message',m=>{if(m.port)port=m.port;if(m.checked)checked=m;if(port&&checked){clearTimeout(timer);accept({port,...checked})}});
  });
  assert.equal(status.network,0);assert.equal(status.workers,0);assert.equal(status.background_changes,0);return 'http://127.0.0.1:'+status.port;
 }
 async function stop(){if(child?.exitCode===null){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended}child=undefined}
 try{
  let base=await start();
  const allowed=await fetch(base+'/api/health',{headers:{Origin:origin}});assert.equal(allowed.status,200);assert.equal(allowed.headers.get('access-control-allow-origin'),origin);
  assert.equal((await fetch(base+'/api/health',{headers:{Origin:'https://untrusted.invalid'}})).status,403);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:origin,'content-type':'application/json'},body:JSON.stringify({email:'fictional@example.invalid',password:'Synthetic-login-fixture-42'})});
  assert.equal(login.status,200);const {token}=await login.json();assert.equal(typeof token,'string');
  const first=await fetch(base+'/api/me',{headers:{Origin:origin,Authorization:'Bearer '+token}});assert.equal(first.status,200);assert.equal((await first.json()).user.id,'fictional');
  const api=async(path,method='GET',body)=>{
   const result=await fetch(base+path,{method,headers:{Origin:origin,Authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
   return {status:result.status,body:await result.json()};
  };
  assert.equal((await fetch(base+'/api/notifications',{headers:{Origin:origin}})).status,401);
  assert.equal((await api('/api/notifications')).body.enabled,false);
  assert.equal((await api('/api/notifications','PUT',{enabled:true})).body.enabled,true);
  assert.equal((await api('/api/notifications','PUT',null)).status,400);
  const experience='/api/applicants/11111111-1111-4111-8111-111111111111/experience';
  const saved=await api(experience,'POST',{approved:true,title:'Synthetic project',details:'Fictional professional experience for regression verification.'});
  assert.equal(saved.status,200);assert.equal((await api(experience)).body.facts[0].id,saved.body.id);
  assert.equal((await api(experience+'/'+saved.body.id,'PUT',{approved:true,title:'Updated synthetic project',details:'Updated fictional experience for regression verification.'})).status,200);
  await stop();base=await start();
  const after=await fetch(base+'/api/me',{headers:{Origin:origin,Authorization:'Bearer '+token}});assert.equal(after.status,200);assert.equal((await after.json()).user.id,'fictional');
  assert.equal((await api('/api/notifications')).body.enabled,true);
  assert.equal((await api(experience)).body.facts[0].title,'Updated synthetic project');
  assert.equal((await api(experience+'/'+saved.body.id,'DELETE')).status,200);
  assert.deepEqual((await api(experience)).body.facts,[]);
 }finally{await stop();const r=relative(resolve(tmpdir()),resolve(root));assert(r&&!r.startsWith('..'+sep)&&r!=='..');rmSync(root,{recursive:true,force:true})}
});
