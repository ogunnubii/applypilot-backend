import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

for(const file of ['assistant-client.js','web/progress.js'])test(file+' saves remote preference and reports failure without changing automation',async()=>{
 const dom=new JSDOM('<section id="discovery-status"></section><p id="notice"></p>',{runScripts:'outside-only'}),w=dom.window;
 const calls=[];let reject=false;w.$=s=>w.document.querySelector(s);w.el=(tag,text)=>{const e=w.document.createElement(tag);if(text)e.textContent=text;return e;};w.api=async(path,method,data)=>{calls.push({path,method,data});if(method==='PUT'){if(reject)throw Error('Could not save preference');return {scope:{preferRemote:data.preferRemote,preferBusinessContract:true,allowEmploymentFallback:true}};}return {intervalSeconds:60,searches:[{id:'s',enabled:1,instruction:'Canada and worldwide',scope_json:JSON.stringify({preferRemote:false,preferBusinessContract:true,allowEmploymentFallback:true})},{id:'legacy',enabled:0,instruction:'Legacy search'}]};};
 const source=readFileSync(new URL('../'+file,import.meta.url),'utf8');w.eval(source.slice(source.indexOf('async function updateDiscovery('),source.indexOf('\nconst rememberLogin=')));
 try{await w.updateDiscovery(true);assert.equal(w.document.querySelectorAll('input[type=checkbox]').length,1);const input=w.document.querySelector('input');input.checked=true;await input.onchange();assert.equal(input.checked,true);assert.equal(input.disabled,false);assert.match(w.document.querySelector('[role=status]').textContent,/Saved\. Remote first/);assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(c=>c.method))),[{path:'/searches/s/preferences',method:'PUT',data:{preferRemote:true}}]);
 reject=true;input.checked=false;await input.onchange();assert.equal(input.checked,true);assert.equal(input.disabled,false);assert.match(w.document.querySelector('[role=status]').textContent,/Could not save/);
 }finally{w.close();}
});
