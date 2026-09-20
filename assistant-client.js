const $=s=>document.querySelector(s);let token=sessionStorage.getItem('applypilot-token')||'',people=[];
const notice=s=>$('#notice').textContent=s;
async function api(path,method='GET',data){const r=await fetch((location.hostname.endsWith('netlify.app')?'https://marvelous-vitality-production-c2d8.up.railway.app':'')+'/api'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d;}
function voice(id){const R=window.SpeechRecognition||window.webkitSpeechRecognition;if(!R){notice('Use your phone keyboard microphone to dictate into this field.');$('#'+id).focus();return;}const r=new R();r.lang='en-CA';r.onresult=e=>{$('#'+id).value=e.results[0][0].transcript;notice('Review the dictated text before saving or sending.');};r.onerror=e=>notice('Microphone: '+e.error);r.start();notice('Listening…');}
document.addEventListener('click',e=>{if(e.target.dataset.voice)voice(e.target.dataset.voice)});
function profile(){const p=people.find(p=>p.id===$('#applicant').value);$('#profile').replaceChildren();if(!p)return;for(const key of ['name','email','phone','location','focus']){const label=document.createElement('label');label.textContent=key;const input=document.createElement('input');input.id='p-'+key;input.name=key;input.value=p[key]||'';label.append(input);const button=document.createElement('button');button.type='button';button.textContent='Speak '+key;button.dataset.voice=input.id;$('#profile').append(label,button);}const b=document.createElement('button');b.textContent='Save profile';$('#profile').append(b);}
async function status(){
 const [s,j,r,a]=await Promise.all([api('/status'),api('/jobs'),api('/searches'),api('/activity')]);
 $('#status').textContent=(s.workerOnline?'Worker online':'Worker not reporting')+' · Updated '+new Date().toLocaleTimeString()+' · '+s.queue.map(x=>`${x.count} ${x.status}`).join(', ');
 const selected=$('#applicant').value;
 $('#jobs').replaceChildren();
 for(const job of j.jobs.filter(x=>x.applicant_id===selected)){
  const row=document.createElement('p'),link=document.createElement('a');link.href=job.url;link.target='_blank';link.rel='noopener';link.textContent=job.title+' — '+job.company;
  row.append(link,document.createTextNode(': '+job.status+(job.challenge?' ('+job.challenge+')':'')));$('#jobs').append(row);
 }
 $('#runs').replaceChildren();
 for(const run of r.searches.filter(x=>x.applicant_id===selected)){
  const row=document.createElement('p'),v=run.last_result;
  row.textContent=run.instruction+' · '+(run.enabled?'Scheduled':'Disabled')+' · '+(run.auto_queue?'Automatic queue ON':'Save for review')+' · '+(v?`${v.scanned} scanned, ${v.matched} matched, ${v.added} added, ${v.queued} queued`:'No completed scan recorded')+(run.last_error?' · '+run.last_error:'');
  $('#runs').append(row);
 }
 $('#activity').replaceChildren();for(const event of a.events.filter(x=>x.applicant_id===selected)){
  const row=document.createElement('p');row.textContent=new Date(event.at).toLocaleString()+' · '+event.title+' · '+event.message;$('#activity').append(row);
 }
}
async function load(){people=(await api('/applicants')).applicants;$('#login').hidden=true;$('#workspace').hidden=false;$('#applicant').replaceChildren();for(const p of people){const o=document.createElement('option');o.value=p.id;o.textContent=p.name;$('#applicant').append(o);}profile();await status();}
$('#applicant').onchange=()=>{profile();status().catch(e=>notice(e.message))};
$('#auth').onsubmit=async e=>{e.preventDefault();try{token=(await api('/login','POST',Object.fromEntries(new FormData(e.target)))).token;sessionStorage.setItem('applypilot-token',token);await load();notice('Signed in');}catch(e){notice(e.message)}};
$('#logout').onclick=()=>{sessionStorage.removeItem('applypilot-token');location.reload()};
$('#search').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{notice('Searching employer boards and feeds… The results will appear here when the scan completes.');const s=await api('/searches','POST',{applicant_id:$('#applicant').value,instruction:$('#instruction').value,boards:$('#boards').value,auto_queue:$('#auto').checked});const r=await api('/searches/'+s.id+'/run','POST',{});notice(`Scanned ${r.scanned}; matched ${r.matched}; saved ${r.added}; queued ${r.queued}. ${r.errors.join('; ')}`);await status();}catch(e){notice(e.message)}finally{b.disabled=false}};
$('#chat').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{$('#reply').textContent=(await api('/chat','POST',{applicant_id:$('#applicant').value,message:$('#message').value})).reply;}catch(e){notice(e.message)}finally{b.disabled=false}};
$('#profile').onsubmit=async e=>{e.preventDefault();try{const p=people.find(p=>p.id===$('#applicant').value),fields=Object.fromEntries(new FormData(e.target));await api('/applicants/'+p.id,'PUT',{...p,...fields,consent:!!p.consent,ai_consent:!!p.ai_consent});Object.assign(p,fields);notice('Profile saved');}catch(e){notice(e.message)}};
if(token)load().catch(e=>notice(e.message));setInterval(()=>{if(token)status().catch(e=>notice(e.message))},15000);
