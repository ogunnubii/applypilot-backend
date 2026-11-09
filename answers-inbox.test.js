import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';

// All names, employers and answers below are synthetic fixtures in a temporary database.
const dir=mkdtempSync(join(tmpdir(),'applypilot-inbox-'));
process.env.DATABASE_PATH=join(dir,'inbox.sqlite');
const {db}=await import('./db.js');
const {installLibrary}=await import('./answer-library.js');
const {installResearch}=await import('./google-research.js');
const {installDrafts}=await import('./answer-drafts.js');
const {installBatches}=await import('./application-batches.js');
const {installContinuations}=await import('./continuation-queue.js');
const {installSingleApplication}=await import('./single-application.js');
const {answersInbox,saveInboxAnswer,inboxCanReuse,employerOnly}=await import('./answers-inbox.js');
installLibrary(db);installResearch(db);installDrafts(db);installBatches(db);installContinuations(db);installSingleApplication(db);
test.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});

const ADDRESS='Mailing address',CONSENT='Do you consent to this interview being recorded?',YEARS='Years of Kubernetes experience',WHY='Why do you want to work here?';
const uid=randomUUID(),other=randomUUID(),profile=randomUUID(),otherProfile=randomUUID();
db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(uid,'fixture@example.test','x','2026');
db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(other,'other@example.test','x','2026');
db.prepare("INSERT INTO applicants(id,user_id,name,email,resume_path,answers_json,consent,created_at) VALUES(?,?,'Fixture Person','fixture@example.test','/tmp/fixture.pdf','{}',1,'2026')").run(profile,uid);
db.prepare("INSERT INTO applicants(id,user_id,name,email,resume_path,answers_json,consent,created_at) VALUES(?,?,'Other Person','other@example.test','/tmp/other.pdf','{}',1,'2026')").run(otherProfile,other);
let order=0;
// Distinct letter-only employer names keep the real repeat-application guard from treating fixtures as one employer.
const letters=n=>{let s='';do{s=String.fromCharCode(97+n%26)+s;n=Math.floor(n/26)-1;}while(n>=0);return s;};
function job({user=uid,applicant=profile,status='local_browser',phase='blocked',questions=[ADDRESS],answers={},challenge='Missing answers',company='Fixture '+letters(order)+' Labs',...extra}={}){
 const id=randomUUID(),url='https://jobs.lever.co/fixture'+letters(order)+'/'+id;
 db.prepare(`INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,local_phase,challenge,required_fields_json,answers_json,created_at,updated_at) VALUES(?,?,?,'Platform Engineer',?,?,?,?,?,?,?,?,'2026',?)`).run(id,user,applicant,company,url,url,status,phase,challenge,JSON.stringify(questions),JSON.stringify(answers),'2026-11-08T00:00:'+String(order++).padStart(2,'0')+'Z');
 for(const [column,value] of Object.entries(extra))db.prepare(`UPDATE jobs SET ${column}=? WHERE id=?`).run(value,id);
 return id;
}
const row=id=>db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
const facts=()=>JSON.parse(db.prepare('SELECT answers_json FROM applicants WHERE id=?').get(profile).answers_json);
const listed=id=>answersInbox(db,uid).jobs.find(j=>j.id===id);
const keyOf=id=>listed(id).formKey;
const continuation=id=>db.prepare('SELECT state FROM continuation_requests WHERE job_id=?').get(id)?.state;

test('question policy: consents go to the employer page, addresses never become reusable',()=>{
 assert.equal(employerOnly(CONSENT),true);
 assert.equal(employerOnly(ADDRESS),false);
 assert.equal(inboxCanReuse(ADDRESS),false,'an address stays with its application');
 assert.equal(inboxCanReuse('Street address line 1'),false);
 assert.equal(inboxCanReuse(WHY),false,'employer-specific wording stays scoped');
 assert.equal(inboxCanReuse(YEARS),true,'an ordinary professional fact may be reused when asked');
});

test('lists only parked forms that no submission can have touched, and only unanswered questions',()=>{
 const parked=job({questions:[ADDRESS,CONSENT,YEARS,WHY],answers:{[YEARS]:'4'}});
 const hosted=job({status:'needs_review',phase:'ready',questions:[WHY]});
 const hidden=[
  job({status:'submitted',phase:'submitted'}),
  job({phase:'uncertain'}),
  job({status:'paused',phase:'uncertain'}),
  job({status:'needs_review',phase:'verifying'}),
  job({local_attempt_at:'2026-11-08T01:00:00Z'}),
  job({challenge:'Unconfirmed submission'}),
  job({handoff_available:1}),
  job({user:other,applicant:otherProfile}),
  job({questions:[ADDRESS],answers:{[ADDRESS]:'already answered'}})
 ];
 const reported=job();db.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,'2026','applicant_reported_submission','fixture')").run(reported);
 const attempted=job();db.prepare("INSERT INTO autonomous_attempts(job_id,owner,created_at) VALUES(?,'fixture','2026')").run(attempted);
 const before=JSON.stringify([db.prepare('SELECT * FROM jobs ORDER BY id').all(),db.prepare('SELECT * FROM applicants ORDER BY id').all(),db.prepare('SELECT COUNT(*) AS n FROM events').get()]);
 const inbox=answersInbox(db,uid),ids=inbox.jobs.map(j=>j.id);
 assert.equal(JSON.stringify([db.prepare('SELECT * FROM jobs ORDER BY id').all(),db.prepare('SELECT * FROM applicants ORDER BY id').all(),db.prepare('SELECT COUNT(*) AS n FROM events').get()]),before,'listing writes nothing');
 assert(ids.includes(parked)&&ids.includes(hosted));
 for(const id of [...hidden,reported,attempted])assert(!ids.includes(id),'not listed: '+row(id).status+'/'+row(id).local_phase);
 const entry=inbox.jobs.find(j=>j.id===parked);
 assert.deepEqual(entry.questions,[{question:ADDRESS,kind:'answer',reuse:false},{question:CONSENT,kind:'employer'},{question:WHY,kind:'answer',reuse:false}]);
 assert.equal(entry.mode,'browser');assert.equal(inbox.jobs.find(j=>j.id===hosted).mode,'hosted');
 assert.match(entry.formKey,/^[a-f0-9]{24}$/);
});

test('saves the typed answer for one application; an address cannot be remembered',()=>{
 const id=job({questions:[ADDRESS,YEARS]});
 assert.throws(()=>saveInboxAnswer(db,uid,id,{question:ADDRESS,answer:'55 Fixture Street',remember:true,formKey:keyOf(id)}),/stays with this application/);
 assert.deepEqual(JSON.parse(row(id).answers_json),{},'a refused save writes nothing');
 const result=saveInboxAnswer(db,uid,id,{question:ADDRESS,answer:'  55 Fixture Street  ',formKey:keyOf(id)});
 assert.equal(result.remembered,false);
 assert.deepEqual(JSON.parse(row(id).answers_json),{[ADDRESS]:'55 Fixture Street'});
 assert.deepEqual(facts(),{},'the profile is unchanged');
 assert.deepEqual(result.resume,{state:'waiting',remaining:1,employer:0,message:'1 more answer needed.'});
 assert.equal(continuation(id),undefined);
 assert.match(db.prepare("SELECT message FROM events WHERE job_id=? AND type='answer_saved'").get(id).message,/this application only/);
});

test('a reusable fact is kept only when asked, and never replaces a different saved fact',()=>{
 const first=job({questions:[YEARS,WHY]});
 assert.equal(saveInboxAnswer(db,uid,first,{question:YEARS,answer:'5',remember:true,formKey:keyOf(first)}).remembered,true);
 assert.equal(facts()[YEARS],'5');
 const second=job({questions:[YEARS]});
 const conflict=saveInboxAnswer(db,uid,second,{question:YEARS,answer:'6',remember:true,formKey:keyOf(second)});
 assert.equal(conflict.remembered,false);assert.equal(conflict.profileConflict,true);
 assert.equal(facts()[YEARS],'5','the earlier saved fact is not overwritten');
 assert.equal(JSON.parse(row(second).answers_json)[YEARS],'6','the typed answer still applies to its own application');
});

test('stale lists, other tabs, protected questions and other accounts are refused without writing',()=>{
 const id=job({questions:[ADDRESS,CONSENT]}),key=keyOf(id);
 const refuse=(input,pattern,target=id,user=uid)=>{const before=row(target).answers_json;assert.throws(()=>saveInboxAnswer(db,user,target,input),pattern);assert.equal(row(target).answers_json,before);};
 refuse({question:ADDRESS,answer:'x',formKey:'stale'},/form changed/);
 refuse({question:'Not on this form',answer:'x',formKey:key},/not on this form/);
 refuse({question:CONSENT,answer:'Yes',formKey:key},/employer page/);
 refuse({question:ADDRESS,answer:'   ',formKey:key},/Enter an answer/);
 refuse({question:ADDRESS,answer:'x',formKey:key},/not found/,id,other);
 db.prepare('INSERT INTO answer_save_state(job_id,question,editing) VALUES(?,?,1)').run(id,ADDRESS);
 refuse({question:ADDRESS,answer:'x',formKey:key},/being edited in the employer tab/);
 db.prepare('DELETE FROM answer_save_state WHERE job_id=?').run(id);
 db.prepare('UPDATE jobs SET answers_json=? WHERE id=?').run(JSON.stringify({[ADDRESS]:'typed in the employer tab'}),id);
 refuse({question:ADDRESS,answer:'overwrite',formKey:key},/already answered elsewhere/);
 assert.equal(JSON.parse(row(id).answers_json)[ADDRESS],'typed in the employer tab');
 const uncertain=job(),uncertainKey=keyOf(uncertain);db.prepare("UPDATE jobs SET local_phase='uncertain' WHERE id=?").run(uncertain);
 refuse({question:ADDRESS,answer:'x',formKey:uncertainKey},/no longer waiting/,uncertain);
});

test('the last browser answer queues one continuation; holds and hosted forms never restart',()=>{
 const ready=job({questions:[ADDRESS]});
 const queued=saveInboxAnswer(db,uid,ready,{question:ADDRESS,answer:'55 Fixture Street',formKey:keyOf(ready)});
 assert.equal(queued.resume.state,'queued');assert.equal(continuation(ready),'queued');
 assert.equal(row(ready).status,'local_browser');assert.equal(row(ready).local_attempt_at,null,'queuing is not an attempt');

 const held=job({questions:[ADDRESS]});
 const hold=saveInboxAnswer(db,uid,held,{question:ADDRESS,answer:'55 Fixture Street',formKey:keyOf(held),check:()=>'Employer hold fixture.'});
 assert.deepEqual(hold.resume,{state:'held',message:'Employer hold fixture.'});
 assert.equal(continuation(held),undefined);assert.equal(JSON.parse(row(held).answers_json)[ADDRESS],'55 Fixture Street','the answer is kept');

 const hosted=job({status:'paused',phase:'ready',questions:[ADDRESS]});
 const manual=saveInboxAnswer(db,uid,hosted,{question:ADDRESS,answer:'55 Fixture Street',formKey:keyOf(hosted)});
 assert.equal(manual.resume.state,'manual');assert.equal(row(hosted).status,'paused','a paused form is not re-queued');
 assert.equal(continuation(hosted),undefined);
 assert(!db.prepare("SELECT 1 FROM events WHERE job_id=? AND type='queued'").get(hosted));

 const employer=job({questions:[ADDRESS,CONSENT]});
 const left=saveInboxAnswer(db,uid,employer,{question:ADDRESS,answer:'55 Fixture Street',formKey:keyOf(employer)});
 assert.equal(left.resume.state,'employer');assert.equal(continuation(employer),undefined,'a consent on the employer page keeps the form parked');
});

test('one typed answer can be copied, by choice, to the other listed forms asking the same question',()=>{
 const owner=randomUUID(),person=randomUUID(),STREET='Street address',WORK=WHY;
 db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(owner,'copy@example.test','x','2026');
 db.prepare("INSERT INTO applicants(id,user_id,name,email,resume_path,answers_json,consent,created_at) VALUES(?,?,'Copy Person','copy@example.test','/tmp/copy.pdf','{}',1,'2026')").run(person,owner);
 const mine=extra=>job({user:owner,applicant:person,...extra});
 const a=mine({questions:[STREET,WORK]}),b=mine({questions:['street address *']}),hosted=mine({status:'paused',phase:'ready',questions:[STREET]});
 const busy=mine({questions:[STREET]});db.prepare('INSERT INTO answer_save_state(job_id,question,editing) VALUES(?,?,1)').run(busy,STREET);
 const changed=mine({questions:[STREET]}),strangerJob=job({questions:[STREET]});
 const list=answersInbox(db,owner),entry=list.jobs.find(j=>j.id===a),street=entry.questions.find(q=>q.question===STREET);
 assert.deepEqual(street.elsewhere.map(o=>o.id).sort(),[b,hosted,changed].sort(),'a form being edited in its tab is not offered');
 assert.equal(entry.questions.find(q=>q.question===WORK).elsewhere,undefined,'employer-specific questions are never offered for copying');
 const key=id=>list.jobs.find(j=>j.id===id).formKey;

 const before=row(a).answers_json;
 assert.throws(()=>saveInboxAnswer(db,owner,a,{question:WORK,answer:'Fixture reason',formKey:key(a),also:[{id:b,formKey:key(b)}]}),/specific to one application/);
 assert.equal(row(a).answers_json,before,'a refused copy writes nothing, not even the first form');
 assert.throws(()=>saveInboxAnswer(db,owner,a,{question:STREET,answer:'55 Fixture Street',formKey:'stale',also:[{id:b,formKey:key(b)}]}),/form changed/);
 assert.equal(row(b).answers_json,'{}','copies never run when the first save fails');

 db.prepare('UPDATE jobs SET required_fields_json=? WHERE id=?').run(JSON.stringify([STREET,'Phone number']),changed);
 const result=saveInboxAnswer(db,owner,a,{question:STREET,answer:'55 Fixture Street',formKey:key(a),also:[b,hosted,changed,busy,strangerJob].map(id=>({id,formKey:id===strangerJob?'x':id===busy?'busy':key(id)}))});
 assert.equal(JSON.parse(row(a).answers_json)[STREET],'55 Fixture Street');
 assert.equal(JSON.parse(row(b).answers_json)['street address *'],'55 Fixture Street','each form stores the copy under its own question wording');
 assert.equal(JSON.parse(row(hosted).answers_json)[STREET],'55 Fixture Street');
 assert.equal(row(hosted).status,'paused','a copy never restarts a paused form');
 const by=Object.fromEntries(result.also.map(c=>[c.id,c]));
 assert.equal(by[b].saved,true);assert.equal(by[b].resume.state,'queued');assert.equal(continuation(b),'queued');
 assert.equal(by[hosted].saved,true);assert.equal(by[hosted].resume.state,'manual');
 assert.equal(by[changed].saved,false);assert.match(by[changed].message,/form changed/);assert.equal(row(changed).answers_json,'{}');
 assert.equal(by[busy].saved,false);assert.equal(row(busy).answers_json,'{}');
 assert.equal(by[strangerJob].saved,false);assert.equal(by[strangerJob].message,'Application not found.');assert.equal(row(strangerJob).answers_json,'{}');
 assert.equal(JSON.parse(db.prepare('SELECT answers_json FROM applicants WHERE id=?').get(person).answers_json)[STREET],undefined,'copies never become a profile fact');
 assert.match(db.prepare("SELECT message FROM events WHERE job_id=? AND type='answer_saved'").get(b).message,/chose to use the same typed answer/);
 assert.throws(()=>saveInboxAnswer(db,owner,a,{question:WORK,answer:'x',formKey:key(a),also:Array.from({length:21},(_,i)=>({id:'j'+i,formKey:'k'}))}),/up to 20/);
});
