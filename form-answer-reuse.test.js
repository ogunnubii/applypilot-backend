import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {prepareFormAnswer} from './form-answer.js';
import {automaticTextAnswer} from './automatic-answer.js';
import {installLibrary} from './answer-library.js';
import {installDrafts} from './answer-drafts.js';
import {installResearch} from './google-research.js';

const exact='Do you have hands-on experience with Argo CD?';
const noProvider=async()=>{throw Error('No provider or public research call is allowed by this fixture.');};
function fixture({facts={},application={},ai=0,research=0,location=''}={}){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE applicants(id TEXT PRIMARY KEY,user_id TEXT,consent INTEGER,gemini_facts_consent INTEGER,ai_consent INTEGER,google_research_consent INTEGER,answers_json TEXT,resume_path TEXT,name TEXT,location TEXT);
 CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,status TEXT,local_owner TEXT,local_attempt_at TEXT,handoff_available INTEGER,url TEXT,answers_json TEXT,updated_at TEXT,title TEXT,company TEXT,job_metadata_json TEXT);
 CREATE TABLE events(job_id TEXT,type TEXT);
 INSERT INTO applicants VALUES('p','u',1,0,0,0,'{}',NULL,'Fixture Applicant','');
 INSERT INTO jobs VALUES('j','u','p','local_browser','fixture',NULL,0,'https://example.test/job','{}','now','Engineer','Fixture','{}');`);
 db.prepare('UPDATE applicants SET answers_json=?,gemini_facts_consent=?,google_research_consent=?,location=?').run(JSON.stringify(facts),ai,research,location);
 db.prepare('UPDATE jobs SET answers_json=?').run(JSON.stringify(application));
 installLibrary(db);installDrafts(db);installResearch(db);
 return {db,answers:()=>JSON.parse(db.prepare('SELECT answers_json FROM jobs').get().answers_json),call:(q,options={})=>prepareFormAnswer(db,'u','j',q,{draft:noProvider,research:noProvider,...options}),close:()=>db.close()};
}

test('exact explicit routine answers reuse with AI disabled from profile or application, including No',async()=>{
 for(const scope of ['facts','application'])for(const value of ['Yes','No']){
  const f=fixture({[scope]:{[exact]:value}});try{
   const result=await f.call(exact,{choices:['Yes','No']});assert.equal(result.answer,value);assert.equal(result.source,'saved');
   assert.equal(f.db.prepare('SELECT COUNT(*) n FROM draft_usage').get().n,0);
  }finally{f.close();}
 }
 const f=fixture({application:{'Do you have hands-on experience with Argo CD*':'No'}});try{assert.equal((await f.call(exact,{choices:['Yes','No']})).answer,'No');}finally{f.close();}
});

test('unknown experience, mismatched choices and conflicting personal-profile aliases remain blank',async()=>{
 for(const options of [{facts:{'Professional skills':'Argo CD, Kubernetes'}},{facts:{[exact]:'Sometimes'}}]){
  const f=fixture(options);try{assert.equal((await f.call(exact,{choices:['Yes','No']})).answer,'');}finally{f.close();}
 }
 const f=fixture({facts:{City:'Other City'},application:{City:'Fixture City'},location:'Other City, Fixture Region, Fixture Country'});
 try{assert.equal((await f.call('City')).answer,'');assert.equal(f.answers().City,'Fixture City');}finally{f.close();}
});

test('exact saved answers cannot bypass protected questions or protected field help in either preparation path',async()=>{
 for(const [question,fieldHelp] of [['I agree to the employer terms',''],['Describe your support experience','I certify that this is accurate and complete.'],['What are the responsibilities of this role?','Confirm your work authorization in Canada.']]){
  const f=fixture({facts:{[question]:'Yes'},application:{[question]:'Yes'},ai:1,research:1});try{
   assert.equal((await f.call(question,{fieldHelp})).answer,'');
   const output=await automaticTextAnswer({db:f.db,profile:{gemini_facts_consent:1,google_research_consent:1},job:{id:'j',user_id:'u'},question,fieldHelp,answers:{[question]:'Yes'},applicationAnswers:{[question]:'Yes'},draft:noProvider,research:noProvider});assert.equal(output.answer,null);
   assert.equal(f.answers()[question],'Yes','An unsupported field never erases the explicit saved answer.');
  }finally{f.close();}
 }
});

test('numeric, character and help-word limits validate saved answers before reuse',async()=>{
 for(const [answer,options]of [['Seven years',{answerFormat:'number'}],['7',{maxLength:1,answerFormat:'number',fieldHelp:'Maximum 0 words'}],['Seven years',{maxLength:4}],['one two three',{fieldHelp:'Maximum 2 words'}]]){
  const question='Describe your support experience',f=fixture({application:{[question]:answer},ai:1});try{
   assert.equal((await f.call(question,options)).answer,'');assert.equal(f.answers()[question],answer);
   assert.equal((await automaticTextAnswer({db:f.db,profile:{},job:{id:'j',user_id:'u'},question,applicationAnswers:{[question]:answer},answers:{},...options,draft:noProvider})).answer,null);
  }finally{f.close();}
 }
 const f=fixture({facts:{'Years of professional support experience':'7'}});try{assert.equal((await f.call('Years of professional support experience',{answerFormat:'number'})).answer,'7');}finally{f.close();}
});

test('public research results are checked before persistence and protected help makes zero calls',async()=>{
 const question='What are the responsibilities of this role?';
 for(const options of [{maxLength:5},{answerFormat:'number'},{fieldHelp:'Maximum 2 words'}]){
  const f=fixture({research:1});let calls=0;const research=async()=>{calls++;return {answer:'The role manages Kubernetes deployments.'};};
  try{assert.equal((await f.call(question,{...options,research})).answer,'');assert.deepEqual(f.answers(),{});assert.equal(calls,1);
   const result=await automaticTextAnswer({db:f.db,profile:{google_research_consent:1},job:{id:'j',user_id:'u'},question,answers:{},applicationAnswers:{},...options,research});assert.equal(result.answer,null);assert.deepEqual(f.answers(),{});
  }finally{f.close();}
 }
 const f=fixture({research:1});try{assert.equal((await f.call(question,{fieldHelp:'I certify this is my personal work history.'})).answer,'');}finally{f.close();}
});

test('professional results and edits received while drafting keep employer formats and preserve user edits',async()=>{
 const question='Years of professional support experience',f=fixture({ai:1});
 try{
  assert.equal((await f.call(question,{answerFormat:'number',draft:async()=>({answer:'Seven',provider:'gemini'})})).answer,'');assert.deepEqual(f.answers(),{});
  const result=await f.call(question,{answerFormat:'number',draft:async()=>{f.db.prepare('UPDATE jobs SET answers_json=?').run(JSON.stringify({[question+'?']:'My edit'}));return {answer:'7',provider:'gemini'};}});
  assert.equal(result.answer,'');assert.deepEqual(f.answers(),{[question+'?']:'My edit'});
 }finally{f.close();}
});

test('generated-answer provenance and withdrawn provider consent survive exact saved reuse',async()=>{
 for(const provider of ['gemini','openai']){
  const f=fixture({application:{[exact]:'No'},ai:provider==='gemini'?1:0});
  if(provider==='openai')f.db.exec('UPDATE applicants SET ai_consent=1');
  f.db.prepare('INSERT INTO fact_drafts VALUES(?,?,?,?,?,?)').run('j',exact,'No',provider,'["Explicit fixture fact"]','now');
  try{
   const result=await f.call(exact,{choices:['Yes','No']});assert.equal(result.answer,'No');assert.equal(result.source,'approved_facts');
   f.db.exec('UPDATE applicants SET ai_consent=0,gemini_facts_consent=0');await assert.rejects(f.call(exact,{choices:['Yes','No']}),/consent changed/i);
  }finally{f.close();}
 }
});

test('unused public drafts still require research consent and retain citations when permitted',async()=>{
 const question='What are the responsibilities of this role?',answer='Manage supported infrastructure.',f=fixture({application:{[question]:answer}});
 f.db.prepare('INSERT INTO research_drafts(job_id,user_id,applicant_id,question,answer,citations_json,created_at) VALUES(?,?,?,?,?,?,?)').run('j','u','p',question,answer,'[{"url":"https://example.test/job"}]','now');
 try{
  assert.equal((await f.call(question)).answer,'');
  f.db.exec('UPDATE applicants SET google_research_consent=1');
  const result=await f.call(question);assert.equal(result.answer,answer);assert.equal(result.source,'public_page');assert.equal(result.citations[0].url,'https://example.test/job');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM research_draft_usage').get().n,1);
 }finally{f.close();}
});

test('generic labels cannot borrow old answers when their meaning is supplied by different help',async()=>{
 for(const question of ['Additional details','Please explain','Details:']){
  const f=fixture({facts:{[question]:'I maintained Kubernetes.'},application:{[question]:'I maintained Kubernetes.'},ai:1});
  try{
   const fieldHelp='Describe your hands-on Argo CD production deployments.';
   assert.equal((await f.call(question,{fieldHelp})).answer,'');
   assert.equal((await automaticTextAnswer({db:f.db,profile:{gemini_facts_consent:1},job:{id:'j',user_id:'u'},question,fieldHelp,answers:{[question]:'I maintained Kubernetes.'},applicationAnswers:f.answers(),draft:noProvider,research:noProvider})).answer,null);
   assert.equal(f.answers()[question],'I maintained Kubernetes.');
  }finally{f.close();}
 }
 const question='Preferred editor?',f=fixture({application:{[question]:'VS Code'}});
 try{assert.equal((await f.call(question,{fieldHelp:'Select one.',choices:['VS Code','Vim']})).answer,'VS Code');}finally{f.close();}
});
