const message=document.querySelector('#message'),jobs=document.querySelector('#jobs');
async function request(action,data={}){
 let timer;const timeout=action==='open'?90000:20000;
 const r=await Promise.race([chrome.runtime.sendMessage({action,...data}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('The browser helper took too long to respond. Refresh and try again.')),timeout);})]).finally(()=>clearTimeout(timer));
 if(!r?.ok)throw Error(r?.error||'Extension unavailable');return r.data;
}
let loadGeneration=0,actionBusy=false;
function unfinished(job){return ['saved','queued','paused','needs_review','local_browser'].includes(job.status)&&!job.employer_hold&&job.metadata?.available!==false&&!job.local_attempt_at&&!job.evidence?.confirmed&&!job.evidence?.awaiting&&!['Unconfirmed submission','Submission in progress'].includes(job.challenge);}
async function load(){const generation=++loadGeneration;try{
 message.textContent='Loading…';const data=await request('list');if(generation!==loadGeneration)return;
 document.querySelector('#environment').value=data.state.environment||'hosted';document.querySelector('#start').hidden=!!data.state.enabled;document.querySelector('#stop').hidden=!data.state.enabled;jobs.replaceChildren();
 const unique=data.jobs.filter((job,index,all)=>all.findIndex(other=>other.id===job.id)===index),pending=data.batch?.enabled?unique.filter(j=>data.batch.job_ids.includes(j.id)&&!['submitted','interview','rejected','offer','archived','duplicate'].includes(j.status)):data.focus?.enabled?unique.filter(j=>j.id===data.focus.job_id):unique.filter(unfinished),attention=ApplyPilotPolicy.attentionOrder(pending),positions=new Map(attention.map((job,index)=>[job.id,index+1]));
 const totals=data.totals||{},numbers=document.querySelector('#numbers');numbers.replaceChildren();
 for(const [label,value]of [['Completed',totals.completed??unique.filter(j=>j.evidence?.completed||j.evidence?.confirmed).length],['Confirmed',totals.confirmed??unique.filter(j=>j.evidence?.confirmed).length],['Forms filled / attempted',totals.worked??unique.filter(j=>j.evidence?.worked).length],['Left to complete',pending.length],['Need your input',attention.length]]){const cell=document.createElement('div'),count=document.createElement('strong'),text=document.createElement('span');cell.className='number';count.textContent=String(value);text.textContent=label;cell.append(count,text);numbers.append(cell);}
 const ordered=pending.sort((a,b)=>(positions.get(a.id)||Infinity)-(positions.get(b.id)||Infinity)||(Number(a.queue_position)||Infinity)-(Number(b.queue_position)||Infinity)||(Number(b.match_score)||0)-(Number(a.match_score)||0));
 for(const [index,job] of ordered.entries()){
  const article=document.createElement('article'),title=document.createElement('strong'),company=document.createElement('small'),openButton=document.createElement('button'),status=document.createElement('p'),count=document.createElement('div');
  article.dataset.jobId=job.id;status.setAttribute('role','status');status.className='job-action-status';title.textContent=job.title;company.textContent=job.company;count.className='attention-position';count.textContent=(index+1)+'/'+ordered.length;
  if(positions.has(job.id))count.setAttribute('aria-label','Application '+positions.get(job.id)+' of '+attention.length+' needing your input');article.append(count,title,company);if(data.focus?.enabled){const p=data.focus.progress,progress=document.createElement('p');progress.textContent=p?.percent!=null?p.percent+'% of current-step required fields filled ('+p.filled+'/'+p.required+'). '+(data.focus.awaiting?'Awaiting employer receipt.':'Not yet submitted.'):'Waiting to measure the selected form.';article.append(progress);}
  const pay=job.metadata?.pay?.[0];if(pay){const salary=document.createElement('small');salary.className='job-pay';salary.textContent=pay.currency+' '+Number(pay.annualMin).toLocaleString()+(pay.annualMin===pay.annualMax?'':'–'+Number(pay.annualMax).toLocaleString())+' / year'+(pay.estimated?' (estimate)':'');article.append(salary);}
  openButton.textContent='Open & autofill';let opening=false;
  openButton.onclick=async()=>{if(opening||actionBusy)return;opening=true;actionBusy=true;openButton.hidden=true;complete.hidden=true;status.textContent='Opening this application and filling saved answers…';try{const result=await request('open',{id:job.id,auto:false});status.textContent=result.attempted?'A Submit click is already recorded. Check the employer receipt.':'Form opened. Review the answers and click Submit when ready.';}catch(error){status.textContent=error.message;}finally{opening=false;actionBusy=false;openButton.hidden=false;complete.hidden=false;}};
  const complete=document.createElement('button');complete.textContent='Mark completed';complete.className='complete';complete.title='Record that you submitted this application. Employer confirmation remains separate.';
  complete.onclick=async()=>{if(opening||actionBusy)return;opening=true;actionBusy=true;openButton.hidden=true;complete.hidden=true;status.textContent='Recording completion.';try{await request('mark-completed',{id:job.id});await load();}catch(error){status.textContent=error.message;openButton.hidden=false;complete.hidden=false;}finally{opening=false;actionBusy=false;}};
  article.append(openButton,complete,status);jobs.append(article);
 }
 if(!pending.length){const empty=document.createElement('p');empty.textContent='No jobs left to complete right now.';jobs.append(empty);}
 message.textContent=data.state.error||'';
 }catch(error){if(generation===loadGeneration)message.textContent=error.message;}}
for(const action of ['dashboard','funnel','start','stop'])document.querySelector('#'+action).onclick=async()=>{try{await request(action);if(!['dashboard','funnel'].includes(action))await load();}catch(error){message.textContent=error.message;}};
document.querySelector('#settings').onclick=()=>{const box=document.querySelector('#controls');box.hidden=!box.hidden;document.querySelector('#settings').setAttribute('aria-expanded',String(!box.hidden));};
document.querySelector('#environment').onchange=async e=>{try{await request('environment',{value:e.target.value});message.textContent='Open ApplyPilot and sign in.';}catch(error){message.textContent=error.message;}};
document.querySelector('#refresh').onclick=load;load();

setInterval(()=>{if(!actionBusy)load();},15000);
