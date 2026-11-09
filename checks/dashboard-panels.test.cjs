const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
const root=path.join(__dirname,'..'),script=fs.readFileSync(path.join(root,'web/dashboard-panels.js'),'utf8');
// Every employer, question and URL below is a synthetic fixture.
function page(){
 const dom=new JSDOM('<!doctype html><main id="workspace"><div id="workspace-tools-body"></div></main>',{url:'http://localhost:8088/assistant',runScripts:'outside-only'});
 dom.window.eval(script);return dom;
}
const inbox=()=>({total:3,employer:1,jobs:[
 {id:'job-a',company:'Fixture Labs',title:'Platform Engineer',url:'https://jobs.lever.co/fixture/a',mode:'browser',formKey:'key-a',editing:false,questions:[
  {question:'Mailing address',kind:'answer',reuse:false},
  {question:'Years of Kubernetes experience',kind:'answer',reuse:true},
  {question:'Do you consent to this interview being recorded?',kind:'employer'}]},
 {id:'job-b',company:'<img src=x onerror=alert(1)>',title:'SRE',url:'javascript:alert(1)',mode:'hosted',formKey:'key-b',editing:true,questions:[
  {question:'<b>Why</b> here?',kind:'answer',reuse:false}]}
]});
function recorder(result={ok:true,remembered:false,resume:{state:'queued',message:'Answers saved. The helper will continue this form in its tab. Final Submit stays yours.'}}){
 const calls=[];const api=async(url,method='GET',data)=>{calls.push({url,method,data});return url==='/answers-inbox'?inbox():result;};return {calls,api};
}

test('connection banner shows only while something is offline',()=>{
 const {window:w}=page(),d=w.document;
 w.ApplyPilotPanels.renderConnection({ok:false,message:'The Chrome helper last checked in 5 minutes ago.'});
 const box=d.querySelector('#connection-status');
 assert.equal(box.hidden,false);assert.equal(box.getAttribute('role'),'status');assert.match(box.textContent,/5 minutes ago/);
 assert.equal(d.querySelector('#workspace').firstElementChild,box,'the banner sits at the top of the dashboard');
 w.ApplyPilotPanels.renderConnection({ok:true,message:'Worker and Chrome helper are connected.'});
 assert.equal(box.hidden,true);
});

test('renders questions as text, keeps consents on the employer page and offers reuse only where allowed',async()=>{
 const {window:w}=page(),d=w.document,{calls,api}=recorder();
 await w.ApplyPilotPanels.update({api,place:node=>d.querySelector('#workspace-tools-body').append(node)});
 assert.deepEqual(calls,[{url:'/answers-inbox',method:'GET',data:undefined}],'rendering only reads');
 const box=d.querySelector('#workspace-tools-body #answers-needed');
 assert(box&&!box.hidden);
 assert.match(box.querySelector('[role=status]').textContent,/3 answers needed across 2 applications · 1 to answer on the employer page/);
 assert.match(box.textContent,/Final Submit stays yours/);
 assert.equal(box.querySelectorAll('textarea').length,3,'employer-page questions get no input');
 assert.match(box.textContent,/Answer on the employer page:Do you consent to this interview being recorded\?/);
 assert.equal(box.querySelectorAll('input[type=checkbox]').length,1,'only the reusable fact offers reuse');
 assert.equal(box.querySelectorAll('small').length>=2,true);assert.match(box.textContent,/Kept with this application only\./);
 assert.equal(box.querySelector('img'),null);assert.equal(box.querySelector('b'),null,'employer text is never parsed as HTML');
 assert.match(box.textContent,/<img src=x onerror=alert\(1\)> · SRE/);
 const links=[...box.querySelectorAll('a')];assert.equal(links.length,1,'non-http links are not rendered');
 assert.equal(links[0].href,'https://jobs.lever.co/fixture/a');assert.equal(links[0].rel,'noopener noreferrer');
 const locked=box.querySelectorAll('textarea')[2];assert.equal(locked.disabled,true,'a form being edited in its tab is read-only here');
});

test('saving posts exactly the typed answer, scoped unless reuse is ticked',async()=>{
 const {window:w}=page(),d=w.document,{calls,api}=recorder();let refreshed=0;
 await w.ApplyPilotPanels.update({api,refresh:async()=>{refreshed++;}});
 const [address,years]=d.querySelectorAll('#answers-needed textarea'),[saveAddress,saveYears]=[...d.querySelectorAll('#answers-needed button')];
 saveAddress.click();await new Promise(r=>setTimeout(r,0));
 assert.equal(calls.length,1,'an empty answer is never sent');
 address.value='  55 Fixture Street ';address.dispatchEvent(new w.Event('input'));
 saveAddress.click();await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(JSON.parse(JSON.stringify(calls[1])),{url:'/answers-inbox/answer',method:'POST',data:{jobId:'job-a',question:'Mailing address',answer:'55 Fixture Street',remember:false,formKey:'key-a'}});
 assert.equal(refreshed,1);
 years.value='5';years.dispatchEvent(new w.Event('input'));d.querySelector('#answers-needed input[type=checkbox]').checked=true;
 saveYears.click();await new Promise(r=>setTimeout(r,0));
 assert.equal(calls[2].data.remember,true);assert.equal(calls[2].data.answer,'5');
});

test('a server refusal is shown and the typed text stays',async()=>{
 const {window:w}=page(),d=w.document,calls=[];
 const api=async(url,method,data)=>{calls.push({url,method,data});if(url==='/answers-inbox')return inbox();throw Error('This form changed since the list loaded. Refresh Answers needed.');};
 await w.ApplyPilotPanels.update({api});
 const input=d.querySelector('#answers-needed textarea'),save=d.querySelector('#answers-needed button');
 input.value='55 Fixture Street';input.dispatchEvent(new w.Event('input'));save.click();await new Promise(r=>setTimeout(r,0));
 assert.match(save.nextElementSibling.textContent,/form changed/);assert.equal(input.value,'55 Fixture Street');assert.equal(save.disabled,false);
});

test('unsaved typing is never replaced by a refresh',async()=>{
 const {window:w}=page(),d=w.document,{api}=recorder();
 await w.ApplyPilotPanels.update({api});
 const input=d.querySelector('#answers-needed textarea');input.value='half typed';input.dispatchEvent(new w.Event('input'));
 const changed=inbox();changed.jobs.pop();changed.total=2;
 w.ApplyPilotPanels.renderAnswersInbox(changed,{});
 assert.equal(d.querySelector('#answers-needed textarea'),input);assert.equal(input.value,'half typed');
 input.value='';input.dispatchEvent(new w.Event('input'));
 w.ApplyPilotPanels.renderAnswersInbox(changed,{});
 assert.notEqual(d.querySelector('#answers-needed textarea'),input,'clean panels refresh');
});

test('the dashboard loads the panels before its own script and calls them on refresh',()=>{
 const html=fs.readFileSync(path.join(root,'assistant-page.html'),'utf8'),client=fs.readFileSync(path.join(root,'assistant-client.js'),'utf8');
 assert(html.indexOf('src="/dashboard-panels.js"')>0&&html.indexOf('src="/dashboard-panels.js"')<html.indexOf('src="/assistant.js"'));
 assert.match(client,/globalThis\.ApplyPilotPanels\?\.update\(\{api,place:placeWorkspacePanel,refresh:\(\)=>refresh\(true\),connection:health\.connection\}\)/);
});
