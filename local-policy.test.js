import test from 'node:test';
import assert from 'node:assert/strict';
import {supported,sameApplication,sensitive,savedAnswer,receipt} from './local-policy.js';
import {applicationEvidence} from './operation-evidence.js';

test('sent-to employer receipts require an affirmative completed sentence',()=>{
 const message='Your job application has been sent to Randstad Canada.';
 assert.equal(receipt(message),message);
 assert.equal(receipt('job application confirmation\n'+message+'\nReference: fixture'),message);
 for(const prefix of ['Applicant verified: ','Browser extension observed: '])assert.equal(receipt(prefix+message),message);
 for(const text of [
  'Your job application has not been sent to Randstad Canada.',
  'Your job application will be sent to Randstad Canada.',
  'Your job application is being sent to Randstad Canada.',
  'Once you submit, your job application has been sent to Randstad Canada.',
  'The next page will say "Your job application has been sent to Randstad Canada."',
  'Your job application has been sent to',
  'Your job application has been sent to Randstad Canada, pending submission',
  'Your job application has been sent to Randstad Canada, pending submission.',
 ])assert.equal(receipt(text),'',text);
 assert.equal(applicationEvidence({confirmation:message,receipt_event:0}).confirmed,false);
 assert.equal(applicationEvidence({confirmation:message,receipt_event:1}).confirmed,true);
 assert.equal(applicationEvidence({confirmation:'Applicant verified: '+message,receipt_event:1}).confirmed,true);
});

test('ATS allowlist and job identity reject lookalikes and other applications',()=>{
 for(const url of ['https://jobs.ashbyhq.com/example/123','https://jobs.smartrecruiters.com/example/123','https://apply.workable.com/example/j/123','https://example.bamboohr.com/careers/123','https://example.recruitee.com/o/123','https://example.wd1.myworkdayjobs.com/en-US/jobs/job/123'])assert(supported(url));
 for(const url of ['https://lever.co.evil.test/x','http://jobs.lever.co/x','https://user:pass@jobs.lever.co/x','https://jobs.lever.co:444/x','not a url'])assert(!supported(url));
 assert(sameApplication('https://jobs.lever.co/org/123/apply?source=feed','https://jobs.lever.co/org/123'));
 assert(sameApplication('https://boards.greenhouse.io/org/jobs/123?lang=fr-CA','https://job-boards.greenhouse.io/org/jobs/123?locale=en-US'));
 assert(sameApplication('https://example.wd1.myworkdayjobs.com/fr-CA/jobs/job/123?source=feed','https://example.wd1.myworkdayjobs.com/en-US/jobs/job/123'));
 assert(!sameApplication('https://jobs.lever.co/org/123','https://jobs.lever.co/org/456'));
 assert(!sameApplication('https://example.bamboohr.com/careers?jobId=1','https://example.bamboohr.com/careers?jobId=2'));
});
test('Saved memory is exact, unambiguous and never invents sensitive facts',()=>{
 assert.equal(savedAnswer(' Work authorized? *',{'Work authorized?':'No'}),'No');
 assert.equal(savedAnswer('Work authorized?',{'Work authorized?':'No','work authorized?':'Yes'}),null);
 for(const q of ['Employer name','Degree','Employment dates','License number','Security clearance'])assert.equal(savedAnswer(q,{}),null);
 for(const q of ['I certify these statements','Electronic signature','Credit card number','I agree to the terms']){assert(sensitive(q));assert.equal(savedAnswer(q,{[q]:'Yes'}),null);}
 assert.equal(savedAnswer('Years of experience',{'Years of experience':0}),'0');
 assert(!receipt('Please submit your application'));assert(receipt('Your application has been received'));
});

test('failure, hypothetical and quoted receipt text never count as employer confirmation',()=>{
 for(const text of ['No application received. Please try again.','Your application was received with errors and could not be processed.','Your application has been submitted, pending processing.','Once your application has been received, we will email you.','The next page will say "Thank you for applying".','Your application received an error.'])assert.equal(receipt(text),'',text);
 for(const text of ['Your application has been received.','Application submitted successfully.','Thank you for applying.','Thank you for your application!'])assert(receipt(text),text);
 assert.equal(receipt('Your job application has been sent to Randstad Canada.'),'Your job application has been sent to Randstad Canada.');
});

test('adjacent application failures override polite receipts without rejecting unrelated footer negation',()=>{
 for(const text of ['Thank you for applying. Your application could not be submitted.','Your application has been received. It could not be processed.','Your job application has been sent to Randstad Canada. Delivery failed.','Thank you for applying. No application received.','Thank you for applying. Your application could not be sent.','Thank you for applying. Your application submission was unsuccessful.','Thank you for applying. An error occurred while submitting your application.'])assert.equal(receipt(text),'',text);
 for(const text of ['Your application has been received; no further action is needed.','Your application has been received. Do not reply to this email.','Your application has been received. You do not need to reapply.'])assert(receipt(text),text);
});

test('standalone dashboard and extension use identical receipt policy',async()=>{
 const {readFileSync}=await import('node:fs');const {runInNewContext}=await import('node:vm');const box={};runInNewContext(readFileSync(new URL('./web/form-policy.js',import.meta.url),'utf8'),box);
 assert.equal(box.ApplyPilotPolicy.receipt.toString(),receipt.toString());
});
