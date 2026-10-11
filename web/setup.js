



// Persist only an explicitly remembered session, never the password.
function restoreSession(){const remembered=localStorage.getItem('applypilot-remembered-token');if(remembered)sessionStorage.setItem('applypilot-token',remembered);return remembered||sessionStorage.getItem('applypilot-token')||'';}
function saveSession(value,remember){sessionStorage.setItem('applypilot-token',value);if(remember)localStorage.setItem('applypilot-remembered-token',value);else localStorage.removeItem('applypilot-remembered-token');}
function clearSession(){sessionStorage.removeItem('applypilot-token');localStorage.removeItem('applypilot-remembered-token');localStorage.setItem('applypilot-signout',String(Date.now()));}
window.addEventListener('storage',e=>{if(e.key==='applypilot-signout'){sessionStorage.removeItem('applypilot-token');location.reload();}});
function rememberOption(form){const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.name='remember';box.style.cssText='width:auto;display:inline;margin-right:8px';label.style.cssText='display:block;margin:12px 0';label.append(box,document.createTextNode('Keep me signed in on this computer for up to 30 days'));const button=form.querySelector('button');if(button)button.before(label);else form.append(label);return box;}
const API=(location.hostname.endsWith('.netlify.app')||location.hostname.endsWith('.pages.dev'))?'https://marvelous-vitality-production-c2d8.up.railway.app/api':'/api';
const $=s=>document.querySelector(s);let token=restoreSession(),profiles=[],accountGeneration=0,profileGeneration=0,accountSubmitting=false;
const PROFILE_ANSWER_FIELDS=Object.freeze({city:'City',region:'Province / State',country:'Country',postal:'Postal code',linkedin:'LinkedIn',github:'GitHub',website:'Website',school:'School',degree:'Degree',discipline:'Field of study',availability:'Available to start',canada_authorization:'Work authorization - Canada',canada_sponsorship:'Visa sponsorship now or in future - Canada',over18:'Over 18 - applicant confirmed'});
function savedProfileAnswers(form,existing={}){const answers={...existing};for(const [name,key]of Object.entries(PROFILE_ANSWER_FIELDS)){const value=form.elements[name]?.value.trim()||'';if(value)answers[key]=value;else delete answers[key];}const background=form.elements.background?.value.trim()||'';if(background)answers['Professional background']=background;else delete answers['Professional background'];return answers;}
async function api(path,method='GET',data){const r=await fetch(API+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d;}
const notice=message=>$('#message').textContent=message;
function resetProfileWorkspace(){
 profileGeneration++;$('#profile').reset();$('#resume').value='';$('#current-resume').replaceChildren();
 resumeEditorProfile=null;resumeDraftId=null;$('#resume-editor').hidden=true;$('#resume-editor-text').value='';$('#resume-editor-status').textContent='';$('#resume-editor-pages').replaceChildren();$('#save-edited-resume').disabled=true;
 if(resumeBlobUrl)URL.revokeObjectURL(resumeBlobUrl);if(previousResumeBlobUrl)URL.revokeObjectURL(previousResumeBlobUrl);resumeBlobUrl=previousResumeBlobUrl=null;
 const preview=$('#resume-preview');if(preview.open&&typeof preview.close==='function')preview.close();else preview.removeAttribute('open');
 $('#resume-preview-title').textContent='Your current resume';$('#resume-preview-note').textContent='';$('#resume-preview-text').textContent='';
 for(const id of ['resume-original','resume-previous']){const link=$('#'+id);link.removeAttribute('href');link.removeAttribute('download');link.onclick=null;}$('#resume-previous').hidden=true;
 experienceGeneration++;experienceEditing=null;$('#experience-form')?.reset();if($('#experience-form'))$('#experience-form').hidden=true;$('#experience-list')?.replaceChildren();if($('#experience-status'))$('#experience-status').textContent='Choose a saved profile above to add experience.';if($('#experience-cancel'))$('#experience-cancel').hidden=true;
}
function resetAccountWorkspace(){
 accountGeneration++;profiles=[];$('#profiles').replaceChildren(new Option('Create a new profile',''));resetProfileWorkspace();
 $('#job')?.reset();$('#search')?.reset();notice('');
}
async function load(){
 const generation=accountGeneration,session=token,data=await api('/applicants');if(generation!==accountGeneration||session!==token)return;
 profiles=data.applicants||[];const select=$('#profiles'),chosen=select.value;select.replaceChildren(new Option('Create a new profile',''));for(const p of profiles)select.add(new Option(p.name,p.id));
 select.value=profiles.some(p=>p.id===chosen)?chosen:profiles.length===1?profiles[0].id:'';select.dispatchEvent(new Event('change'));
}
const rememberLogin=rememberOption($('#account'));
$('#account').onsubmit=async e=>{
 e.preventDefault();if(accountSubmitting)return;accountSubmitting=true;const buttons=[...e.target.querySelectorAll('button')];for(const button of buttons)button.disabled=true;
 try{const result=await api('/'+e.submitter.value,'POST',{...Object.fromEntries(new FormData(e.target)),remember:rememberLogin.checked});if(!result.token)throw Error('No sign-in session was returned. Try again.');
 resetAccountWorkspace();token=result.token;saveSession(token,rememberLogin.checked);e.target.elements.password.value='';await load();notice('Signed in. Choose or create your applicant profile.');
 }catch(err){notice(err.message);}finally{accountSubmitting=false;for(const button of buttons)button.disabled=false;}
};
$('#profiles').onchange=()=>{
 const p=profiles.find(p=>p.id===$('#profiles').value),f=$('#profile');resetProfileWorkspace();
 if(p){for(const k of ['name','email','phone','location','focus','execution_mode'])f.elements[k].value=p[k]||'';for(const [name,key]of Object.entries(PROFILE_ANSWER_FIELDS))f.elements[name].value=p.answers?.[key]||'';f.elements.consent.checked=!!p.consent;if(f.elements.ai_consent)f.elements.ai_consent.checked=!!p.ai_consent;if(f.elements.google_research_consent)f.elements.google_research_consent.checked=!!p.google_research_consent;if(f.elements.gemini_facts_consent)f.elements.gemini_facts_consent.checked=!!p.gemini_facts_consent;if(f.elements.background)f.elements.background.value=p.answers?.['Professional background']||'';}renderCurrentResume();
};
$('#profile').onsubmit=async e=>{e.preventDefault();const button=e.submitter,generation=accountGeneration,session=token,selectedProfile=$('#profiles').value,file=$('#resume').files[0];button.disabled=true;try{const f=e.target,existing=profiles.find(p=>p.id===$('#profiles').value),data={...Object.fromEntries(new FormData(f)),consent:f.elements.consent.checked,answers:savedProfileAnswers(f,existing?.answers),ai_consent:f.elements.ai_consent?f.elements.ai_consent.checked:!!existing?.ai_consent,gemini_facts_consent:f.elements.gemini_facts_consent?f.elements.gemini_facts_consent.checked:!!existing?.gemini_facts_consent,google_research_consent:f.elements.google_research_consent?f.elements.google_research_consent.checked:!!existing?.google_research_consent};let id=existing?.id;if(id)await api('/applicants/'+id,'PUT',data);else id=(await api('/applicants','POST',data)).id;if(generation!==accountGeneration||session!==token)return;let warning='';if(file){const r=await fetch(API+'/applicants/'+id+'/resume',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':file.name.toLowerCase().endsWith('.pdf')?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},body:file});const d=await r.json();if(!r.ok)throw Error(d.error);warning=d.resumeNotice||'';}if(generation!==accountGeneration||session!==token)return;await load();if(generation!==accountGeneration||session!==token)return;$('#profiles').value=id;$('#profiles').dispatchEvent(new Event('change'));notice('Profile saved. '+warning);}catch(err){notice(err.message);}finally{button.disabled=false;}};
for(const name of ['job','search'])if($('#'+name))$('#'+name).onsubmit=async e=>{
 e.preventDefault();const form=e.target;if(form.dataset.saving)return;form.dataset.saving='1';const button=form.querySelector('button');if(button)button.disabled=true;let savedSearchId='';
 try{
  const id=$('#profiles').value;if(!id)throw Error('Save or select an applicant profile first.');
  const data={...Object.fromEntries(new FormData(form)),applicant_id:id};
  if(name==='search'){
   if(data.scope_json?.trim()){let imported;try{imported=JSON.parse(data.scope_json)}catch{throw Error('Structured scope must be valid JSON. Nothing was saved.')}data.scope=imported.scope||imported;}
   delete data.scope_json;data.auto_queue=form.elements.auto_queue.checked;
   const r=await api('/searches','POST',data);savedSearchId=r.id;await api('/searches/'+r.id+'/run','POST',{});
  }else await api('/jobs','POST',data);
  notice(name==='job'?'Job added to Found. Open Applications and choose Prepare application.':'Search saved and checked. Review found jobs in the dashboard.');
 }catch(err){notice(savedSearchId?'Search was saved, but checking jobs failed: '+err.message+'. Use Run search now in Applications; do not create it again.':err.message);}
 finally{delete form.dataset.saving;if(button)button.disabled=false;}
};
if(token)load().catch(err=>notice(err.message));




if((location.hostname.endsWith('.netlify.app')||location.hostname.endsWith('.pages.dev')))document.querySelector('#open-dashboard').href='/automate.html';




for (const choice of document.querySelectorAll('[name="source-choice"]')) choice.addEventListener('change',()=>{const direct=choice.value==='job';if($('#job'))$('#job').hidden=!direct;if($('#search'))$('#search').hidden=direct;});

let resumeBlobUrl=null,previousResumeBlobUrl=null,resumeEditorProfile=null,resumeDraftId=null;
function renderCurrentResume(){
 renderExperienceLibrary().catch(error=>{if($('#experience-status'))$('#experience-status').textContent=error.message;});
 const box=$('#current-resume');if(!box)return;box.replaceChildren();const p=profiles.find(p=>p.id===$('#profiles').value);
 if(!p)return;
 const label=document.createElement('p');label.textContent=p.has_resume?'A resume is saved for '+p.name+'. Applications attach this file.':'No resume is saved for this profile.';box.append(label);
 const edit=document.createElement('button');edit.type='button';edit.className='secondary';edit.textContent='Edit resume text';box.append(edit);edit.onclick=()=>openResumeEditor(p.id);
 if(!p.has_resume)return;
 const button=document.createElement('button');button.type='button';button.textContent='View current resume';box.append(button);
 button.onclick=async()=>{button.disabled=true;const generation=profileGeneration;try{
  const data=await api('/applicants/'+p.id+'/resume');if(generation!==profileGeneration||p.id!==$('#profiles').value)return;
  if(resumeBlobUrl)URL.revokeObjectURL(resumeBlobUrl);
  resumeBlobUrl=URL.createObjectURL(new Blob([Uint8Array.from(atob(data.base64),c=>c.charCodeAt(0))],{type:data.mime}));
  $('#resume-preview-title').textContent=data.applicant+' · Current resume';
  $('#resume-preview-note').textContent=data.name+' · '+Math.round(data.bytes/1024)+' KB. This is the saved file attached to new applications. '+(data.previewNotice||'Text preview below; download the original to see its formatting.');
  $('#resume-original').href=resumeBlobUrl;$('#resume-original').download=data.name;
  $('#resume-previous').hidden=!data.hasPrevious;$('#resume-previous').onclick=async e=>{if(!$('#resume-previous').href){e.preventDefault();try{const previous=await api('/applicants/'+p.id+'/resume-previous');if(generation!==profileGeneration||p.id!==$('#profiles').value)return;if(previousResumeBlobUrl)URL.revokeObjectURL(previousResumeBlobUrl);previousResumeBlobUrl=URL.createObjectURL(new Blob([Uint8Array.from(atob(previous.base64),c=>c.charCodeAt(0))],{type:previous.mime}));$('#resume-previous').href=previousResumeBlobUrl;$('#resume-previous').download=previous.name;$('#resume-previous').click();}catch(error){notice(error.message);}}};$('#resume-previous').removeAttribute('href');
  $('#resume-preview-text').textContent=data.text||'No readable text found.';
  $('#resume-preview').showModal();
 }catch(err){notice(err.message);}finally{button.disabled=false;}};
}
$('#close-resume').onclick=()=>$('#resume-preview').close();

function invalidateResumeDraft(){resumeDraftId=null;$('#save-edited-resume').disabled=true;$('#resume-editor-pages').replaceChildren();}
async function openResumeEditor(id){
 const generation=profileGeneration;resumeEditorProfile=id;invalidateResumeDraft();$('#resume-editor').hidden=false;$('#resume-editor-status').textContent='Loading your saved resume…';
 try{const p=profiles.find(p=>p.id===id),data=p?.has_resume?await api('/applicants/'+id+'/resume'):{text:''};
 if(generation!==profileGeneration||resumeEditorProfile!==id)return;$('#resume-editor-text').value=data.text||'';$('#resume-editor-status').textContent='Edit the text, then preview the exact PDF before saving.';
 $('#resume-editor').scrollIntoView({behavior:'smooth',block:'start'});
 }catch(error){$('#resume-editor-status').textContent=error.message;}
}
$('#resume-editor-text').addEventListener('input',()=>{invalidateResumeDraft();$('#resume-editor-status').textContent='Text changed. Preview it again before saving.';});
$('#preview-edited-resume').onclick=async()=>{
 const id=resumeEditorProfile,generation=profileGeneration,content=$('#resume-editor-text').value,button=$('#preview-edited-resume');
 if(!id||id!==$('#profiles').value)return $('#resume-editor-status').textContent='Select the same profile, then open its resume editor.';
 button.disabled=true;invalidateResumeDraft();$('#resume-editor-status').textContent='Building the PDF and its page previews…';
 try{const result=await api('/applicants/'+id+'/resume-edit','POST',{action:'preview',text:content});
 if(generation!==profileGeneration||resumeEditorProfile!==id||$('#resume-editor-text').value!==content)return;
 resumeDraftId=result.draftId;$('#save-edited-resume').disabled=false;
 for(const [index,data]of result.pages.entries()){const img=document.createElement('img');img.alt='Revised resume PDF page '+(index+1);img.src='data:image/png;base64,'+data;img.style.cssText='display:block;width:100%;height:auto;border:1px solid #dfe7e1';$('#resume-editor-pages').append(img);}
 $('#resume-editor-status').textContent=result.pages.length+' PDF page(s) ready. Review the pages, then use this resume for new applications.';
 }catch(error){$('#resume-editor-status').textContent=error.message;}finally{button.disabled=false;}
};
$('#save-edited-resume').onclick=async()=>{
 const id=resumeEditorProfile,generation=profileGeneration,draftId=resumeDraftId;if(!id||!draftId||id!==$('#profiles').value)return;
 const button=$('#save-edited-resume');button.disabled=true;
 try{const result=await api('/applicants/'+id+'/resume-edit','POST',{action:'save',draftId});if(generation!==profileGeneration||resumeEditorProfile!==id)return;
 resumeDraftId=null;$('#resume-editor-status').textContent='Saved '+result.name+' as your application resume. New applications will attach this PDF.'+(result.previousSaved?' Your previous resume is retained.':'');
 $('#resume').value='';await load();$('#profiles').value=id;renderCurrentResume();notice('Revised resume saved for '+profiles.find(p=>p.id===id)?.name+'. New applications will use this PDF.');
 }catch(error){$('#resume-editor-status').textContent=error.message;button.disabled=false;}
};
$('#cancel-edited-resume').onclick=()=>{resumeEditorProfile=null;invalidateResumeDraft();$('#resume-editor').hidden=true;};

let experienceEditing=null,experienceGeneration=0;
async function renderExperienceLibrary(){
 const list=$('#experience-list'),status=$('#experience-status'),form=$('#experience-form');if(!list||!form)return;
 const id=$('#profiles').value,generation=++experienceGeneration;experienceEditing=null;form.reset();$('#experience-cancel').hidden=true;
 if(!id){list.replaceChildren();form.hidden=true;status.textContent='Choose a saved profile above to add experience.';return;}
 form.hidden=false;status.textContent='';const {facts=[]}=await api('/applicants/'+id+'/experience');if(generation!==experienceGeneration||id!==$('#profiles').value)return;list.replaceChildren();
 for(const fact of facts){const row=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('p'),edit=document.createElement('button'),remove=document.createElement('button');summary.textContent=fact.title;text.textContent=fact.details;text.style.whiteSpace='pre-wrap';edit.type=remove.type='button';edit.textContent='Edit example';remove.textContent='Remove example';edit.className=remove.className='secondary';row.append(summary,text,edit,remove);list.append(row);
 edit.onclick=()=>{experienceEditing=fact.id;form.elements.title.value=fact.title;form.elements.details.value=fact.details;form.elements.approved.checked=false;$('#experience-cancel').hidden=false;form.elements.title.focus();};
 remove.onclick=async()=>{remove.disabled=true;try{await api('/applicants/'+id+'/experience/'+fact.id,'DELETE');await renderExperienceLibrary();status.textContent='Example removed from future drafts.';}catch(error){status.textContent=error.message;remove.disabled=false;}};
 }
}
if($('#experience-form'))$('#experience-form').onsubmit=async event=>{event.preventDefault();const form=event.target,id=$('#profiles').value,button=event.submitter;if(!id)return;button.disabled=true;const body={title:form.elements.title.value,details:form.elements.details.value,approved:form.elements.approved.checked};try{await api('/applicants/'+id+'/experience'+(experienceEditing?'/'+experienceEditing:''),experienceEditing?'PUT':'POST',body);if(id!==$('#profiles').value)return;await renderExperienceLibrary();$('#experience-status').textContent='Saved. Relevant unanswered forms will be checked again using this example. Final Submit remains yours.';}catch(error){$('#experience-status').textContent=error.message;}finally{button.disabled=false;}};
if($('#experience-cancel'))$('#experience-cancel').onclick=()=>{experienceEditing=null;$('#experience-form').reset();$('#experience-cancel').hidden=true;};

if(document.querySelector('#open-funnel'))document.querySelector('#open-funnel').href=(location.hostname.endsWith('.pages.dev')||location.hostname.endsWith('.netlify.app'))?'/automate?view=funnel':'/assistant?view=funnel';
