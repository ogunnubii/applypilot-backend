const message=document.querySelector('#message'),jobs=document.querySelector('#jobs');
async function request(action,data={}){
 let timer;const timeout=action==='open'?90000:20000;
 const r=await Promise.race([chrome.runtime.sendMessage({action,...data}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('The browser helper took too long to respond. Refresh the dashboard and check the application before retrying.')),timeout);})]).finally(()=>clearTimeout(timer));
 if(!r?.ok)throw Error(r?.error||'Extension unavailable');return r.data;
}
let loadGeneration=0;
function blocker(job){return job.employer_hold?.message||(job.status!=='local_browser'&&job.metadata?.available===false?'This posting is marked unavailable. Open the employer posting to review it.':'');}
async function load(){const generation=++loadGeneration;try{
 message.textContent='Loading…';const data=await request('list');if(generation!==loadGeneration)return;
 document.querySelector('#environment').value=data.state.environment||'hosted';jobs.replaceChildren();
 const attention=ApplyPilotPolicy.attentionOrder(data.jobs),positions=new Map(attention.map((job,index)=>[job.id,index+1]));
 const total=document.createElement('p');total.textContent=attention.length+' applications need your input';total.setAttribute('role','status');jobs.append(total);
 const ordered=data.jobs.filter((job,index,all)=>all.findIndex(other=>other.id===job.id)===index).sort((a,b)=>(positions.get(a.id)||Infinity)-(positions.get(b.id)||Infinity));
 for(const job of ordered.filter(j=>['saved','queued','paused','needs_review','local_browser'].includes(j.status))){
  const article=document.createElement('article'),title=document.createElement('strong'),openButton=document.createElement('button'),auto=document.createElement('button'),status=document.createElement('p');
  article.dataset.jobId=job.id;status.setAttribute('role','status');status.className='job-action-status';title.textContent=job.title+' · '+job.company;
  if(positions.has(job.id)){const count=document.createElement('div');count.className='attention-position';count.textContent=positions.get(job.id)+'/'+attention.length+' · Needs your input';count.setAttribute('aria-label','Application '+positions.get(job.id)+' of '+attention.length+' needing your input');article.append(count);}
  const reason=blocker(job);status.textContent=reason||(job.local_attempt_at?'A prior Submit click is recorded. Check the employer receipt before submitting again.':'');
  openButton.textContent='Open & autofill';auto.textContent='Prepare automatically';openButton.disabled=!!reason;auto.disabled=!!reason||!!job.local_attempt_at;
  async function run(automatic){
   const before=[openButton.disabled,auto.disabled];openButton.disabled=true;auto.disabled=true;
   status.textContent=automatic?'Preparing this application…':'Opening this application and starting autofill…';
   try{const result=await request('open',{id:job.id,auto:automatic});status.textContent=result.attempted?'Employer form opened for review. A prior Submit click is recorded; check its receipt.':automatic?'Preparation started in a browser tab. Use Open & autofill to bring it forward.':'Employer form opened. Saved-answer filling has started; review the form before Submit.';}
   catch(error){status.textContent=error.message;}
   finally{[openButton.disabled,auto.disabled]=before;}
  }
  openButton.onclick=()=>run(false);auto.onclick=()=>run(true);
  article.append(title,document.createElement('br'),auto,openButton,status);
  if(reason&&ApplyPilotPolicy.supported(job.url)){const link=document.createElement('a');link.href=job.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='View employer posting';article.append(link);}
  jobs.append(article);
 }
 message.textContent=data.state.error||(data.state.enabled?'Automatic mode on — '+data.state.queue.length+' waiting; checks every 30 seconds':'Automation stopped. Saved applications are retained.');
 }catch(error){if(generation===loadGeneration)message.textContent=error.message;}}
for(const action of ['dashboard','start','stop'])document.querySelector('#'+action).onclick=async()=>{try{await request(action);if(action!=='dashboard')await load();}catch(error){message.textContent=error.message;}};
document.querySelector('#environment').onchange=async e=>{try{await request('environment',{value:e.target.value});message.textContent='Open ApplyPilot and sign in.';}catch(error){message.textContent=error.message;}};
document.querySelector('#refresh').onclick=load;load();
