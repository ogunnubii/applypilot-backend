import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {watchSubmission} from './submission-diagnostics.js';
test('embedded form diagnostics observe the owning browser page network',async()=>{
 const page=new EventEmitter(),frame={page:()=>page,url:()=> 'https://jobs.ashbyhq.com/example/role',evaluate:async()=>({missing:[]})};
 const watcher=watchSubmission(frame);watcher.start();const request={url:()=>frame.url(),method:()=> 'POST'};page.emit('request',request);page.emit('response',{request:()=>request,status:()=>403});
 assert.match(await watcher.describe(),/1 employer POST request\(s\) observed; response status 403/);watcher.stop();assert.equal(page.listenerCount('request'),0);
});

test('diagnostics distinguish network errors without storing applicant data or implying receipt',async()=>{
 const page=new EventEmitter();page.url=()=> 'https://jobs.ashbyhq.com/employer/role';page.evaluate=async()=>({missing:['Private field'],captcha:false});
 const watcher=watchSubmission(page),request=(url,method='POST')=>({url:()=>url,method:()=>method});
 const ignored=request('https://jobs.ashbyhq.com/private?token=secret');page.emit('request',ignored);assert.equal(await watcher.describe(),'');
 watcher.start();page.emit('request',request('https://other.test/tracker'));page.emit('request',request(page.url(),'GET'));
 const sent=request('https://jobs.ashbyhq.com/api?email=secret@example.test'),failed=request(page.url());
 page.emit('request',sent);page.emit('response',{request:()=>sent,status:()=>503});page.emit('request',failed);page.emit('requestfailed',failed);
 const note=await watcher.describe();assert.match(note,/2 employer POST/);assert.match(note,/503/);assert.match(note,/1 network failure/);assert.match(note,/1 field/);assert.match(note,/not a receipt/);
 for(const privateText of ['secret','Private field','http','token','email'])assert(!note.includes(privateText));
 watcher.stop();assert.equal(page.listenerCount('request'),0);assert.equal(page.listenerCount('response'),0);assert.equal(page.listenerCount('requestfailed'),0);
});

test('HTTP 200 or no observed POST never becomes confirmation; late verification is reported',async()=>{
 const page=new EventEmitter();page.url=()=> 'https://jobs.lever.co/example/role';page.evaluate=async()=>({missing:[],captcha:true});
 const watcher=watchSubmission(page);watcher.start();assert.match(await watcher.describe(),/0 employer POST/);
 const request={url:()=>page.url(),method:()=> 'POST'};page.emit('request',request);page.emit('response',{request:()=>request,status:()=>200});
 const note=await watcher.describe();assert.match(note,/200/);assert.match(note,/verification is visible/);assert.match(note,/Only an employer receipt/);watcher.stop();
});
