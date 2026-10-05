const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
test('cooldowns stay in collapsed history while verified employer links appear on active job cards',async()=>{
 const root=path.join(__dirname,'..'),dom=new JSDOM(fs.readFileSync(path.join(root,'assistant-page.html'),'utf8'),{runScripts:'outside-only',url:'https://marvelous-vitality-production-c2d8.up.railway.app/'}),w=dom.window;
 w.sessionStorage.setItem('applypilot-token','fixture');w.setInterval=()=>0;
 const jobs=[{id:'current',status:'needs_review',title:'Infrastructure Engineer',company:'HUD',challenge:'Posting review',url:'https://jobs.ashbyhq.com/hud/a',official_careers:{url:'https://www.hud.ai/careers',note:'Official careers page.'}}];
 const deferred=[{id:'held',company:'Ashby',title:'Platform Engineer',cooldown:{kind:'employer',estimated:true,reason:'Application limit reached',until:'2026-11-30T12:00:00Z'}}];
 w.fetch=async url=>({ok:true,json:async()=>{const p=String(url).replace('/api','');if(p==='/jobs')return {jobs,deferred};if(p==='/status')return {workerOnline:true};if(p==='/application-history')return {records:[]};if(p==='/operations')return {applications:[],totals:{}};if(p==='/searches')return {searches:[]};return {enabled:false,parked:0};}});
 w.eval(fs.readFileSync(path.join(root,'extension/policy.js'),'utf8'));w.eval(fs.readFileSync(path.join(root,'assistant-client.js'),'utf8'));await new Promise(r=>setTimeout(r,100));
 assert.equal(w.document.querySelectorAll('.job').length,1);assert.equal(w.document.querySelector('#job-held'),null);
 const history=w.document.querySelector('#cooldown-history');assert.equal(history.open,false);assert.match(history.textContent,/Done for now/);assert.match(history.textContent,/not a successful submission/);
 assert.equal(w.document.querySelector('#job-current .company-careers a').href,'https://www.hud.ai/careers');
 assert.equal(w.document.querySelector('#notice').textContent,'');w.close();
});
