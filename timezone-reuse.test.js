import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installLibrary,captureAnswers,confirmLibrary,reusableAnswers,updateLibrary} from './answer-library.js';
import {installResearch} from './google-research.js';
import {prepareFormAnswer} from './form-answer.js';
import {knownAnswer} from './local-policy.js';

const question='Which time zone do you primarily work in?';
function fixture(answers={'Time zone':'America/Toronto'}){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE applicants(id TEXT PRIMARY KEY,user_id TEXT,answers_json TEXT,consent INTEGER,location TEXT);
 CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT,status TEXT,answers_json TEXT NOT NULL DEFAULT '{}',updated_at TEXT);
 CREATE TABLE events(job_id TEXT,type TEXT);
 INSERT INTO jobs(id,user_id,applicant_id,status) VALUES('first','u','p','submitted'),('next','u','p','local_browser');`);
 db.prepare('INSERT INTO applicants VALUES(?,?,?,?,?)').run('p','u',JSON.stringify(answers),1,'Fixture City, Fixture Region, Canada');
 installLibrary(db);installResearch(db);
 return {db,job:db.prepare("SELECT * FROM jobs WHERE id='first'").get(),profile:()=>db.prepare("SELECT * FROM applicants WHERE id='p'").get()};
}
const noProvider=async()=>{throw Error('Timezone reuse must not call an AI or research provider');};

test('captured and receipt-confirmed timezone label preserves explicit profile timezone for the next job',async()=>{
 const {db,job,profile}=fixture();
 try{
  assert.deepEqual({...reusableAnswers(db,profile())},{'Time zone':'America/Toronto'});
  captureAnswers(db,job,[{question,answer:'Eastern Time (ET)'}]);
  assert.deepEqual({...reusableAnswers(db,profile())},{'Time zone':'America/Toronto'},'unconfirmed capture remains excluded');
  confirmLibrary(db,job);
  assert.deepEqual({...reusableAnswers(db,profile())},{'Time zone':'America/Toronto',[question]:'Eastern Time (ET)'});
  const result=await prepareFormAnswer(db,'u','next',question,{choices:['Pacific Time (PT)','Eastern Time (ET)','Other'],draft:noProvider,research:noProvider});
  assert.equal(result.answer,'Eastern Time (ET)');
  assert.equal(result.source,'saved_profile');
  assert.equal(result.requiresReview,false);
  assert.deepEqual(JSON.parse(db.prepare("SELECT answers_json FROM jobs WHERE id='next'").get().answers_json),{[question]:'Eastern Time (ET)'});
  assert.deepEqual(JSON.parse(profile().answers_json),{'Time zone':'America/Toronto'},'receipt history does not overwrite the approved profile');
 }finally{db.close();}
});

test('receipt-confirmed IANA and bounded display aliases remain reusable without rewriting their values',()=>{
 for(const answer of ['Canada/Eastern','Eastern Time (America/Toronto)','Eastern Time (EST/EDT)','(UTC-05:00) Eastern Time (US & Canada)']){
  const {db,job,profile}=fixture();
  try{
   captureAnswers(db,job,[{question,answer}]);confirmLibrary(db,job);
   const saved=reusableAnswers(db,profile());
   assert.equal(saved['Time zone'],'America/Toronto',answer);
   assert.equal(saved[question],answer);
   assert.equal(knownAnswer('Your time zone',{},saved),'America/Toronto',answer);
  }finally{db.close();}
 }
});

test('receipt-confirmed conflicting zones and fixed offsets still block the next job',async()=>{
 for(const answer of ['America/Vancouver','America/New_York','EST','UTC-05:00','Pacific Time (PT)']){
  const {db,job,profile}=fixture({'Time zone':'America/Toronto',Email:'fixture@example.test'});
  try{
   captureAnswers(db,job,[{question,answer}]);confirmLibrary(db,job);
   assert.deepEqual({...reusableAnswers(db,profile())},{Email:'fixture@example.test'},answer);
   const result=await prepareFormAnswer(db,'u','next',question,{choices:['Eastern Time (ET)',answer],draft:noProvider,research:noProvider});
   assert.equal(result.answer,'',answer);
   assert.deepEqual(JSON.parse(db.prepare("SELECT answers_json FROM jobs WHERE id='next'").get().answers_json),{},answer);
  }finally{db.close();}
 }
});

test('broad Eastern labels cannot bridge conflicting exact IANA zones in any insertion order',()=>{
 const values=['Eastern Time','America/Toronto','America/New_York'];
 for(let offset=0;offset<values.length;offset++){
  const ordered=[...values.slice(offset),...values.slice(0,offset)];
  const {db,job,profile}=fixture({'Time zone':ordered[0]});
  try{
   captureAnswers(db,job,[{question,answer:ordered[1]},{question:'Your time zone',answer:ordered[2]}]);confirmLibrary(db,job);
   assert.deepEqual({...reusableAnswers(db,profile())},{},ordered.join(', '));
   assert.equal(knownAnswer(question,{},reusableAnswers(db,profile())),null);
  }finally{db.close();}
 }
});

test('unapproved captures, explicit reuse opt-outs and other profiles cannot suppress timezone facts',()=>{
 const {db,job,profile}=fixture();
 try{
  captureAnswers(db,job,[{question,answer:'America/Vancouver'}]);
  assert.equal(reusableAnswers(db,profile())['Time zone'],'America/Toronto');
  confirmLibrary(db,job);
  assert.deepEqual({...reusableAnswers(db,profile())},{});
  const row=db.prepare('SELECT * FROM answer_history').get();
  updateLibrary(db,'u',row.id,row.answer,false);
  assert.equal(reusableAnswers(db,profile())['Time zone'],'America/Toronto');
  for(const foreignJob of [{...job,id:'other-user',user_id:'other'},{...job,id:'other-applicant',applicant_id:'other'}]){
   captureAnswers(db,foreignJob,[{question,answer:'America/Vancouver'}]);confirmLibrary(db,foreignJob);
  }
  assert.deepEqual({...reusableAnswers(db,profile())},{'Time zone':'America/Toronto'});
 }finally{db.close();}
});

test('timezone equivalence does not relax ordinary field conflicts',()=>{
 const {db,job,profile}=fixture({'Time zone':'America/Toronto',City:'Toronto'});
 try{
  captureAnswers(db,job,[{question,answer:'Eastern Time (ET)'},{question:'Current city',answer:'Ottawa'}]);confirmLibrary(db,job);
  const saved=reusableAnswers(db,profile());
  assert.equal(saved['Time zone'],'America/Toronto');
  assert.equal(saved[question],'Eastern Time (ET)');
  assert.equal(saved.City,undefined);
  assert.equal(saved['Current city'],undefined);
 }finally{db.close();}
});
