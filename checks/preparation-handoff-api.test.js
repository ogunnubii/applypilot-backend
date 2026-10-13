import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';

test('handoff requires existing authentication, isolates accounts and preserves same-origin policy',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'handoff-api-'));process.env.DATABASE_PATH=join(dir,'test.sqlite');process.env.SESSION_SECRET=randomUUID()+randomUUID();
 const {db}=await import('../db.js'),{issueToken}=await import('../auth.js');
 db.exec("INSERT INTO users VALUES('u','fixture@example.test','fixture','2026'),('other','other@example.test','fixture','2026'); INSERT INTO applicants(id,user_id,name,created_at) VALUES('p','u','Fictional Applicant','2026')");
 const url='https://job-boards.greenhouse.io/fictional/jobs/200';
 db.prepare("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,notes,created_at,updated_at) VALUES('excluded','u','p','Fictional Engineer','Fictional Company',?,?,'archived','SECRET ANSWER','2026','2026')").run(url,url);
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:resolve('.'),env:{...process.env,PORT:String(port),BIND_HOST:'127.0.0.1',PUBLIC_ORIGIN:base},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);const exited=new Promise(r=>child.once('exit',r));
 const call=(path,{user='u',origin,body}={})=>fetch(base+path,{method:body?'POST':'GET',headers:{...(user?{authorization:'Bearer '+issueToken(user)}:{}),...(origin?{origin}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 try{
  let ready=false;for(let i=0;i<80;i++){try{if((await call('/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert(ready,log);
  const before=db.prepare('SELECT * FROM jobs').all();
  assert.equal((await call('/api/preparation-handoff/ledger',{user:null})).status,401);
  assert.equal((await call('/api/preparation-handoff/ledger',{origin:'http://127.0.0.1:17780'})).status,403,'AP2 cannot directly call authenticated APIs');
  const ledger=await (await call('/api/preparation-handoff/ledger')).json();assert.equal(ledger.records.length,1);assert.doesNotMatch(JSON.stringify(ledger),/SECRET|fixture@example/);
  assert.equal((await (await call('/api/preparation-handoff/ledger',{user:'other'})).json()).records.length,0);
  const page=await call('/preparation-handoff');assert.match(page.headers.get('content-security-policy'),/connect-src 'self';/);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(await page.text(),/Stop sharing/);
  const body={schema_version:2,request_id:'api_fixture_request_01',expected_revision:ledger.revision,identity:{url,employer:'Fictional Company',title:'Fictional Engineer',location:'Canada'}};
  const blocked=await (await call('/api/preparation-handoff/reserve',{body})).json();assert.equal(blocked.decision,'blocked');assert.equal(blocked.submission_allowed,false);
  const reserveBody={...body,identity:{...body.identity,url:'https://job-boards.greenhouse.io/other/jobs/201',employer:'Another Company'}};
  const receipt=await (await call('/api/preparation-handoff/reserve',{body:reserveBody})).json();assert.equal(receipt.decision,'reserved');assert.equal(receipt.submission_allowed,false);
  assert.equal((await call('/api/preparation-handoff/reserve',{user:null,body:reserveBody})).status,401);
  assert.deepEqual(db.prepare('SELECT * FROM jobs').all(),before);assert.equal(db.prepare('SELECT COUNT(*) n FROM autonomous_attempts').get().n,0);
 }finally{child.kill();await exited;db.close();rmSync(dir,{recursive:true,force:true});}
});

test('browser bridge needs explicit connection, exact opener/origin and stops sharing during in-flight work',async()=>{
 const html=readFileSync(new URL('../web/preparation-handoff.html',import.meta.url),'utf8'),js=readFileSync(new URL('../web/preparation-handoff.js',import.meta.url),'utf8');
 const dom=new JSDOM(html,{url:'https://original.example.test/preparation-handoff',runScripts:'outside-only'}),w=dom.window,sent=[],calls=[];
 const peer={closed:false,postMessage:(value,origin)=>sent.push({value,origin})};Object.defineProperty(w,'opener',{value:peer});w.localStorage.setItem('applypilot-remembered-token','synthetic-session');
 let finish;w.fetch=async(path,options)=>{calls.push({path,options});if(path==='/api/me')return {ok:true,json:async()=>({user:{id:'fixture'}})};return new Promise(resolve=>{finish=value=>resolve({ok:true,json:async()=>value});});};
 w.eval(js);const tick=()=>new Promise(r=>setImmediate(r));await tick();
 const request={type:'applypilot.handoff.request',schema_version:2,request_id:'browser_request_fixture',action:'ledger'};
 const dispatch=(origin='http://127.0.0.1:17780',source=peer)=>w.dispatchEvent(new w.MessageEvent('message',{data:request,origin,source}));
 try{
  dispatch();await tick();assert.equal(calls.length,1,'no data is shared before connection');
  w.document.getElementById('connect').click();assert.equal(sent[0].value.type,'applypilot.handoff.ready');assert.equal(sent[0].origin,'http://127.0.0.1:17780');
  dispatch('http://localhost:17780');dispatch('http://127.0.0.1:17780',{});await tick();assert.equal(calls.length,1,'origin and source must both match');
  dispatch();await tick();assert.equal(calls.length,2);w.document.getElementById('stop').click();finish({schema_version:2,records:[],employer_holds:[],revision:1,generated_at:new Date().toISOString()});await tick();assert.equal(sent.length,1,'Stop suppresses a pending response');
  dispatch();await tick();assert.equal(calls.length,2);assert.doesNotMatch(JSON.stringify(sent),/synthetic-session|Bearer|token|authorization/);
 }finally{w.close();}
});
