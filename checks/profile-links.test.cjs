const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const links={LinkedIn:'https://www.linkedin.com/in/test-person',GitHub:'https://github.com/test-person',Website:'https://portfolio.example'};
const prompts={LinkedIn:['LinkedIn','Your LinkedIn profile','Please share your LinkedIn profile URL','LinkedIn link'],GitHub:['GitHub','Your GitHub profile','Please provide a link to your GitHub','GitHub profile link'],Website:['Website','Personal website','Website / portfolio','Portfolio link','Your website URL','Please enter your website','Please share a link to your portfolio below']};

test('personal link variants use distinct saved profile facts and do not infer missing links',async()=>{
 const context={};vm.runInNewContext(read('extension/policy.js'),context);const p=context.ApplyPilotPolicy;
 const {hostedFieldAnswer}=await import('../hosted-form.js');
 for(const [key,questions]of Object.entries(prompts))for(const question of questions){
  assert.equal(p.knownAnswer(question,{},links),links[key],question);
  assert.equal(hostedFieldAnswer({label:question,type:'url'},{},links)?.answer,links[key],question);
 }
 for(const question of ['Company website','Employer GitHub','Your manager LinkedIn profile','Referrer LinkedIn','Website where you found this job','Link to a specific GitHub project']){
  assert.equal(p.knownAnswer(question,{},links),null,question);assert.equal(hostedFieldAnswer({label:question,type:'url'},{},links),null,question);
 }
 assert.equal(p.knownAnswer('Website',{}, {GitHub:links.GitHub}),null);
 assert.equal(p.knownAnswer('LinkedIn',{}, {GitHub:links.GitHub}),null);
 assert.equal(p.knownAnswer('Personal website',{}, {Website:links.Website,Portfolio:'https://different.example'}),null);
 assert.equal(p.knownAnswer('Website',{website:links.Website},{}),links.Website);
});

test('setup saves and reloads website without discarding other profile answers',()=>{
 const {JSDOM}=require('jsdom'),dom=new JSDOM(read('web/setup.html')),f=dom.window.document.querySelector('#profile');
 const source=read('web/setup.js'),start=source.indexOf('const PROFILE_ANSWER_FIELDS='),end=source.indexOf('\n',source.indexOf('function savedProfileAnswers('));
 const context={};vm.runInNewContext(source.slice(start,end)+';globalThis.fields=PROFILE_ANSWER_FIELDS;',context);
 for(const [name,key]of Object.entries(context.fields))f.elements[name].value=links[key]||'';
 const saved=context.savedProfileAnswers(f,{'Unrelated answer':'Preserved'});
 assert.equal(saved.Website,links.Website);assert.equal(saved.LinkedIn,links.LinkedIn);assert.equal(saved.GitHub,links.GitHub);assert.equal(saved['Unrelated answer'],'Preserved');
 f.reset();for(const [name,key]of Object.entries(context.fields))f.elements[name].value=saved[key]||'';
 assert.equal(f.elements.website.value,links.Website);
 f.elements.website.value='';assert.equal(context.savedProfileAnswers(f,saved).Website,undefined);dom.window.close();
});

test('the browser automatically fills three separate link fields and leaves Submit to the user',async()=>{
 const {JSDOM}=require('jsdom'),dom=new JSDOM('<form><label>Your LinkedIn profile<input id="linkedin" type="url" required></label><label>GitHub profile link<input id="github" type="url"></label><label>Website / portfolio<input id="website" type="url"></label><label>Company website<input id="company" type="url"></label><button type="button">Submit application</button></form>',{runScripts:'outside-only',url:'https://jobs.lever.co/example/test'}),w=dom.window;
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent}});w.HTMLElement.prototype.getClientRects=function(){return [{}]};w.setInterval=()=>0;
 let clicks=0;const messages=[];w.document.querySelector('button').onclick=()=>clicks++;
 w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);return {ok:true,data:m.action==='packet'?{job:{title:'Fixture'},profile:{},answers:links}:m.action==='state'?{automatic:true,attempted:false}:{}};}}};
 w.eval(read('extension/policy.js'));w.eval(read('extension/content.js'));await new Promise(r=>setTimeout(r,60));
 for(const [id,key]of [['linkedin','LinkedIn'],['github','GitHub'],['website','Website']])assert.equal(w.document.getElementById(id).value,links[key],id);
 assert.equal(w.document.getElementById('company').value,'');assert.equal(clicks,0);assert(!messages.some(m=>m.action==='attempt'));w.close();
});
