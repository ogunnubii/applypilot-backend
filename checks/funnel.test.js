import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {JSDOM} from 'jsdom';
import {EventEmitter} from 'node:events';
import {safeFunnelURL,parseFunnelLinks,readPublicJob,jobFromHTML} from '../funnel-links.js';
import {WORLDWIDE_TECH_INSTRUCTION,technologyRole} from '../tech-search.js';
import {matchAssessment} from '../matching.js';
const root=process.env.APPLYPILOT_TEST_TMP||'data/test-tmp';mkdirSync(root,{recursive:true});process.env.DATABASE_PATH=join(mkdtempSync(join(root,'funnel-')),'test.sqlite');
const {db}=await import('../db.js');const {parseIntent}=await import('../discovery.js');
const {installFunnel,createFunnelBatch,processFunnel,funnelStatus,enableWorldwideDiscovery,retryFunnelItem,resolveFunnelPosting}=await import('../job-funnel.js');
const {installResearch}=await import('../google-research.js');installResearch(db);installFunnel(db);db.exec("CREATE TABLE IF NOT EXISTS work_focus(user_id TEXT PRIMARY KEY,enabled INTEGER,job_id TEXT);CREATE TABLE language_preferences(user_id TEXT PRIMARY KEY,exclude_french INTEGER);CREATE TABLE application_archive(job_id TEXT PRIMARY KEY,previous_status TEXT,archived_at TEXT)");
db.exec("INSERT INTO users VALUES('owner','owner@example.test','fixture','2026'),('other','other@example.test','fixture','2026');INSERT INTO applicants(id,user_id,name,email,focus,resume_path,consent,created_at) VALUES('p','owner','Applicant','owner@example.test','Staff Platform Engineer','fixture.pdf',1,'2026'),('q','other','Other','other@example.test','DevOps Engineer','fixture.pdf',1,'2026');INSERT INTO language_preferences VALUES('owner',1)");
after(()=>db.close());
const url=n=>'https://jobs.lever.co/company'+n+'/11111111-1111-1111-1111-'+String(n).padStart(12,'0');
const posting=value=>({url:value,title:'Staff Platform Engineer',company:new URL(value).pathname.split('/')[1],location:'London, UK',description:'Build Kubernetes infrastructure. We offer visa sponsorship.',employmentType:'Full time'});

test('worldwide tech preferences match all requested families and natural worldwide wording does not become a city',()=>{
 const intent=parseIntent(WORLDWIDE_TECH_INSTRUCTION);assert.equal(intent.broadTech,true);assert.equal(intent.worldwideEligibility,true);assert.deepEqual(intent.localPlaces,[]);
 for(const title of ['DevOps Engineer','Senior Site Reliability Engineer','Systems Administrator','IT Manager','Principal AI Infrastructure Engineer','Cloud Architect','Staff Platform Engineer','Technical Support Engineer','Network Engineer','Software Engineer','Database Administrator'])assert.equal(matchAssessment({title,location:'Singapore'},intent).matched,true,title);
 for(const title of ['Nurse','Mechanical Engineer','Recruiter','Sales Account Executive'])assert.equal(technologyRole(title),false,title);
 const natural=parseIntent('Senior and Staff DevOps Engineer, Platform Engineer; worldwide roles with explicit visa sponsorship; Canada B2B only');assert.equal(natural.worldwideEligibility,true);assert.deepEqual(natural.localPlaces,[]);
});
test('bulk link parsing handles pasted lists, removes tracking and rejects private or credential URLs',()=>{
 const links=parseFunnelLinks('[Job]('+url(1)+'?utm_source=example)\n'+url(1)+'\nhttps://127.0.0.1/x\nhttps://example.com/?password=private');assert.deepEqual(links.links,[url(1)]);assert.equal(links.repeated,1);assert.equal(links.rejected.length,2);
 for(const value of ['http://example.com/job','https://user:pass@example.com/job','https://[::1]/job','https://private.local/job'])assert.throws(()=>safeFunnelURL(value));
 assert.throws(()=>parseFunnelLinks(Array(1001).fill(url(1)).join('\n')),/1,000/);
});
test('public employer reader rejects private DNS and validates redirect targets without sending credentials',async()=>{
 let calls=0;await assert.rejects(readPublicJob('https://employer.example.com/job',{resolveHost:async()=>[{address:'127.0.0.1',family:4}],requestImpl:()=>{calls++;}}),/public address/);assert.equal(calls,0);
 await assert.rejects(readPublicJob('https://employer.example.com/job',{resolveHost:async()=>[{address:'8.8.8.8',family:4}],requestImpl:(_url,opts,cb)=>{calls++;assert.equal(opts.method,'GET');assert(!opts.headers.authorization&&!opts.headers.cookie);const req=new EventEmitter();req.setTimeout=()=>{};req.end=()=>{const res=new EventEmitter();res.statusCode=302;res.headers={location:'https://127.0.0.1/private'};res.resume=()=>{};cb(res);};return req;}}),/public HTTPS/);assert.equal(calls,1);
});
test('structured employer pages preserve role identity and refuse multi-posting guesses',async()=>{
 const data={'@type':'JobPosting',title:'Cloud Architect',hiringOrganization:{name:'Employer'},description:'We offer visa sponsorship.',jobLocation:{address:{addressLocality:'Berlin',addressCountry:'Germany'}}};
 const html='<script type="application/ld+json">'+JSON.stringify(data)+'</script>';const job=jobFromHTML(html,'https://jobs.smartrecruiters.com/employer/1234');assert.equal(job.company,'Employer');assert.equal(job.location,'Berlin, Germany');assert.equal(jobFromHTML(html+html,job.url),null);
 const result=await resolveFunnelPosting('https://company.example.com/role',{read:async()=>({html:'<a href="'+url(30)+'">Apply</a>',url:'https://company.example.com/role'}),details:async row=>posting(row.url)});assert.equal(result.url,url(30));
});
test('saved bulk groups survive processing, queue suitable jobs, skip repeats and leave uncertain roles for review',async()=>{
 assert.throws(()=>createFunnelBatch(db,'other',{applicant_id:'p',links:url(1)}),/profile/);
 const batch=createFunnelBatch(db,'owner',{applicant_id:'p',links:[1,2,3,4,5,6,7].map(url).join('\n')});assert.equal(batch.added,7);assert.equal(funnelStatus(db,'other').items.length,0);
 const duplicate=createFunnelBatch(db,'owner',{applicant_id:'p',links:url(1)});assert.equal(duplicate.added,0);assert.equal(duplicate.repeated,1);
 const resolve=async value=>value===url(2)?{...posting(value),description:'Sponsorship is not available.'}:value===url(3)?{...posting(value),title:'Nurse'}:value===url(4)?{closed:true}:value===url(5)?{...posting(value),title:'Ingénieur DevOps'}:posting(value);
 const first=await processFunnel(db,{resolve,limit:5});assert.equal(first.length,5);assert.equal(funnelStatus(db,'owner').totals.pending,2);await processFunnel(db,{resolve,limit:5});
 const state=funnelStatus(db,'owner');assert.equal(state.totals.queued,3);assert.equal(state.totals.review,1);assert.equal(state.totals.excluded,2);assert.equal(state.totals.closed,1);
 const jobs=db.prepare("SELECT * FROM jobs WHERE user_id='owner'").all();assert.equal(jobs.length,3);assert(jobs.every(j=>j.status==='queued'&&!j.confirmation&&!j.local_attempt_at));
 const uncertain=state.items.find(i=>i.status==='review');assert.throws(()=>retryFunnelItem(db,'other',uncertain.id),/already/);retryFunnelItem(db,'owner',uncertain.id);assert.equal(funnelStatus(db,'owner').totals.pending,1);await processFunnel(db,{resolve,limit:5});
 const before=db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;await processFunnel(db,{resolve,limit:5});assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,before);
});
test('discovery configuration replaces only this profile searches and enables automatic queueing',()=>{
 db.prepare("INSERT INTO searches(id,user_id,applicant_id,instruction,boards_json,created_at) VALUES('other-search','other','q','Engineer','[]','2026')").run();
 const result=enableWorldwideDiscovery(db,'owner','p');assert.equal(db.prepare('SELECT instruction FROM searches WHERE id=?').get(result.id).instruction,WORLDWIDE_TECH_INSTRUCTION);assert.equal(db.prepare("SELECT enabled FROM searches WHERE id='other-search'").get().enabled,1);assert.equal(db.prepare("SELECT auto_queue_found FROM pipeline_preferences WHERE user_id='owner'").get().auto_queue_found,1);
 assert.equal(enableWorldwideDiscovery(db,'owner','p').id,result.id);
});

test('a previously completed role remains excluded when a new link points to the same employer and role',async()=>{
 const completed=db.prepare("SELECT * FROM jobs WHERE user_id='owner' LIMIT 1").get();db.prepare("UPDATE jobs SET status='submitted',local_attempt_at='2026-10-01' WHERE id=?").run(completed.id);
 createFunnelBatch(db,'owner',{applicant_id:'p',links:url(80)});await processFunnel(db,{resolve:async value=>({...posting(value),company:completed.company,title:completed.title})});
 const item=funnelStatus(db,'owner').items.find(i=>i.url===url(80));assert.equal(item.status,'duplicate');assert.equal(item.job_id,completed.id);
});

test('crashed checks are recovered and source failures retry a bounded number of times',async()=>{
 createFunnelBatch(db,'owner',{applicant_id:'p',links:url(90)});db.prepare("UPDATE funnel_items SET status='checking',lease_at='2020-01-01' WHERE url=?").run(url(90));
 let now='2026-10-05T12:00:00.000Z',calls=0;const resolve=async()=>{calls++;const e=Error('Employer page returned 503');e.status=503;throw e;};
 await processFunnel(db,{resolve,clock:()=>now});let item=db.prepare('SELECT * FROM funnel_items WHERE url=?').get(url(90));assert.equal(item.status,'pending');assert.equal(item.attempts,1);
 await processFunnel(db,{resolve,clock:()=>now});assert.equal(calls,1);
 now='2026-10-05T12:05:00.000Z';await processFunnel(db,{resolve,clock:()=>now});now='2026-10-05T12:10:00.000Z';await processFunnel(db,{resolve,clock:()=>now});item=db.prepare('SELECT * FROM funnel_items WHERE url=?').get(url(90));assert.equal(item.status,'review');assert.equal(item.attempts,3);assert.equal(calls,3);
});
test('funnel UI submits a durable bulk group and refreshes progress without erasing a pending paste',async()=>{
 const dom=new JSDOM(readFileSync('assistant-page.html','utf8'),{url:'https://example.test/?view=funnel',runScripts:'outside-only'}),w=dom.window;w.setInterval=()=>0;
 const calls=[];w.fetch=async(url,options={})=>{calls.push({url,options});const path=String(url);return {ok:true,json:async()=>path.endsWith('/applicants')?{applicants:[{id:'p',name:'Applicant'}]}:path.endsWith('/searches')?{searches:[]}:path.endsWith('/pipeline')?{enabled:true}:options.method==='POST'?{added:2,repeated:0,rejected:0}:{totals:{pending:2},batches:[],items:[],batchSize:5,intervalSeconds:30,checkedAt:new Date().toISOString()}};};
 w.eval(readFileSync('extension/policy.js','utf8'));w.eval(readFileSync('assistant-client.js','utf8'));await w.refreshFunnel();const textarea=w.document.querySelector('#funnel-links');textarea.value=url(20)+'\n'+url(21);await w.refreshFunnel();assert.equal(textarea.value,url(20)+'\n'+url(21));
 await w.document.querySelector('#funnel-form').onsubmit({preventDefault(){},submitter:w.document.querySelector('#funnel-add')});const request=calls.find(c=>c.options.method==='POST');assert.deepEqual(JSON.parse(request.options.body),{applicant_id:'p',links:url(20)+'\n'+url(21)});assert.equal(textarea.value,'');assert.match(w.document.querySelector('#funnel-notice').textContent,/2 links saved/);assert.equal(w.document.body.dataset.funnel,'true');w.close();
});
