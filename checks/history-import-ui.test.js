import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

test('successful history import refreshes the dashboard and keeps its saved-result message',async()=>{
 const dom=new JSDOM('<main id="workspace"></main>',{runScripts:'outside-only'}),w=dom.window;
 const source=readFileSync(new URL('../assistant-client.js',import.meta.url),'utf8');
 let records=[],refreshes=0,posted;
 w.$=selector=>w.document.querySelector(selector);
 w.el=(tag,text)=>{const node=w.document.createElement(tag);node.textContent=text||'';return node;};
 w.placeWorkspacePanel=node=>w.document.querySelector('main').append(node);
 w.refresh=async()=>{refreshes++;};w.externalRecords=[];w.overviewSignature='old';
 w.api=async(path,method,body)=>{
  assert.equal(path,'/application-history');
  if(method==='POST'){posted=body.rows;records=body.rows;return {added:1,updated:0,total:1,blocked:1,active:[]};}
  return {records};
 };
 try{
  w.eval(source.slice(source.indexOf('function mountExternalHistory(){'),source.indexOf('mountExternalHistory();')+'mountExternalHistory();'.length));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(refreshes,0);
  w.document.querySelector('textarea').value='Example | Cloud Engineer | applied | Prior external application';
  await w.document.querySelector('form').onsubmit({preventDefault(){}});
  assert.equal(posted[0].company,'Example');assert.equal(refreshes,1);assert.equal(w.externalRecords.length,1);
  assert.match(w.document.querySelector('[role="status"]').textContent,/1 added, 0 existing records merged; 1 total. 1 pending duplicates blocked/);
  assert.equal(w.document.querySelector('textarea').value,'');assert.equal(w.document.querySelector('button[type="submit"]').disabled,false);
  await [...w.document.querySelectorAll('button')].find(button=>button.textContent==='Refresh imported history').onclick();
  assert.equal(refreshes,2);
 }finally{w.close();}
});
