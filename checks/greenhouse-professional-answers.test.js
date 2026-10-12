import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {canDraftProfessional,draftForJob,geminiFactAnswer,installDrafts} from '../answer-drafts.js';
import {installLibrary} from '../answer-library.js';
import {automaticTextAnswer} from '../automatic-answer.js';
import {hostedOptionChoice} from '../hosted-form.js';

const SUPPORT_QUESTION='Have you worked in a customer-facing support role?';
const EXPERIENCE_QUESTION='Please describe your hands-on experience with Kubernetes and Argo CD. Include details such as:';
const EXPERIENCE_HELP='How you have used Kubernetes in a professional setting Specific ways you have worked with Argo CD (e.g., deployments, rollbacks, pipeline management)';
const providerOutput=result=>({ok:true,json:async()=>({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify(result)}]}]})});

function fixture(answers){
 const db=new DatabaseSync(':memory:');
 db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE applicants(id TEXT PRIMARY KEY,user_id TEXT,answers_json TEXT,gemini_facts_consent INTEGER,ai_consent INTEGER,resume_path TEXT);
 CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,title TEXT,company TEXT,url TEXT);
 INSERT INTO jobs VALUES('j','u','p','Technical Support Engineer','Akuity','https://example.test/job');`);
 db.prepare('INSERT INTO applicants VALUES(?,?,?,?,?,?)').run('p','u',JSON.stringify(answers),1,0,null);
 installLibrary(db);installDrafts(db);
 return {db,profile:db.prepare('SELECT * FROM applicants').get(),job:db.prepare('SELECT * FROM jobs').get(),answers};
}
const noContext=async()=>({description:'',status:'unavailable'});

test('Greenhouse professional history wording is allowed while protected questions remain blocked',async()=>{
 for(const question of [SUPPORT_QUESTION,EXPERIENCE_QUESTION,'Do you have hands-on experience with Kubernetes?','Do you have hands-on experience with Argo CD?'])assert(canDraftProfessional(question),question);
 const blocked=[
  'Have you worked in support? Complete this coding assessment.',
  'Have you worked in support? Please solve this quiz.',
  'Have you worked in support and are you authorized to work in the UK?',
  'Have you worked in support and do you require visa sponsorship?',
  'Have you worked in support and what salary do you expect?',
  'Have you worked in support and are you available to start next week?',
  'Have you worked in support? I certify the answer is accurate.',
  'Have you worked in support? Do you agree to this declaration?',
 ];
 for(const question of blocked){
  assert(!canDraftProfessional(question),question);
  const result=await geminiFactAnswer({question,profile:{gemini_facts_consent:1},job:{},answers:{'Professional background':'I worked in customer-facing support.'},fetchImpl:async()=>{throw Error('Protected questions must not call a provider');}});
  assert.equal(result.answer,'');
 }
});

test('customer-facing support history reaches drafting but a categorical answer needs explicit confirmation',async()=>{
 const fact='I worked in a customer-facing support role, resolving customer tickets and troubleshooting software issues.';
 const {db}=fixture({'Professional background':fact});let calls=0;
 try{
  const result=await draftForJob(db,'u','j',SUPPORT_QUESTION,{context:noContext,choices:['Yes','No'],env:{GEMINI_API_KEY:'fixture'},fetchImpl:async(_url,request)=>{
   calls++;const payload=JSON.parse(request.body),input=JSON.parse(payload.input);
   assert.equal(input.question,SUPPORT_QUESTION);assert.deepEqual(input.choices,['Yes','No']);
   const source=input.facts.find(f=>f.answer===fact);assert(source);
   return providerOutput({answer:'Yes',reason:'Explicit customer-facing support history.',evidence:[{id:source.id,quote:fact}]});
  }});
  assert.equal(calls,1);assert.equal(result.answer,'');assert.match(result.reason,/Please confirm your actual experience/);assert.deepEqual(result.sources,[]);
  assert.equal(hostedOptionChoice({label:SUPPORT_QUESTION},[{label:'Yes'},{label:'No'}],{},{[SUPPORT_QUESTION]:'Yes'}).label,'Yes');
  assert.equal(db.prepare('SELECT count FROM draft_usage').get().count,1);
 }finally{db.close();}
});

test('automatic Greenhouse text drafting forwards help and limits and preserves the exact missing-history reason',async()=>{
 const state=fixture({'Professional skills':'Kubernetes, Argo CD, Linux, CI/CD.'});
 const reason='How have you used Kubernetes professionally, and what deployments, rollbacks or pipeline management have you personally performed with Argo CD?';
 let calls=0;
 const draft=(_db,uid,id,question,options)=>draftForJob(_db,uid,id,question,{...options,context:noContext,env:{GEMINI_API_KEY:'fixture'},fetchImpl:async(_url,request)=>{
  calls++;const payload=JSON.parse(request.body),input=JSON.parse(payload.input);
  assert.equal(input.question,EXPERIENCE_QUESTION);assert.equal(input.fieldHelp,EXPERIENCE_HELP);
  assert.equal(input.limits.characters,700);assert.equal(input.answerFormat,'text');
  assert.deepEqual(input.facts.map(f=>f.answer),['Kubernetes, Argo CD, Linux, CI/CD.']);
  assert.match(payload.system_instruction,/A bare list of skills or tools does not establish hands-on or professional use/);
  assert.match(payload.system_instruction,/Missing experience is not evidence of no experience/);
  assert.match(payload.system_instruction,/essential factual answer.*missing return an empty answer/);
  return providerOutput({answer:'',reason,evidence:[]});
 }});
 try{
  const args={...state,question:EXPERIENCE_QUESTION,fieldHelp:EXPERIENCE_HELP,maxLength:700,draft};
  assert.deepEqual(await automaticTextAnswer(args),{answer:null,source:'unresolved',reason});
  assert.deepEqual(await automaticTextAnswer(args),{answer:null,source:'unresolved',reason});
  assert.equal(calls,1,'Unchanged missing facts reuse the safe blank draft');
  assert.equal(state.db.prepare('SELECT COUNT(*) n FROM fact_drafts').get().n,0);
 }finally{state.db.close();}
});

test('bare skills never become deterministic yes/no answers or substitute for missing work history',async()=>{
 const answers={'Professional skills':'Customer support, Kubernetes, Argo CD, Linux.'};
 const options=[{label:'Yes',value:'yes'},{label:'No',value:'no'}];
 let calls=0;
 for(const question of [SUPPORT_QUESTION,'Do you have hands-on experience with Kubernetes?','Do you have hands-on experience with Argo CD?']){
  assert.equal(hostedOptionChoice({label:question},options,{},answers),null);
  const reason='Please confirm your actual experience for: '+question;
  const common={db:{},profile:{gemini_facts_consent:1},job:{id:'j',user_id:'u'},question,answers};
  const result=await automaticTextAnswer({...common,draft:async(_db,_uid,_id,q,metadata)=>geminiFactAnswer({question:q,profile:common.profile,job:common.job,answers,...metadata,env:{GEMINI_API_KEY:'fixture'},fetchImpl:async()=>{calls++;return providerOutput({answer:'',reason,evidence:[]});}})});
  assert.deepEqual(result,{answer:null,source:'unresolved',reason});
  assert.deepEqual(await automaticTextAnswer({...common,profile:{},draft:async()=>{throw Error('No consent');}}),{answer:null,source:'unresolved'});
 }
 assert.equal(calls,3,'Each unmatched question reaches the evidence-aware provider instead of guessing');
});

test('automatic text metadata remains optional and exact saved answers keep their precedence',async()=>{
 const common={db:{},profile:{gemini_facts_consent:1},job:{id:'j',user_id:'u'},question:SUPPORT_QUESTION,answers:{}};
 const draft=async(_db,_uid,_id,question,metadata)=>{assert.equal(question,SUPPORT_QUESTION);assert.deepEqual(metadata,{fieldHelp:'',maxLength:4000,answerFormat:'text'});return {answer:'',reason:'Confirm your support history.'};};
 assert.equal((await automaticTextAnswer({...common,draft})).answer,null);
 const saved=await automaticTextAnswer({...common,answers:{[SUPPORT_QUESTION]:'No'},fieldHelp:EXPERIENCE_HELP,maxLength:200,draft:async()=>{throw Error('Exact approved answers should not call a provider');}});
 assert.deepEqual(saved,{answer:'No',source:'saved'});
});
