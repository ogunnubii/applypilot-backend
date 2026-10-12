const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('jsdom');
test('content monitor recovers transient state and receipt failures without filling or submitting again',async()=>{
 const dom=new JSDOM('<main>Waiting for employer response</main>',{runScripts:'outside-only',url:'https://jobs.lever.co/org/role'}),w=dom.window,calls=[];let failState=true,failReceipt=true,time=100000,clicks=0;
 w.Date.now=()=>time;w.HTMLElement.prototype.getClientRects=()=>[{}];Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});w.HTMLElement.prototype.click=()=>clicks++;
 w.chrome={runtime:{onMessage:{addListener(){}},sendMessage:async m=>{calls.push(m);if(m.action==='state')return failState?{ok:false,error:'HTTP 502',status:502}:{ok:true,data:{attempted:true,automatic:false,refreshEnabled:false}};if(m.action==='receipt')return failReceipt?{ok:false,error:'Disconnected'}:{ok:true,data:{pending:true}};return {ok:true,data:{}};}}};
 w.eval(fs.readFileSync('extension/policy.js','utf8'));
 w.eval(fs.readFileSync('extension/content.js','utf8').replace(/begin\(\);\s*\}\)\(\);/,`packet={job:{id:'j',title:'Fixture'},answers:{},profile:{}};started=true;attempted=true;mount();window.check=monitor;window.monitorState=()=>({stopped,monitorFailures});})();`));
 try{
  await w.check();assert.equal(w.monitorState().stopped,false);assert.equal(w.monitorState().monitorFailures,1);
  failState=false;time+=100000;w.document.querySelector('main').textContent='Your application has been received.';
  await w.check();assert.equal(w.monitorState().stopped,false);
  // Receipt remains captured even if the employer navigates away before sync.
  w.document.querySelector('main').textContent='Careers';time+=100000;failReceipt=false;await w.check();
  assert.equal(w.monitorState().stopped,true);assert.equal(calls.filter(m=>m.action==='receipt').length,2);
  assert.equal(calls.filter(m=>['packet','attempt','capture','form-opened','answer','step'].includes(m.action)).length,0);assert.equal(clicks,0);
 }finally{w.close();}
});
