import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {professionalFacts,canDraftProfessional,geminiFactAnswer,answerLimit,installDrafts,draftForJob} from '../answer-drafts.js';
import {installLibrary} from '../answer-library.js';
import {saveExperience,experienceFor,deleteExperience} from '../experience-library.js';
import {draftJobContext} from '../draft-job-context.js';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const approved=(title,details)=>({id:'example',title,details,approved_at:'2026-10-01',updated_at:'2026-10-01'});
const output=result=>({ok:true,json:async()=>({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify(result)}]}]})});
test('retrieval finds relevant late facts and resume excerpts without promoting unapproved stories',()=>{
 const answers=Object.fromEntries(Array.from({length:55},(_,i)=>['Past project '+i,'Maintained an unrelated reporting application.']));
 answers['Relevant skills']='I built Kubernetes operators and used Prometheus for alerting.';
 answers['Approved resume professional experience']=('Maintained unrelated reports.\n').repeat(650)+'Resolved an ingress outage using Loki log correlation and a rollback.';
 const facts=professionalFacts(answers,'Describe an outage where Loki log analysis and a rollback helped.',{title:'SRE'},[{title:'Unapproved',details:'Invented expertise'},approved('Real incident','During an ingress outage I correlated Loki logs and rolled back a faulty configuration. Service recovered.')]);
 assert(facts[0].answer.includes('Loki'));assert(facts.some(f=>f.answer.includes('rollback')));assert(!facts.some(f=>f.answer.includes('Invented expertise')));assert(facts.reduce((n,f)=>n+f.answer.length,0)<=32000);
});
test('long multipart questions preserve professional context and reject actual assessments and legal facts',()=>{
 const question='Tell us about a technical support issue where log analysis was important to solving the problem. What was the issue, what evidence and tools helped you understand it, and how was it ultimately resolved? '+ 'Explain your own actions and how the team chose to escalate or recommend a workaround. '.repeat(3);
 assert(question.length>240);assert(canDraftProfessional(question));assert(canDraftProfessional('Describe how you implement highly available infrastructure and service authorization.'));
 for(const q of ['Are you authorized to work in the UK?','What salary do you expect?','Solve this coding assessment','Do you agree to our declaration?'])assert(!canDraftProfessional(q));
 assert(!canDraftProfessional('Describe '+ 'x'.repeat(4000)));
});
test('Gemini receives separate job context, exact evidence and field limits; oversize and unsupported answers stay blank',async()=>{
 const fact='I correlated Loki logs and rolled back an ingress configuration. Service recovered.',question='Describe an incident in no more than 80 words.';let sent;
 const options={question,profile:{gemini_facts_consent:1},job:{title:'SRE',company:'Example'},jobContext:{description:'Build reliable Kubernetes platforms.',sourceUrl:'https://jobs.lever.co/example/id',status:'public_posting'},answers:{},experience:[approved('Ingress incident',fact)],maxLength:200,env:{GEMINI_API_KEY:'test'},fetchImpl:async(_url,request)=>{sent=JSON.parse(request.body);return output({answer:fact,reason:'',evidence:[{id:'1',quote:fact}]});}};
 assert.equal((await geminiFactAnswer(options)).answer,fact);const input=JSON.parse(sent.input);assert.equal(input.job.description,options.jobContext.description);assert.equal(input.limits.characters,200);assert.equal(input.limits.words,80);assert(!input.facts.some(f=>f.answer.includes('Build reliable')));
 assert.equal((await geminiFactAnswer({...options,maxLength:30})).answer,'');
 await assert.rejects(geminiFactAnswer({...options,fetchImpl:async()=>output({answer:'I led 50 engineers.',reason:'',evidence:[{id:'1',quote:'I led 50 engineers.'}]})}),/support/);
 assert.deepEqual(answerLimit('Explain in a maximum of 200 characters',100),{characters:100,words:650});
});
test('public posting context validates job identity and never follows arbitrary or redirected URLs',async()=>{
 let calls=[];const fetchImpl=async(url,options)=>{calls.push(url);assert.equal(options.redirect,'error');return {ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({id:772233,content:'<p>Build Kubernetes platforms.</p>'})};};
 let context=await draftJobContext({url:'https://job-boards.greenhouse.io/example/jobs/772233'},{fetchImpl});assert.match(context.description,/Kubernetes/);assert.match(calls[0],/^https:\/\/boards-api.greenhouse.io/);
 context=await draftJobContext({url:'https://example.com/candidate/private'},{fetchImpl});assert.equal(context.description,'');assert.equal(calls.length,1);
 context=await draftJobContext({url:'https://job-boards.greenhouse.io/example/jobs/772234'},{fetchImpl});assert.equal(context.description,'','A different requisition is not usable evidence');
});
function fixture(){const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE applicants(id TEXT PRIMARY KEY,user_id TEXT,answers_json TEXT,gemini_facts_consent INTEGER,ai_consent INTEGER,resume_path TEXT);
 CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,title TEXT,company TEXT,url TEXT);
 INSERT INTO applicants VALUES('p','u','{"Professional background":"I build Kubernetes platforms and maintain CI pipelines."}',1,0,NULL),('other','v','{}',1,0,NULL);
 INSERT INTO jobs VALUES('j','u','p','Platform Engineer','Example','https://example.test/job');`);installLibrary(db);installDrafts(db);return db;}
test('experience requires approval, enforces ownership and only uses the selected applicant',()=>{
 const db=fixture();try{const input={title:'Incident response',details:'I correlated ingress logs and restored the service.',approved:true};assert.throws(()=>saveExperience(db,'v','p',input),/Profile/);assert.throws(()=>saveExperience(db,'u','p',{...input,approved:false}),/Confirm/);const {id}=saveExperience(db,'u','p',input);assert.equal(experienceFor(db,'v','p').length,0);assert.equal(experienceFor(db,'u','p').length,1);assert.throws(()=>deleteExperience(db,'v','p',id));deleteExperience(db,'u','p',id);assert.equal(experienceFor(db,'u','p').length,0);}finally{db.close();}
});
test('missing facts are cached, new approved experience retries, and drafts do not become reusable facts',async()=>{
 const db=fixture();let calls=0;const options={context:async()=>({description:'Build a Kubernetes platform.',status:'public_posting'}),env:{GEMINI_API_KEY:'test'},fetchImpl:async()=>{calls++;return output({answer:'',reason:'Which incident did you resolve, what did you do and what was the result?',evidence:[]});}};
 try{const question='Describe a production incident you resolved.';await draftForJob(db,'u','j',question,options);const again=await draftForJob(db,'u','j',question,options);assert(again.cached);assert.equal(calls,1);
 saveExperience(db,'u','p',{title:'Production incident',details:'I rolled back a faulty ingress configuration after checking Loki logs. Service recovered.',approved:true});await draftForJob(db,'u','j',question,options);assert.equal(calls,2);assert.equal(db.prepare('SELECT count FROM draft_usage').get().count,2);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM answer_history').get().n,0);
 db.exec('UPDATE applicants SET gemini_facts_consent=0');await assert.rejects(draftForJob(db,'u','j',question,options),/Enable AI/);
 }finally{db.close();}
});
test('browser captures a full question and field constraints, fills it, and never clicks Submit',async()=>{
 const question='Tell us about a technical support issue where log analysis was important. '+ 'What evidence helped you decide whether to keep investigating, use a workaround, or escalate? '.repeat(3),dom=new JSDOM('<form><label>'+question+'<textarea required maxlength="350" aria-describedby="help"></textarea></label><p id="help">Use no more than 60 words.</p><button type="button">Submit application</button></form>',{runScripts:'outside-only',url:'https://jobs.ashbyhq.com/example/12345678-1234-1234-1234-123456789abc'}),w=dom.window,messages=[];let clicks=0;
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent}});w.HTMLElement.prototype.getClientRects=()=>[{}];w.setInterval=()=>0;w.clearInterval=()=>{};w.document.querySelector('button').onclick=()=>clicks++;
 w.chrome={runtime:{onMessage:{addListener(){}},sendMessage:async m=>{messages.push(m);if(m.action==='packet')return{ok:true,data:{job:{title:'SRE'},profile:{},answers:{},aiAssistance:true}};if(m.action==='state')return{ok:true,data:{attempted:false,automatic:true}};if(m.action==='answer')return{ok:true,data:{answer:'I correlated logs and rolled back the configuration; service recovered.'}};return{ok:true,data:{}};}}};
 w.eval(readFileSync('extension/policy.js','utf8'));w.eval(readFileSync('extension/content.js','utf8'));for(let n=0;n<100&&!messages.some(m=>m.action==='progress'&&m.blocked);n++)await new Promise(r=>setTimeout(r,25));
 const request=messages.find(m=>m.action==='answer');assert.equal(request.question,question.trim());assert.equal(request.maxLength,350);assert.match(request.fieldHelp,/60 words/);assert.match(w.document.querySelector('textarea').value,/correlated logs/);assert.equal(clicks,0);assert(!messages.some(m=>m.action==='attempt'));w.close();
});
