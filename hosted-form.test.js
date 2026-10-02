import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {approvedHostedCheckbox,approvedHostedRadioIndex,hostedFieldAnswer,hostedOptionChoice,protectedHostedQuestion,scopedHostedComboboxOptions} from './hosted-form.js';

test('hosted routine controls require one exact saved answer',()=>{
 const answers={'Preferred office':'Toronto','Email me job updates':'Yes','Work schedule':'Hybrid'};
 const choice=hostedOptionChoice({label:'Preferred office'},[
  {index:0,label:'Vancouver',value:'van'},
  {index:1,label:'Toronto',value:'tor'}
 ],{},answers);
 assert.equal(choice?.index,1);
 assert.equal(approvedHostedCheckbox('Email me job updates',answers),true);
 assert.equal(approvedHostedRadioIndex([
  {question:'Work schedule',label:'Remote'},
  {question:'Work schedule',label:'Hybrid'}
 ],answers),1);
 assert.equal(hostedOptionChoice({label:'Preferred office'},[
  {index:0,label:'Toronto',value:'one'},
  {index:1,label:'Toronto',value:'two'}
 ],{},answers),null);
});

test('hosted controls never approve protected legal or demographic answers',()=>{
 for(const question of ['I certify this application is accurate','Gender','Work authorization','I agree to arbitration']){
  assert.equal(protectedHostedQuestion(question),true);
  assert.equal(approvedHostedCheckbox(question,{[question]:'Yes'}),null);
 }
});

test('hosted combobox options stay within an explicit ARIA relationship',()=>{
 const options=[
  {index:0,label:'Unrelated Toronto',scopeIds:['other-list'],newlyVisible:true,group:'other'},
  {index:1,label:'Toronto',scopeIds:['office-list'],newlyVisible:true,group:'office'}
 ];
 assert.deepEqual(scopedHostedComboboxOptions(options,{scopeIds:['office-list'],opened:true}).map(x=>x.index),[1]);
 assert.deepEqual(scopedHostedComboboxOptions(options,{scopeIds:['missing-list'],opened:true}),[]);
 assert.deepEqual(scopedHostedComboboxOptions(options,{scopeIds:['office-list'],opened:false}),[]);
});

test('hosted combobox fallback requires newly visible options in one container',()=>{
 const safe=[
  {index:0,label:'Old option',newlyVisible:false,group:'old'},
  {index:1,label:'Toronto',newlyVisible:true,group:'opened-list'},
  {index:2,label:'Vancouver',newlyVisible:true,group:'opened-list'}
 ];
 assert.deepEqual(scopedHostedComboboxOptions(safe,{opened:true}).map(x=>x.index),[1,2]);
 assert.deepEqual(scopedHostedComboboxOptions([...safe,{index:3,label:'Remote',newlyVisible:true,group:'second-list'}],{opened:true}),[]);
 assert.deepEqual(scopedHostedComboboxOptions(safe,{opened:false}),[]);
});

test('structured setup answers use the canonical hosted profile keys',()=>{
 const answers={City:'Toronto','Province / State':'Ontario',Country:'Canada','Postal code':'M5V 2T6',LinkedIn:'https://linkedin.com/in/example',GitHub:'https://github.com/example',School:'Example University',Degree:'BSc','Field of study':'Computer Science'};
 for(const [label,key] of [['City','City'],['State','Province / State'],['Country','Country'],['ZIP code','Postal code'],['LinkedIn profile','LinkedIn'],['GitHub URL','GitHub'],['University','School'],['Degree type','Degree'],['Major','Field of study']])assert.equal(hostedFieldAnswer({label},{},answers)?.answer,answers[key]);
});

test('setup captures each structured profile field under its canonical answer key',()=>{
 const html=fs.readFileSync(new URL('./web/setup.html',import.meta.url),'utf8'),source=fs.readFileSync(new URL('./web/setup.js',import.meta.url),'utf8');
 for(const name of ['city','region','country','postal','linkedin','github','school','degree','discipline'])assert.match(html,new RegExp(`name=["']${name}["']`));
 for(const [name,key] of [['city','City'],['region','Province / State'],['country','Country'],['postal','Postal code'],['linkedin','LinkedIn'],['github','GitHub'],['school','School'],['degree','Degree'],['discipline','Field of study']])assert.match(source,new RegExp(`${name}:["']${key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}["']`));
 assert.match(html,/Automatically prepare strong matches/);
 assert.doesNotMatch(html,/Automatically apply to strong matches/);
});

test('hosted worker prepares the form and leaves final submission to the applicant',()=>{
 const source=fs.readFileSync(new URL('./worker.js',import.meta.url),'utf8');
 assert.match(source,/Ready to submit — review the filled application and click Submit/);
 assert.doesNotMatch(source,/await\s+submit\.click\s*\(/);
 assert.doesNotMatch(source,/event\([^\n]+['"]automatic_submission['"]/);
 assert.doesNotMatch(source,/requiresHumanReview\(await page\.locator\(['"]body['"]\)/);
 assert.match(source,/if\(requiredMissing\.length\)/);
 assert.match(source,/function claim\(\)\{if\(handoffs\?\.full\(\)\)return null/);
});
