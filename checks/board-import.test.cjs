// Synthetic LinkedIn/Indeed results pages: only Easy Apply / Indeed Apply cards
// not already applied are offered, and nothing is added until the user clicks.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
function load(html,url){
 const w=new JSDOM(html,{runScripts:'outside-only',url}).window,messages=[];
 w.chrome={runtime:{async sendMessage(m){messages.push(m);return {ok:true,data:{added:m.jobs.length,existing:0,duplicates:0}};}}};
 w.eval(read('extension/policy.js'));w.eval(read('extension/board-import.js'));
 return {w,messages,button:()=>w.document.querySelector('[data-applypilot-import] button')};
}
test('LinkedIn results: Easy Apply cards only, one click, canonical job ids',async()=>{
 const h=load(`<ul>
  <li data-job-id="1"><a href="/jobs/view/4012345678/?trk=x" aria-label="Senior Site Reliability Engineer">Senior SRE</a><div class="artdeco-entity-lockup__subtitle">Acme Cloud</div><div class="job-card-container__metadata-item">Canada (Remote)</div><span>Easy Apply</span></li>
  <li data-job-id="2"><a href="/jobs/view/4012345679/">Platform Engineer</a><div class="artdeco-entity-lockup__subtitle">Globex</div></li>
  <li data-job-id="3"><a href="/jobs/view/4012345670/">Cloud Engineer</a><span>Applied</span><span>Easy Apply</span></li></ul>`,'https://www.linkedin.com/jobs/search/?keywords=sre');
 try{
  assert.equal(h.button().textContent,'Add 1 Easy Apply job to ApplyPilot');assert.equal(h.messages.length,0,'nothing is sent before the click');
  h.button().click();await new Promise(r=>setTimeout(r,20));
  assert.equal(h.messages.length,1);const m=h.messages[0];assert.equal(m.action,'board-import');assert.equal(m.board,'linkedin');
  assert.deepEqual(JSON.parse(JSON.stringify(m.jobs)),[{url:'https://www.linkedin.com/jobs/view/4012345678',title:'Senior Site Reliability Engineer',company:'Acme Cloud',location:'Canada (Remote)'}]);
  assert.match(h.w.document.querySelector('[data-applypilot-import] [role="status"]').textContent,/Added 1.*skipped 2/);
 }finally{h.w.close();}
});
test('Indeed results: Indeed Apply ("Easily apply") cards only, keeping the regional site',async()=>{
 const h=load(`<div class="job_seen_beacon"><h2 class="jobTitle"><a data-jk="0123456789abcdef"><span title="DevOps Engineer">DevOps Engineer</span></a></h2><span data-testid="company-name">Hooli</span><div data-testid="text-location">Remote in Canada</div><span>Easily apply</span></div>
  <div class="job_seen_beacon"><h2 class="jobTitle"><a data-jk="fedcba9876543210"><span title="SRE">SRE</span></a></h2><span data-testid="company-name">Initech</span></div>`,'https://ca.indeed.com/jobs?q=devops&l=Remote');
 try{
  assert.equal(h.button().textContent,'Add 1 Indeed Apply job to ApplyPilot');h.button().click();await new Promise(r=>setTimeout(r,20));
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages[0].jobs)),[{url:'https://ca.indeed.com/viewjob?jk=0123456789abcdef',title:'DevOps Engineer',company:'Hooli',location:'Remote in Canada'}]);
 }finally{h.w.close();}
});
test('a page without job cards shows nothing',()=>{
 const h=load('<main><h1>Feed</h1></main>','https://www.linkedin.com/jobs/search/');try{assert.equal(h.button(),null);}finally{h.w.close();}
});
