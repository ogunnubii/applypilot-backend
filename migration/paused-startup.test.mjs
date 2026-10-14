import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,sep} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

test('actual app starts on loopback with paused background callbacks, no provider calls and no worker',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'applypilot-paused-startup-'));
 const startURL=new URL('../start.js',import.meta.url).href,dbURL=new URL('../db.js',import.meta.url).href;
 const wrapper=join(directory,'synthetic-startup.mjs');
 writeFileSync(wrapper,`
 import {Server} from 'node:http';
 import childProcess from 'node:child_process';
 import {syncBuiltinESMExports} from 'node:module';
 let network=0,workers=0;const callbacks=[];
 globalThis.fetch=async()=>{network++;throw Error('Provider/network calls disabled in synthetic startup test')};
 childProcess.spawn=()=>{workers++;throw Error('Worker launch disabled in synthetic startup test')};syncBuiltinESMExports();
 const interval=globalThis.setInterval,timeout=globalThis.setTimeout;
 globalThis.setInterval=(fn,ms)=>{callbacks.push(fn);return {unref(){}}};
 globalThis.setTimeout=(fn,ms)=>{callbacks.push(fn);return {unref(){}}};
 const listen=Server.prototype.listen;
 Server.prototype.listen=function(...args){this.once('listening',()=>process.send({listening:this.address()}));return listen.apply(this,args)};
 await import(${JSON.stringify(startURL)});
 globalThis.setInterval=interval;globalThis.setTimeout=timeout;
 const {db}=await import(${JSON.stringify(dbURL)});
 const before=db.prepare('SELECT total_changes() n').get().n;
 for(const callback of callbacks)await callback();
 const after=db.prepare('SELECT total_changes() n').get().n;
 process.send({verified:true,network,workers,callback_count:callbacks.length,background_changes:after-before});
 `);
 // Explicit environment: no inherited provider credentials, no real user profile,
 // no production data. The fixed identity values exist only in this child test.
 const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:directory,TMP:directory,DATABASE_PATH:join(directory,'fictional.sqlite'),UPLOAD_DIR:join(directory,'resumes'),SESSION_SECRET:'SYNTHETIC_STARTUP_SENTINEL_NOT_FOR_USE',REGISTRATION_CODE:'SYNTHETIC_ONLY',PUBLIC_ORIGIN:'http://localhost:8080',SERVICE_ORIGIN:'http://localhost:8080',PORT:'0',BIND_HOST:'127.0.0.1',LOCAL_BROWSER_ONLY:'true',APPLYPILOT_BACKGROUND_TASKS:'paused'};
 const child=fork(wrapper,[],{cwd:fileURLToPath(new URL('../',import.meta.url)),env,stdio:['ignore','pipe','pipe','ipc']});
 let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 try{
  const messages=await new Promise((accept,reject)=>{
   const messages=[];const timer=setTimeout(()=>reject(Error('synthetic startup timed out')),15000);
   child.on('error',error=>{clearTimeout(timer);reject(error)});
   child.on('exit',code=>{clearTimeout(timer);reject(Error('synthetic startup exited '+code+': '+output))});
   child.on('message',message=>{messages.push(message);if(messages.some(x=>x.verified)&&messages.some(x=>x.listening)){clearTimeout(timer);accept(messages)}});
  });
  const status=messages.find(x=>x.verified),address=messages.find(x=>x.listening).listening;
  assert.equal(address.address,'127.0.0.1');assert.equal(status.network,0);assert.equal(status.workers,0);assert.equal(status.background_changes,0);assert(status.callback_count>=5);
  const response=await fetch('http://127.0.0.1:'+address.port+'/api/health');assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
 }finally{
  if(child.exitCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped}
  const r=relative(resolve(tmpdir()),resolve(directory));assert(r&&!r.startsWith('..'+sep)&&r!=='..');rmSync(directory,{recursive:true,force:true});
 }
});
