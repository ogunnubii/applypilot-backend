const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
test('observed Lever radio markup asks the real question, fills saved facts with AI off, and leaves unknown answers and Submit alone',async()=>{
 const question='Are you legally authorized to work in the country you are applying for?',unknown='Do you require an accommodation for the interview?';
 const radios=q=>'<li class="application-question custom-question"><div><div class="application-label full-width multiple-choice"><div class="text">'+q+'<span class="required">✱</span></div></div><div class="application-field full-width required-field"><ul data-qa="multiple-choice">'+['yes','no'].map(v=>'<li><label><input type="radio" name="'+(q===question?'authorization':'accommodation')+'" value="'+v+'" required><span class="application-answer-alternative">'+v+'</span></label></li>').join('')+'</ul></div></div></li>';
 const dom=new JSDOM('<form><ul>'+radios(question)+radios(unknown)+'</ul><label>When can you start a new role?<input id="start" required></label><label>Can you please share a link to your LinkedIn Profile?<input id="linkedin" required></label><button type="button" id="submit">Submit application</button></form>',{runScripts:'outside-only',url:'https://jobs.lever.co/fixture/123/apply'}),w=dom.window,messages=[],requests=[];let clicks=0;
 Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});w.HTMLElement.prototype.getClientRects=()=>[{}];w.setInterval=()=>0;w.clearInterval=()=>{};w.document.getElementById('submit').onclick=()=>clicks++;
 w.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(m){messages.push(m);if(m.action==='packet')return {ok:true,data:{job:{title:'Senior DevOps Engineer'},profile:{},answers:{LinkedIn:'https://www.linkedin.com/in/fixture'},savedFactsAvailable:true,aiAssistance:false,autonomousSubmit:false,prepareSteps:true}};if(m.action==='state')return {ok:true,data:{automatic:true,attempted:false,autonomousSubmit:false,prepareSteps:true}};if(m.action==='answer'){requests.push(m);return {ok:true,data:{answer:m.question.startsWith(question)?'yes':m.question==='When can you start a new role?'?'Immediately':''}};}return {ok:true,data:{}};}}};
 try{
  w.eval(read('extension/policy.js'));w.eval(read('extension/content.js'));
  for(let i=0;i<200&&!messages.some(m=>m.action==='progress'&&m.blocked);i++)await new Promise(r=>setTimeout(r,20));
  assert(requests.some(m=>m.question.startsWith(question)&&Array.from(m.choices).join(',')==='yes,no'));
  assert(!requests.some(m=>['yes','no'].includes(m.question)));
  assert.equal(w.document.querySelector('[name="authorization"]:checked')?.value,'yes');
  assert.equal(w.document.querySelector('[name="accommodation"]:checked'),null);
  assert.equal(w.document.getElementById('start').value,'Immediately');
  assert.equal(w.document.getElementById('linkedin').value,'https://www.linkedin.com/in/fixture');
  assert.equal(clicks,0);assert(!messages.some(m=>m.action==='attempt'||m.action==='receipt'));
  const progress=messages.findLast(m=>m.action==='progress'&&m.blocked);assert(progress);assert(progress.fields.some(q=>q.startsWith(unknown)));assert(!progress.fields.some(q=>['yes','no'].includes(q)));
 }finally{w.close();}
});
