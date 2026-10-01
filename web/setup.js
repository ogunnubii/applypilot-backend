



// Persist only an explicitly remembered session, never the password.
function restoreSession(){const remembered=localStorage.getItem('applypilot-remembered-token');if(remembered)sessionStorage.setItem('applypilot-token',remembered);return remembered||sessionStorage.getItem('applypilot-token')||'';}
function saveSession(value,remember){sessionStorage.setItem('applypilot-token',value);if(remember)localStorage.setItem('applypilot-remembered-token',value);else localStorage.removeItem('applypilot-remembered-token');}
function clearSession(){sessionStorage.removeItem('applypilot-token');localStorage.removeItem('applypilot-remembered-token');localStorage.setItem('applypilot-signout',String(Date.now()));}
window.addEventListener('storage',e=>{if(e.key==='applypilot-signout'){sessionStorage.removeItem('applypilot-token');location.reload();}});
function rememberOption(form){const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.name='remember';box.style.cssText='width:auto;display:inline;margin-right:8px';label.style.cssText='display:block;margin:12px 0';label.append(box,document.createTextNode('Keep me signed in on this computer for up to 30 days'));const button=form.querySelector('button');if(button)button.before(label);else form.append(label);return box;}
const API=(location.hostname.endsWith('.netlify.app')||location.hostname.endsWith('.pages.dev'))?'https://marvelous-vitality-production-c2d8.up.railway.app/api':'/api';
const $=s=>document.querySelector(s);let token=restoreSession(),profiles=[];
async function api(path,method='GET',data){const r=await fetch(API+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d;}
const notice=message=>$('#message').textContent=message;
async function load(){profiles=(await api('/applicants')).applicants;const select=$('#profiles'),chosen=select.value;select.replaceChildren(new Option('Create a new profile',''));for(const p of profiles)select.add(new Option(p.name,p.id));select.value=chosen;renderCurrentResume();}
const rememberLogin=rememberOption($('#account'));
$('#account').onsubmit=async e=>{e.preventDefault();try{token=(await api('/'+e.submitter.value,'POST',{...Object.fromEntries(new FormData(e.target)),remember:rememberLogin.checked})).token;saveSession(token,rememberLogin.checked);await load();notice('Signed in. Choose or create your applicant profile.');}catch(err){notice(err.message);}};
$('#profiles').onchange=()=>{const p=profiles.find(p=>p.id===$('#profiles').value),f=$('#profile');f.reset();if(p){for(const k of ['name','email','phone','location','focus','execution_mode'])f.elements[k].value=p[k]||'';f.elements.consent.checked=!!p.consent;if(f.elements.ai_consent)f.elements.ai_consent.checked=!!p.ai_consent;if(f.elements.google_research_consent)f.elements.google_research_consent.checked=!!p.google_research_consent;if(f.elements.background)f.elements.background.value=p.answers?.['Professional background']||'';}renderCurrentResume();};
$('#profile').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{const f=e.target,existing=profiles.find(p=>p.id===$('#profiles').value),data={...Object.fromEntries(new FormData(f)),consent:f.elements.consent.checked,answers:{...existing?.answers,...(f.elements.background?{'Professional background':f.elements.background.value.trim()}:{})},ai_consent:f.elements.ai_consent?f.elements.ai_consent.checked:!!existing?.ai_consent,google_research_consent:f.elements.google_research_consent?f.elements.google_research_consent.checked:!!existing?.google_research_consent};let id=existing?.id;if(id)await api('/applicants/'+id,'PUT',data);else id=(await api('/applicants','POST',data)).id;const file=$('#resume').files[0];let warning='';if(file){const r=await fetch(API+'/applicants/'+id+'/resume',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':file.name.toLowerCase().endsWith('.pdf')?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},body:file});const d=await r.json();if(!r.ok)throw Error(d.error);warning=d.resumeNotice||'';}await load();$('#profiles').value=id;renderCurrentResume();notice('Profile saved. '+warning);}catch(err){notice(err.message);}finally{button.disabled=false;}};
for(const name of ['job','search'])if($('#'+name))$('#'+name).onsubmit=async e=>{e.preventDefault();try{const id=$('#profiles').value;if(!id)throw Error('Save or select an applicant profile first.');const data={...Object.fromEntries(new FormData(e.target)),applicant_id:id};if(name==='search'){data.auto_queue=e.target.elements.auto_queue.checked;const r=await api('/searches','POST',data);await api('/searches/'+r.id+'/run','POST',{});}else await api('/jobs','POST',data);notice(name==='job'?'Job added to Found. Open Applications and choose Apply automatically.':'Search completed. Review found jobs in the dashboard.');}catch(err){notice(err.message);}};
if(token)load().catch(err=>notice(err.message));




if((location.hostname.endsWith('.netlify.app')||location.hostname.endsWith('.pages.dev')))document.querySelector('#open-dashboard').href='/automate.html';




for (const choice of document.querySelectorAll('[name="source-choice"]')) choice.addEventListener('change',()=>{const direct=choice.value==='job';if($('#job'))$('#job').hidden=!direct;if($('#search'))$('#search').hidden=direct;});

let resumeBlobUrl=null,previousResumeBlobUrl=null,resumeEditorProfile=null,resumeDraftId=null;
function renderCurrentResume(){
 const box=$('#current-resume');if(!box)return;box.replaceChildren();const p=profiles.find(p=>p.id===$('#profiles').value);
 if(!p)return;
 const label=document.createElement('p');label.textContent=p.has_resume?'A resume is saved for '+p.name+'. Applications attach this file.':'No resume is saved for this profile.';box.append(label);
 const edit=document.createElement('button');edit.type='button';edit.className='secondary';edit.textContent='Edit resume text';box.append(edit);edit.onclick=()=>openResumeEditor(p.id);
 if(!p.has_resume)return;
 const button=document.createElement('button');button.type='button';button.textContent='View current resume';box.append(button);
 button.onclick=async()=>{button.disabled=true;try{
  const data=await api('/applicants/'+p.id+'/resume');
  if(resumeBlobUrl)URL.revokeObjectURL(resumeBlobUrl);
  resumeBlobUrl=URL.createObjectURL(new Blob([Uint8Array.from(atob(data.base64),c=>c.charCodeAt(0))],{type:data.mime}));
  $('#resume-preview-title').textContent=data.applicant+' · Current resume';
  $('#resume-preview-note').textContent=data.name+' · '+Math.round(data.bytes/1024)+' KB. This is the saved file attached to new applications. '+(data.previewNotice||'Text preview below; download the original to see its formatting.');
  $('#resume-original').href=resumeBlobUrl;$('#resume-original').download=data.name;
  $('#resume-previous').hidden=!data.hasPrevious;$('#resume-previous').onclick=async e=>{if(!$('#resume-previous').href){e.preventDefault();try{const previous=await api('/applicants/'+p.id+'/resume-previous');if(previousResumeBlobUrl)URL.revokeObjectURL(previousResumeBlobUrl);previousResumeBlobUrl=URL.createObjectURL(new Blob([Uint8Array.from(atob(previous.base64),c=>c.charCodeAt(0))],{type:previous.mime}));$('#resume-previous').href=previousResumeBlobUrl;$('#resume-previous').download=previous.name;$('#resume-previous').click();}catch(error){notice(error.message);}}};$('#resume-previous').removeAttribute('href');
  $('#resume-preview-text').textContent=data.text||'No readable text found.';
  $('#resume-preview').showModal();
 }catch(err){notice(err.message);}finally{button.disabled=false;}};
}
$('#close-resume').onclick=()=>$('#resume-preview').close();

function invalidateResumeDraft(){resumeDraftId=null;$('#save-edited-resume').disabled=true;$('#resume-editor-pages').replaceChildren();}
async function openResumeEditor(id){
 resumeEditorProfile=id;invalidateResumeDraft();$('#resume-editor').hidden=false;$('#resume-editor-status').textContent='Loading your saved resume…';
 try{const p=profiles.find(p=>p.id===id),data=p?.has_resume?await api('/applicants/'+id+'/resume'):{text:''};
 if(resumeEditorProfile!==id)return;$('#resume-editor-text').value=data.text||'';$('#resume-editor-status').textContent='Edit the text, then preview the exact PDF before saving.';
 $('#resume-editor').scrollIntoView({behavior:'smooth',block:'start'});
 }catch(error){$('#resume-editor-status').textContent=error.message;}
}
$('#resume-editor-text').addEventListener('input',()=>{invalidateResumeDraft();$('#resume-editor-status').textContent='Text changed. Preview it again before saving.';});
$('#preview-edited-resume').onclick=async()=>{
 const id=resumeEditorProfile,content=$('#resume-editor-text').value,button=$('#preview-edited-resume');
 if(!id||id!==$('#profiles').value)return $('#resume-editor-status').textContent='Select the same profile, then open its resume editor.';
 button.disabled=true;invalidateResumeDraft();$('#resume-editor-status').textContent='Building the PDF and its page previews…';
 try{const result=await api('/applicants/'+id+'/resume-edit','POST',{action:'preview',text:content});
 if(resumeEditorProfile!==id||$('#resume-editor-text').value!==content)return;
 resumeDraftId=result.draftId;$('#save-edited-resume').disabled=false;
 for(const [index,data]of result.pages.entries()){const img=document.createElement('img');img.alt='Revised resume PDF page '+(index+1);img.src='data:image/png;base64,'+data;img.style.cssText='display:block;width:100%;height:auto;border:1px solid #dfe7e1';$('#resume-editor-pages').append(img);}
 $('#resume-editor-status').textContent=result.pages.length+' PDF page(s) ready. Review the pages, then use this resume for new applications.';
 }catch(error){$('#resume-editor-status').textContent=error.message;}finally{button.disabled=false;}
};
$('#save-edited-resume').onclick=async()=>{
 const id=resumeEditorProfile,draftId=resumeDraftId;if(!id||!draftId||id!==$('#profiles').value)return;
 const button=$('#save-edited-resume');button.disabled=true;
 try{const result=await api('/applicants/'+id+'/resume-edit','POST',{action:'save',draftId});
 resumeDraftId=null;$('#resume-editor-status').textContent='Saved '+result.name+' as your application resume. New applications will attach this PDF.'+(result.previousSaved?' Your previous resume is retained.':'');
 $('#resume').value='';await load();$('#profiles').value=id;renderCurrentResume();notice('Revised resume saved for '+profiles.find(p=>p.id===id)?.name+'. New applications will use this PDF.');
 }catch(error){$('#resume-editor-status').textContent=error.message;button.disabled=false;}
};
$('#cancel-edited-resume').onclick=()=>{resumeEditorProfile=null;invalidateResumeDraft();$('#resume-editor').hidden=true;};
