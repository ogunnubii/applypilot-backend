import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installNotifications,sendBlockerEmails} from './notifications.js';
import {requiresHumanReview} from './review-policy.js';
const env={RESEND_API_KEY:'test-only',BLOCKER_EMAIL_FROM:'test@example.com',PUBLIC_ORIGIN:'https://example.com'};
function fixture(){const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT);CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,status TEXT,challenge TEXT,required_fields_json TEXT,local_phase TEXT,title TEXT,company TEXT);INSERT INTO users VALUES('u','owner@example.com');INSERT INTO jobs VALUES('j','u','paused','CAPTCHA','[]','ready','Engineer','Example');`);installNotifications(db);db.prepare('INSERT INTO notification_preferences VALUES(?,?)').run('u',1);return db;}
test('Routine career wording does not block, actual declarations and payments do',()=>{
 for(const text of ['Review application','We build payment products and offer certification training.','Experience with digital signature systems'])assert.equal(requiresHumanReview(text),false);
 for(const text of ['I certify these answers are true','By submitting your application you agree to our terms','I authorize a background check','Enter your passport number','Pay now','I acknowledge this declaration'])assert.equal(requiresHumanReview(text),true);
});
test('Blocker mail is opt-in, durable, contains a job link, and suppresses unchanged blockers',async()=>{
 const db=fixture(),sent=[];const fetchImpl=async(url,opts)=>{sent.push({url,opts});return {ok:true}};
 assert.equal((await sendBlockerEmails(db,{env:{},fetchImpl})).configured,false);assert.equal(sent.length,0);
 await sendBlockerEmails(db,{env,fetchImpl});await sendBlockerEmails(db,{env,fetchImpl});assert.equal(sent.length,1);
 const body=JSON.parse(sent[0].opts.body);assert.deepEqual(body.to,['owner@example.com']);assert(body.text.includes('https://example.com/automate.html#job-j'));assert(body.text.includes('human verification'));assert(!body.text.includes('CAPTCHA response'));
 db.exec("UPDATE jobs SET challenge='Missing answers',required_fields_json='[\"Passport country\"]';UPDATE notification_preferences SET enabled=0");await sendBlockerEmails(db,{env,fetchImpl});assert.equal(sent.length,1);
 db.exec('UPDATE notification_preferences SET enabled=1');await sendBlockerEmails(db,{env,fetchImpl});assert.equal(sent.length,2);assert(!sent[1].opts.body.includes('Passport country'));db.close();
});
test('Failed sends retry with identical payload/key; resolved and opted-out jobs do not send',async()=>{
 const db=fixture(),requests=[];const fetchImpl=async(u,o)=>{requests.push(o);return {ok:requests.length>1,status:503}};
 await sendBlockerEmails(db,{env,fetchImpl,time:1000000});
 db.exec("UPDATE jobs SET status='submitted'");await sendBlockerEmails(db,{env,fetchImpl,time:1400000});assert.equal(requests.length,1);
 db.exec("UPDATE jobs SET status='paused'");await sendBlockerEmails(db,{env,fetchImpl,time:1400000});assert.equal(requests.length,2);assert.equal(requests[0].body,requests[1].body);assert.equal(requests[0].headers['Idempotency-Key'],requests[1].headers['Idempotency-Key']);db.close();
});
