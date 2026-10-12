import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {savedOptionSelections} from './local-policy.js';
import {canDraftProfessional,draftForJob,geminiFactAnswer,installDrafts} from './answer-drafts.js';
import {installLibrary} from './answer-library.js';
import {installResearch} from './google-research.js';
import {prepareFormAnswer} from './form-answer.js';

const question='Which tools have you personally used in production?';
const options=[{label:'Kubernetes',value:'k8s'},{label:'Argo CD',value:'argo'},{label:'CI, monitoring and alerts',value:'ci'}];
test('explicit saved multi-select lists map every unique label atomically without parsing skills or commas',()=>{
 for(const answer of ['Kubernetes\nArgo CD','["Kubernetes","Argo CD"]'])assert.deepEqual(savedOptionSelections(question,options,{[question]:answer}),options.slice(0,2));
 assert.deepEqual(savedOptionSelections(question,options,{[question]:'CI, monitoring and alerts'}),[options[2]]);
 for(const answer of ['Kubernetes, Argo CD','Kubernetes\nTerraform','["Kubernetes",false]','["Kubernetes","kubernetes"]','[]','[broken','I know Kubernetes and Argo CD'])assert.equal(savedOptionSelections(question,options,{[question]:answer}),null,answer);
 assert.equal(savedOptionSelections(question,[...options,{label:'Kubernetes',value:'duplicate'}],{[question]:'Kubernetes'}),null);
 assert.equal(savedOptionSelections(question,[{label:'Kubernetes',disabled:true}],{[question]:'Kubernetes'}),null);
 assert.equal(savedOptionSelections(question,options,{'Professional skills':'Kubernetes\nArgo CD'}),null);
 assert.equal(savedOptionSelections('I agree to these statements',options,{'I agree to these statements':'Kubernetes'}),null);
});
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE applicants(id TEXT PRIMARY KEY,user_id TEXT,answers_json TEXT,consent INTEGER,gemini_facts_consent INTEGER,ai_consent INTEGER,resume_path TEXT);
 CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,status TEXT,answers_json TEXT,updated_at TEXT,title TEXT,company TEXT,url TEXT);
 CREATE TABLE events(job_id TEXT,type TEXT);
 INSERT INTO applicants VALUES('p','u','{"Professional background":"I maintained Kubernetes clusters and resolved production incidents."}',1,1,0,NULL);
 INSERT INTO jobs VALUES('j','u','p','local_browser','{}','','Engineer','Example','https://jobs.lever.co/example/fixture');`);
 installLibrary(db);installDrafts(db);installResearch(db);return db;
}
const output=result=>({ok:true,json:async()=>({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify(result)}]}]})});
test('generic labels cannot borrow professional help without a stable full question identity',async()=>{
 const db=fixture(),q='Additional details',fieldHelp='Describe your experience maintaining Kubernetes clusters.';
 try{assert(!canDraftProfessional(q,fieldHelp));const result=await prepareFormAnswer(db,'u','j',q,{fieldHelp,draft:async()=>{throw Error('An ambiguous generic label must not call a provider');}});assert.equal(result.answer,'');assert.equal(db.prepare('SELECT answers_json FROM jobs').get().answers_json,'{}');}finally{db.close();}
});
test('protected field help cannot borrow a harmless label to call Gemini or consume quota',async()=>{
 for(const fieldHelp of ['Describe your experience and certify that these statements are accurate.','Confirm whether you are legally authorized to work in Canada.','Complete this coding assessment.']){
  const db=fixture();try{
   assert(!canDraftProfessional('Additional details',fieldHelp));
   const blocked=await prepareFormAnswer(db,'u','j','Additional details',{fieldHelp,draft:async()=>{throw Error('Protected help must not call provider');}});assert.equal(blocked.answer,'');
   const result=await geminiFactAnswer({question:'Describe your experience',fieldHelp,profile:{gemini_facts_consent:1},job:{},answers:{'Professional background':'I maintained Kubernetes clusters.'},fetchImpl:async()=>{throw Error('Must not call provider');}});assert.equal(result.answer,'');
   assert.equal(db.prepare('SELECT COUNT(*) n FROM draft_usage').get().n,0);
  }finally{db.close();}
 }
});

test('valid but unrelated citations and bare tool lists cannot produce yes/no history answers',async()=>{
 const q='Do you have hands-on experience with Argo CD?';
 for(const [fact,answer] of [
  ['I supported Linux servers for seven years.','No'],
  ['I supported Linux servers for seven years.','Yes'],
  ['My professional skills include Argo CD and Kubernetes.','Yes'],
  ['I would use Argo CD for deployment automation.','Yes'],
  ['I have never used Argo CD in a professional setting.','Yes'],
  ['I used Argo CD to deploy applications.','No']
 ]){
  const result=await geminiFactAnswer({question:q,profile:{gemini_facts_consent:1},job:{},answers:{'Professional background':fact},choices:['Yes','No'],env:{GEMINI_API_KEY:'fixture'},fetchImpl:async()=>output({answer,reason:'',evidence:[{id:'1',quote:fact}]})});
  assert.equal(result.answer,'',fact+' => '+answer);assert.match(result.reason,/Please confirm your actual experience/);
 }
});
test('narrative history still needs an exact approved categorical answer',async()=>{
 const q='Do you have hands-on experience with Argo CD?';
 for(const [fact,answer] of [['I used Argo CD to deploy applications.','Yes'],['I have never used Argo CD in a professional setting.','No'],['No hands-on experience with Argo CD.','No']]){
  const result=await geminiFactAnswer({question:q,profile:{gemini_facts_consent:1},job:{},answers:{'Professional background':fact},choices:['Yes','No'],env:{GEMINI_API_KEY:'fixture'},fetchImpl:async()=>output({answer,reason:'',evidence:[{id:'1',quote:fact}]})});
  assert.equal(result.answer,'',fact);assert.match(result.reason,/Please confirm/);
 }
});

test('categorical history guard covers option suffixes and help conditions without semantic guesses',async()=>{
 for(const [question,fieldHelp,fact,answer] of [
  ['Do you have experience with Kubernetes?','At least five years in a production environment.','I used Kubernetes for a one-day lab.','Yes'],
  ['Do you have hands-on experience with Argo CD?','','I supported Linux servers for seven years.','Yes, I have'],
  ['Do you have hands-on experience with Argo CD?','','I used Terraform while a teammate configured Argo CD.','Yes'],
  ['Do you have experience with Argo CD?','','I do not dislike Argo CD; I used it professionally for years.','No']
 ]){
  const result=await geminiFactAnswer({question,fieldHelp,profile:{gemini_facts_consent:1},job:{},answers:{'Professional background':fact},choices:[answer,'Other'],env:{GEMINI_API_KEY:'fixture'},fetchImpl:async()=>output({answer,reason:'',evidence:[{id:'1',quote:fact}]})});assert.equal(result.answer,'',fact);
 }
});

test('binary expertise and proficiency claims also require exact approved answers',async()=>{
 for(const question of ['Are you proficient with Argo CD?','Do you have Kubernetes expertise?','Is Kubernetes one of your technical skills?']){
  const fact='I supported Linux servers for seven years.';const result=await geminiFactAnswer({question,profile:{gemini_facts_consent:1},job:{},answers:{'Professional background':fact},choices:['Yes','No'],env:{GEMINI_API_KEY:'fixture'},fetchImpl:async()=>output({answer:'Yes',reason:'',evidence:[{id:'1',quote:fact}]})});assert.equal(result.answer,'',question);
 }
});

test('negative-zero and first-person option wording cannot bypass categorical confirmation',async()=>{
 const question='Do you have hands-on experience with Argo CD?',fact='I supported Linux servers for seven years.';
 for(const answer of ['None','Zero','0 years','I have hands-on experience','I have not used it']){
  const result=await geminiFactAnswer({question,profile:{gemini_facts_consent:1},job:{},answers:{'Professional background':fact},choices:[answer,'Other'],env:{GEMINI_API_KEY:'fixture'},fetchImpl:async()=>output({answer,reason:'',evidence:[{id:'1',quote:fact}]})});assert.equal(result.answer,'',answer);
 }
});

test('positive label eligibility does not hide an assessment in field help',async()=>{
 for(const fieldHelp of ['This is a coding challenge: write a function that merges two arrays.','Please solve the problem below.']){
  assert.equal(canDraftProfessional('Describe your experience',fieldHelp),false);
  const result=await geminiFactAnswer({question:'Describe your experience',fieldHelp,profile:{gemini_facts_consent:1},job:{},answers:{'Professional background':'I supported Linux servers.'},fetchImpl:async()=>{throw Error('Assessment help must not call a provider');}});assert.equal(result.answer,'');
 }
});

test('approved categorical answers reuse normalized questions without calling a model',async()=>{
 const db=fixture();try{
  const question='Have you worked in a customer-facing support role?';
  db.prepare("UPDATE applicants SET gemini_facts_consent=0,answers_json=? WHERE id='p'").run(JSON.stringify({[question]:'Yes'}));
  const result=await prepareFormAnswer(db,'u','j','  HAVE YOU WORKED in a customer-facing support role ? ✱  ',{choices:['Yes','No'],draft:async()=>{throw Error('Saved facts must not re-ask AI');}});
  assert.equal(result.answer,'Yes');assert.equal(result.source,'saved');
 }finally{db.close();}
});

test('ordinary grounded first-person narratives do not become categorical confirmations',async()=>{
 const question='Describe your experience with Kubernetes.';
 for(const fact of ['I have seven years of experience maintaining Kubernetes clusters.','I am a platform engineer maintaining Kubernetes clusters.','I can troubleshoot Kubernetes using my documented operational experience.','I do operational support for Kubernetes clusters.']){
  const result=await geminiFactAnswer({question,profile:{gemini_facts_consent:1},job:{},answers:{'Professional background':fact},env:{GEMINI_API_KEY:'fixture'},fetchImpl:async()=>output({answer:fact,reason:'',evidence:[{id:'1',quote:fact}]})});assert.equal(result.answer,fact);
 }
});
