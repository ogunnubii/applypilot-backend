import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {hostedFormState} from '../hosted-form-state.js';
import {hostedFieldAnswer} from '../hosted-form.js';

// Exercise the exact smoke-test helper wiring without launching Chromium. A
// browser test must not fail from a missing closure dependency before it tests
// the real input and Submit behavior.
test('hosted browser smoke injects form-state dependencies into both extracted worker helpers',async()=>{
 const smoke=readFileSync(new URL('./hosted-input-browser-smoke.cjs',import.meta.url),'utf8');
 const worker=readFileSync(new URL('../worker.js',import.meta.url),'utf8');
 const wiring=smoke.slice(smoke.indexOf(' const fillSource='),smoke.indexOf(' const browser='));
 const calls=[],locator={
  evaluate:async fn=>{assert.equal(fn,hostedFormState);calls.push('describe');return {label:'Full name',type:'text'};},
  inputValue:async()=>''
 };
 const {fill,review}=new Function('worker','hostedFieldAnswer','fillHostedText','hostedFormState',wiring+';return {fill,review};')(
  worker,hostedFieldAnswer,async(field,value)=>{assert.equal(field,locator);assert.equal(value,'Fixture Applicant');calls.push('fill');return true;},hostedFormState);
 const page={
  locator:()=>({count:async()=>1,nth:()=>locator}),
  evaluate:async fn=>{assert.equal(fn,hostedFormState);calls.push('review');return {missing:[]};}
 };
 assert.equal(await fill(page,{name:'Fixture Applicant',answers_json:'{}'}),1);
 assert.deepEqual(await review(page),{missing:[]});
 assert.deepEqual(calls,['describe','fill','review']);
});
