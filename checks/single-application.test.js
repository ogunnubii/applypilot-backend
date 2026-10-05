import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installSingleApplication,setWorkFocus,ensureFocusedJob,focusAllowsSubmit,saveFormProgress,focusSnapshot,reserveAutonomousAttempt} from '../single-application.js';

function fixture(){
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id,applicant_id,company,title,url,normalized_url,status,local_owner,local_attempt_at,local_phase,challenge,confirmation,attempts DEFAULT 0,handoff_available DEFAULT 0,match_score DEFAULT 90,created_at,updated_at,job_metadata_json DEFAULT '{}');CREATE TABLE applicants(id,user_id,consent);CREATE TABLE events(job_id,at,type,message);CREATE TABLE external_application_history(id,user_id,company,title,status);CREATE TABLE employer_limits(user_id,applicant_id,employer_key,hold_until,message);INSERT INTO applicants VALUES('p','u',1);`);
 installSingleApplication(db);for(const [id,company] of [['a','A'],['b','B'],['c','C']])db.prepare("INSERT INTO jobs(id,user_id,applicant_id,company,title,url,normalized_url,status,created_at) VALUES(?,'u','p',?,'Platform Engineer',?,?,'queued','2026')").run(id,company,'https://jobs.lever.co/'+company+'/'+id,'https://jobs.lever.co/'+company+'/'+id);
 return db;
}
test('focus holds blocked and reported applications; only a receipt advances, scoped to its owner',()=>{
 const db=fixture();const f=setWorkFocus(db,'u',{enabled:true,auto_submit:true});assert.equal(f.job_id,'a');assert.equal(f.parked,2);
 db.exec("UPDATE jobs SET status='needs_review',challenge='Missing answers' WHERE id='a'");assert.equal(ensureFocusedJob(db,'u').job_id,'a');
 assert.throws(()=>setWorkFocus(db,'u',{enabled:true,auto_submit:true,next:true}),/confirmation/);
 db.exec("UPDATE jobs SET status='submitted',confirmation='Applicant says done' WHERE id='a';INSERT INTO events(job_id,type) VALUES('a','applicant_reported_submission');");assert.equal(ensureFocusedJob(db,'u').job_id,'a');
 db.exec("UPDATE jobs SET confirmation='Thank you for applying' WHERE id='a';INSERT INTO events(job_id,type) VALUES('a','submitted');");assert.equal(ensureFocusedJob(db,'u').job_id,'b');
 assert.equal(ensureFocusedJob(db,'other').job_id,null);db.close();
});
test('autonomous authorization is opt in, owner scoped and cannot be replayed after a lost response',()=>{
 const db=fixture();setWorkFocus(db,'u',{enabled:true});db.exec("UPDATE jobs SET status='local_browser',local_owner='browser' WHERE id='a'");
 assert.throws(()=>reserveAutonomousAttempt(db,'a','u','browser'),/not enabled/);
 setWorkFocus(db,'u',{enabled:true,auto_submit:true});assert.throws(()=>reserveAutonomousAttempt(db,'a','u','other'),/another browser/);
 assert.throws(()=>reserveAutonomousAttempt(db,'b','u','browser'),/not enabled/);
 assert.equal(reserveAutonomousAttempt(db,'a','u','browser').permitted,true);
 assert.throws(()=>reserveAutonomousAttempt(db,'a','u','browser'),/already/);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type='automatic_submission'").get().n,1);
 assert.equal(focusSnapshot(db,'u').awaiting,true);assert.equal(ensureFocusedJob(db,'u').job_id,'a');
 setWorkFocus(db,'u',{enabled:true,auto_submit:false});assert.equal(focusAllowsSubmit(db,db.prepare("SELECT * FROM jobs WHERE id='a'").get()),false);db.close();
});
test('progress measures fields and never invents a receipt or a total before inspection',()=>{
 const db=fixture();setWorkFocus(db,'u',{enabled:true,auto_submit:true});assert.equal(focusSnapshot(db,'u').progress,null);
 saveFormProgress(db,'a',{required:10,filled:6});assert.equal(focusSnapshot(db,'u').progress.percent,60);
 saveFormProgress(db,'a',{required:10,filled:11});assert.equal(focusSnapshot(db,'u').progress.percent,60);
 saveFormProgress(db,'a',{required:10,filled:10});assert.equal(focusSnapshot(db,'u').progress.percent,100);assert.equal(focusSnapshot(db,'u').confirmed,false);assert.equal(ensureFocusedJob(db,'u').job_id,'a');db.close();
});

async function browserFixture({allow=true,fail=false,missing=false,captcha=false,declaration=false}={}){
 const dom=new JSDOM('<main><form><label>Email<input required type="email"></label>'+(missing?'<label>Favourite project<input required name="unknown"></label>':'')+(captcha?'<div class="g-recaptcha">Verification</div>':'')+(declaration?'<p> By submitting, I agree to the terms and conditions.</p>':'')+'<button type="button">Submit application</button></form></main>',{url:'https://jobs.lever.co/example/abc',runScripts:'outside-only'}),w=dom.window;
 w.HTMLElement.prototype.getClientRects=function(){return [{}]};Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});let clicks=0,attempted=false;const messages=[],timers=[];
 w.setInterval=fn=>{timers.push(fn);return timers.length};w.clearInterval=()=>{};w.document.querySelector('button').onclick=()=>clicks++;
 w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);if(m.action==='attempt'){attempted=true;if(fail)return {ok:false,error:'Connection lost'};return {ok:true,data:{permitted:true}};}return {ok:true,data:m.action==='packet'?{job:{id:'a',title:'Platform Engineer',attempted},autonomousSubmit:allow,profile:{email:'test@example.test'},answers:{}}:m.action==='state'?{attempted,automatic:true,autonomousSubmit:allow,autofillOnly:!allow}:{}};}}};
 w.eval(readFileSync('extension/policy.js','utf8'));w.eval(readFileSync('extension/content.js','utf8'));await new Promise(r=>setTimeout(r,600));return {w,messages,timers,clicks:()=>clicks};
}
test('extension submits exactly once after authorization, then watches for an employer receipt',async()=>{
 const f=await browserFixture();assert.equal(f.clicks(),1,JSON.stringify(f.messages));assert.equal(f.messages.filter(m=>m.action==='attempt').length,1);
 for(const fn of [...f.timers])await fn();assert.equal(f.clicks(),1);assert(!f.messages.some(m=>m.action==='receipt'));
 f.w.document.querySelector('main').textContent='Thank you for applying';for(const fn of [...f.timers])await fn();assert(f.messages.some(m=>m.action==='receipt'));f.w.close();
});
test('manual mode, missing facts, verification and lost authorization responses never click Submit',async()=>{
 for(const options of [{allow:false},{missing:true},{captcha:true},{declaration:true},{fail:true}]){const f=await browserFixture(options);assert.equal(f.clicks(),0,JSON.stringify(options));for(const fn of [...f.timers])await fn();assert.equal(f.clicks(),0);f.w.close();}
});
test('single-job homepage shows the running selection and real field progress without exposing the backlog',async()=>{
 const dom=new JSDOM(readFileSync('assistant-page.html','utf8'),{url:'https://example.test',runScripts:'outside-only'}),w=dom.window;w.setInterval=()=>0;
 const jobs=[{id:'chosen',company:'Example',title:'Platform Engineer',status:'running',required_fields_json:'[]',url:'https://example.test/chosen'},{id:'other',company:'Other',title:'Another role',status:'queued',required_fields_json:'[]'}];
 w.fetch=async url=>({ok:true,json:async()=>String(url).endsWith('/jobs')?{jobs,focus:{enabled:true,auto_submit:true,job_id:'chosen',parked:12,progress:{required:10,filled:6,percent:60}}}:String(url).endsWith('/status')?{workerOnline:true}:String(url).endsWith('/application-history')?{records:[]}:String(url).endsWith('/operations')?{totals:{confirmed:2},applications:[]}:String(url).endsWith('/continuations')?{requests:[]}:String(url).endsWith('/searches')?{searches:[]}:String(url).endsWith('/activity')?{events:[]}:String(url).endsWith('/employer-limits')?{limits:[]}:{} });
 w.eval(readFileSync('extension/policy.js','utf8'));w.eval(readFileSync('assistant-client.js','utf8'));await w.refresh(true);
 assert.equal(w.document.querySelector('#jobs').children.length,1);assert.equal(w.document.querySelector('#job-chosen').hidden,false);assert(w.document.querySelector('#work-focus').textContent.includes('60%'));assert.equal(w.document.querySelector('#work-focus progress').value,60);assert(w.document.querySelector('#work-focus').textContent.includes('12 other jobs'));w.close();
});
