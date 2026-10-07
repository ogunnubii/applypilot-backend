import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {JSDOM} from 'jsdom';
import {loadManualApplication} from '../manual-applications.js';
import {importHistory} from '../application-history.js';
import {populateBatch} from '../application-batches.js';
import {CANADA_FALLBACK_INSTRUCTION} from '../support-career.js';
const root=process.env.APPLYPILOT_TEST_TMP||'data/test-tmp';mkdirSync(root,{recursive:true});process.env.DATABASE_PATH=join(mkdtempSync(join(root,'manual-')),'test.sqlite');
const {db}=await import('../db.js');const {installFunnel,createFunnelBatch}=await import('../job-funnel.js');installFunnel(db);
db.exec("CREATE TABLE IF NOT EXISTS language_preferences(user_id TEXT PRIMARY KEY,exclude_french INTEGER);INSERT INTO users VALUES('manual-u','manual@example.test','fixture','2026'),('manual-other','manual-other@example.test','fixture','2026');INSERT INTO applicants(id,user_id,name,created_at) VALUES('manual-p','manual-u','Test','2026');INSERT INTO application_batch_preferences VALUES('manual-u','manual-p',1,'manual-b',120000,'ECE','2026')");
after(()=>db.close());
function lead(n){createFunnelBatch(db,'manual-u',{applicant_id:'manual-p',links:'https://company.example.com/job/'+n});const row=db.prepare('SELECT * FROM funnel_items WHERE url=?').get('https://company.example.com/job/'+n);db.prepare("UPDATE funnel_items SET status='review' WHERE id=?").run(row.id);return row.id;}
test('manual lead is visible in the active batch without attempts, eligibility or submission claims; retries are idempotent and owner scoped',()=>{
 const id=lead(1),input={title:'Cloud Support Engineer',company:'Manual One'};
 assert.throws(()=>loadManualApplication(db,'manual-other',id,input),/not found/);
 const result=loadManualApplication(db,'manual-u',id,input),row=db.prepare('SELECT * FROM jobs WHERE id=?').get(result.id);
 assert.equal(row.status,'needs_review');assert.equal(row.attempts,0);assert.equal(row.local_attempt_at,null);assert.equal(row.confirmation,null);
 assert.equal(JSON.parse(row.job_metadata_json).manualReview,true);assert.equal(JSON.parse(row.job_metadata_json).eligibility.eligible,false);
 assert(db.prepare('SELECT 1 FROM application_batch_members WHERE job_id=? AND batch_id=?').get(row.id,'manual-b'));
 assert.equal(loadManualApplication(db,'manual-u',id,input).id,row.id);
 assert.deepEqual(db.prepare('SELECT type FROM events WHERE job_id=?').all(row.id).map(x=>x.type),['needs_review']);
});
test('native and imported application history prevents duplicates without modifying receipts',()=>{
 const id=lead(2),input={title:'Cloud Support Engineer',company:'Manual Two'},r=loadManualApplication(db,'manual-u',id,input);
 db.prepare("UPDATE jobs SET status='submitted',confirmation='Employer receipt' WHERE id=?").run(r.id);
 assert.equal(loadManualApplication(db,'manual-u',lead(3),input).duplicate,true);
 assert.equal(db.prepare('SELECT confirmation FROM jobs WHERE id=?').get(r.id).confirmation,'Employer receipt');
 importHistory(db,'manual-u',[{company:'External Example',title:'Technical Support Engineer',status:'applied',source:'Tsenta'}]);
 assert.equal(loadManualApplication(db,'manual-u',lead(4),{company:'External Example',title:'Technical Support Engineer'}).duplicate,true);
});
test('batch cap and closed postings reject without partially creating a job',()=>{
 const id=lead(5);db.prepare("UPDATE funnel_items SET status='closed' WHERE id=?").run(id);
 assert.throws(()=>loadManualApplication(db,'manual-u',id,{title:'A',company:'B'}),/Closed/);
 db.prepare("UPDATE funnel_items SET status='review' WHERE id=?").run(id);
 for(let n=0;n<18;n++)db.prepare('INSERT INTO application_batch_members VALUES(?,?,?,?)').run('manual-b','filler'+n,'manual-u',n+3);
 assert.throws(()=>loadManualApplication(db,'manual-u',id,{title:'A',company:'B'}),/20 jobs/);
 assert.equal(db.prepare('SELECT job_id FROM funnel_items WHERE id=?').get(id).job_id,null);
 db.prepare("DELETE FROM application_batch_members WHERE job_id LIKE 'filler%'").run();
});
test('T4 is selected only after preferred contracts and current manual work are exhausted',()=>{
 db.prepare("INSERT INTO searches(id,user_id,applicant_id,instruction,boards_json,created_at) VALUES('manual-search','manual-u','manual-p',?,'[]','2026')").run(CANADA_FALLBACK_INSTRUCTION);
 const add=(id,description,kind)=>{const metadata={available:true,location:'Remote Canada',remote:true,description,employmentType:kind==='business-contract'?'C2C contract':'Full-time',supportCareer:{strong:true},salaryTarget:{eligible:true,minimum:120000},eligibility:{eligible:true,kind}};db.prepare("INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,created_at,updated_at,job_metadata_json) VALUES(?,'manual-u','manual-p','Cloud Support Engineer',?,?,?,'saved','2026','2026',?)").run(id,id,'https://jobs.lever.co/'+id+'/123','https://jobs.lever.co/'+id+'/123',JSON.stringify(metadata));};
 add('contract-priority','C2C contract accepted','business-contract');add('employee-backup','T4 full-time employment','canada-employment-fallback');
 let batch=populateBatch(db,'manual-u');assert(batch.job_ids.includes('contract-priority'));assert(!batch.job_ids.includes('employee-backup'));
 db.prepare("UPDATE jobs SET status='submitted' WHERE id='contract-priority'").run();batch=populateBatch(db,'manual-u');assert(!batch.job_ids.includes('employee-backup'),'unfinished manual lead still takes priority');
 db.prepare("UPDATE jobs SET status='archived' WHERE user_id='manual-u' AND status='needs_review'").run();batch=populateBatch(db,'manual-u');assert(batch.job_ids.includes('employee-backup'));
});
test('manual lead form preserves edits during refresh and sends the explicit review request',async()=>{
 const dom=new JSDOM(readFileSync('assistant-page.html','utf8'),{url:'https://example.test/?view=funnel',runScripts:'outside-only'}),w=dom.window;w.setInterval=()=>0;
 const calls=[];let loaded=false;
 w.fetch=async(url,options={})=>{calls.push({url:String(url),options});if(options.method==='POST')loaded=true;return {ok:true,json:async()=>String(url).endsWith('/applicants')?{applicants:[{id:'p',name:'Applicant'}]}:String(url).endsWith('/searches')?{searches:[]}:String(url).endsWith('/pipeline')?{enabled:true}:options.method==='POST'?{id:'job',status:'needs_review'}:{totals:{review:1},items:[{id:'item',url:'https://example.com/role',status:'review',job_id:loaded?'job':null}],checkedAt:new Date().toISOString()}};};
 w.eval(readFileSync('extension/policy.js','utf8'));w.eval(readFileSync('assistant-client.js','utf8'));await w.refreshFunnel();
 const form=w.document.querySelector('#funnel-items form'),fields=form.querySelectorAll('textarea');fields[0].value='Cloud Support Engineer';fields[1].value='Company';fields[2].value='Pay needs review';fields[0].dispatchEvent(new w.Event('input',{bubbles:true}));
 await w.refreshFunnel();assert.equal(w.document.querySelector('#funnel-items form'),form);assert.equal(fields[0].value,'Cloud Support Engineer');
 await form.onsubmit({preventDefault(){}});const request=calls.find(c=>c.options.method==='POST');assert(request.url.endsWith('/funnel/item/manual'));assert.deepEqual(JSON.parse(request.options.body),{title:'Cloud Support Engineer',company:'Company',notes:'Pay needs review'});assert(!w.document.querySelector('#funnel-items form'));w.close();
});
test('main application card offers a direct manual link without unsupported automatic buttons',async()=>{
 const dom=new JSDOM(readFileSync('assistant-page.html','utf8'),{url:'https://example.test/',runScripts:'outside-only'}),w=dom.window;w.setInterval=()=>0;
 const job={id:'m',title:'Cloud Support Engineer',company:'Company',url:'https://example.com/job',status:'needs_review',metadata:{manualReview:true,pay:[],eligibility:{eligible:false}},challenge:'Manual application'};
 w.fetch=async url=>({ok:true,json:async()=>String(url).endsWith('/jobs')?{jobs:[job],batch:{enabled:true,job_ids:['m'],selected:1,completed:0,minimum_cad:120000}}:String(url).endsWith('/application-history')?{records:[]}:String(url).endsWith('/operations')?{applications:[],totals:{}}:String(url).endsWith('/continuations')?{requests:[]}:String(url).endsWith('/searches')?{searches:[]}:String(url).endsWith('/ai-status')?{profiles:[],attempts:[]}:String(url).endsWith('/activity')?{events:[]}:String(url).endsWith('/employer-limits')?{limits:[]}:{} });
 w.eval(readFileSync('extension/policy.js','utf8'));w.eval(readFileSync('assistant-client.js','utf8'));await w.refresh(true);
 const card=w.document.querySelector('#job-m');assert(!card.hidden);assert.equal(card.querySelector('.manual-application-link').href,job.url);assert.match(card.textContent,/Review & apply/);assert.match(card.textContent,/Pay needs confirmation/);assert(!card.textContent.includes('Prepare live application'));assert(card.querySelector('.mark-completed'));w.close();
});
