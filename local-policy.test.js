import test from 'node:test';
import assert from 'node:assert/strict';
import {supported,sameApplication,sensitive,savedAnswer,receipt} from './local-policy.js';

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
