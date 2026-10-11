import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sameApplication,receipt} from './local-policy.js';
import {hostedFormState} from './hosted-form-state.js';
const worker=readFileSync(new URL('./worker.js',import.meta.url),'utf8');
test('hosted claims never silently take ownership of local-browser applications',()=>{
 assert.equal((worker.match(/applicant_id IN \(SELECT id FROM applicants WHERE execution_mode='cloud'\) AND local_owner IS NULL/g)||[]).length,1);
 assert(!worker.includes("OR local_owner IS NULL AND EXISTS"));
});
test('hosted flow checks exact job identity before filling, final click and receipt',()=>{
 assert(worker.includes('sameApplication(frame.url(),job.url)'));
 assert(worker.includes("'Application identity changed'"));
 assert(worker.includes("const result=await submitHostedApplication({page,job,submit,review"));
 const url='https://jobs.lever.co/fixture/role-123';
 assert(sameApplication(url+'/apply',url));
 assert(sameApplication(url+'/thanks',url));
 assert(!sameApplication('https://jobs.lever.co/different/role-456/thanks',url));
 assert(receipt('Your application has been received'));
});
test('hosted validation ignores disabled controls but rejects invalid nonempty values',()=>{
 assert(hostedFormState.toString().includes("e.disabled||e.matches(':disabled')"));
 assert(hostedFormState.toString().includes("e.willValidate&&e.validity?.valid===false"));
});
test('actual hosted review detects invalid saved values and ignores disabled required inputs',async()=>{
 const {JSDOM}=await import('jsdom');
 const dom=new JSDOM('<label>Contact<input type="email" required value="invalid"></label><input required disabled><fieldset disabled><input required></fieldset><input required value="filled">',{runScripts:'outside-only'});
 Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 dom.window.HTMLElement.prototype.getBoundingClientRect=()=>({width:100,height:20});
 const code=worker.slice(worker.indexOf('async function review(page)'),worker.indexOf('\nasync function custom(page'));
 dom.window.hostedFormState=dom.window.eval('('+hostedFormState.toString()+')');
 const review=dom.window.eval('('+code+')');
 const state=await review({evaluate:fn=>fn()});
 assert.deepEqual([...state.missing],['Contact']);
 dom.window.document.querySelector('input').value='fixture@example.test';
 assert.equal((await review({evaluate:fn=>fn()})).missing.length,0);
 dom.window.close();
});
