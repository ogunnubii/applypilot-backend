const message=document.querySelector('#message'),jobs=document.querySelector('#jobs');
async function request(action,data={}){
 let timer;const timeout=['list','review-prepared'].includes(action)?90000:20000;
 const r=await Promise.race([chrome.runtime.sendMessage({action,...data}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('The browser helper took too long to respond. Refresh and try again.')),timeout);})]).finally(()=>clearTimeout(timer));
 if(!r?.ok)throw Error(r?.error||'Extension unavailable');return r.data;
}
let loadGeneration=0,actionBusy=false;
async function load(){const generation=++loadGeneration;try{
 message.textContent='Checking filled forms…';const data=await request('list');if(generation!==loadGeneration)return;
 document.querySelector('#environment').value=data.state.environment||'hosted';document.querySelector('#start').hidden=!!data.state.enabled;document.querySelector('#stop').hidden=!data.state.enabled;jobs.replaceChildren();
 const ready=data.jobs.filter((job,index,all)=>ApplyPilotReadyForms.listed(job)&&all.findIndex(other=>other.id===job.id)===index).sort((a,b)=>(Number(a.queue_position)||Infinity)-(Number(b.queue_position)||Infinity));
 const numbers=document.querySelector('#numbers');numbers.replaceChildren();const cell=document.createElement('div'),count=document.createElement('strong'),label=document.createElement('span');cell.className='number';count.textContent=String(ready.length);label.textContent='Filled forms ready for your Submit click';cell.append(count,label);numbers.append(cell);
 for(const job of ready){
  const article=document.createElement('article'),title=document.createElement('strong'),company=document.createElement('small'),openButton=document.createElement('button'),status=document.createElement('p'),availability=document.createElement('small');
  article.dataset.jobId=job.id;status.setAttribute('role','status');status.className='job-action-status';title.textContent=job.title;company.textContent=job.company;
  availability.textContent=job.ready_form.source==='hosted'?'Filled form retained until '+new Date(job.ready_form.expires_at).toLocaleString():'Filled form in your existing browser tab';article.append(title,company,availability);
  openButton.textContent='Open filled form';let opening=false;
  openButton.onclick=async()=>{if(opening||actionBusy)return;opening=true;actionBusy=true;++loadGeneration;openButton.disabled=true;status.textContent='Checking and opening your filled form…';try{await request('review-prepared',{id:job.id});status.textContent='Filled form opened. Review it and click the employer’s Submit button.';}catch(error){status.textContent=error.message;}finally{opening=false;actionBusy=false;openButton.disabled=false;}};
  article.append(openButton,status);jobs.append(article);
 }
 if(!ready.length){const empty=document.createElement('p');empty.textContent='No filled forms are ready yet. Prepared forms appear here after their required fields and final Submit step are checked.';jobs.append(empty);}
 message.textContent=data.unavailable?'Some prepared forms could not be reached. Refresh to check them again.':data.state.error||'You make the final Submit click. Opening a filled form does not restart autofill.';
 }catch(error){if(generation===loadGeneration){jobs.replaceChildren();document.querySelector('#numbers').replaceChildren();message.textContent=error.message;}}}
for(const action of ['dashboard','funnel','start','stop'])document.querySelector('#'+action).onclick=async()=>{try{await request(action);if(!['dashboard','funnel'].includes(action))await load();}catch(error){message.textContent=error.message;}};
document.querySelector('#settings').onclick=()=>{const box=document.querySelector('#controls');box.hidden=!box.hidden;document.querySelector('#settings').setAttribute('aria-expanded',String(!box.hidden));};
document.querySelector('#environment').onchange=async e=>{try{await request('environment',{value:e.target.value});message.textContent='Open ApplyPilot and sign in.';}catch(error){message.textContent=error.message;}};
document.querySelector('#refresh').onclick=()=>{if(!actionBusy)load();};load();
setInterval(()=>{if(!actionBusy)load();},15000);
