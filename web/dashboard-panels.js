// Answers needed and connection status panels for the applications dashboard.
// Rendering only reads. A save happens only when the applicant clicks Save answer,
// and it stores exactly the typed text. Employer-page questions get no input here.
(()=>{
 const node=(tag,text,css)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(css)e.style.cssText=css;return e;};
 const plural=(n,word)=>n+' '+word+(n===1?'':'s');
 let notice='',saving=0;

 function renderConnection(connection){
  const workspace=document.querySelector('#workspace');if(!workspace||!connection)return;
  let box=document.querySelector('#connection-status');
  if(!box){box=node('section','','padding:12px 16px;border:1px solid #d9a441;border-radius:12px;margin:0 0 16px;background:#fff8e6');box.id='connection-status';box.setAttribute('role','status');workspace.prepend(box);}
  box.hidden=!!connection.ok;
  const text=connection.ok?'':String(connection.message||'');
  if(box.dataset.text!==text){box.dataset.text=text;box.replaceChildren(node('strong','Connection check'),node('p',text,'margin:4px 0 0'));}
 }

 // Never replace a field the applicant is typing in or has unsaved text in.
 function busy(box){const active=document.activeElement;return saving>0||!!box.querySelector('[data-dirty="true"]')||!!active&&box.contains(active)&&active.matches('textarea,input');}

 function questionRow(job,item,{api,refresh}){
  const row=node('div','','padding:10px 0;border-top:1px solid #e3ebe6');
  if(item.kind==='employer'){
   row.append(node('p','Answer on the employer page:','margin:0;font-weight:600'),node('p',item.question,'margin:2px 0'),node('small','Consents, declarations and protected questions stay with you on the employer site.','display:block;color:#59685e'));
   return row;
  }
  const label=node('label',item.question,'display:block;font-weight:600'),input=node('textarea','','display:block;width:100%;min-height:64px;margin-top:6px;padding:8px;border:1px solid #cad7ce;border-radius:8px');
  input.maxLength=4000;input.disabled=!!job.editing;input.oninput=()=>{input.dataset.dirty=input.value.trim()?'true':'false';};label.append(input);row.append(label);
  let reuse=null;
  if(item.reuse){const wrap=node('label','','display:block;margin:6px 0;font-size:13px');reuse=node('input');reuse.type='checkbox';wrap.append(reuse,document.createTextNode(' Use this answer for future applications'));row.append(wrap);}
  else row.append(node('small','Kept with this application only.','display:block;margin:6px 0;color:#59685e'));
  // Opt-in, unticked by default: copy the same typed text to the named forms only.
  let copy=null;const others=Array.isArray(item.elsewhere)?item.elsewhere:[];
  if(others.length){
   const wrap=node('label','','display:block;margin:6px 0;font-size:13px');copy=node('input');copy.type='checkbox';
   wrap.append(copy,document.createTextNode(' Also use this answer for '+plural(others.length,'other parked form')+' asking the same question'));
   row.append(wrap,node('small',others.map(o=>o.company+' · '+o.title).join('; '),'display:block;margin:0 0 6px 22px;color:#59685e'));
  }
  const save=node('button','Save answer'),status=node('p','','margin:6px 0 0;font-size:13px');save.type='button';save.disabled=!!job.editing;status.setAttribute('role','status');
  save.onclick=async()=>{
   const answer=input.value.trim();if(!answer){status.textContent='Type your answer first.';return;}
   save.disabled=input.disabled=true;saving++;status.textContent='Saving…';
   try{
    const also=copy?.checked?others.map(o=>({id:o.id,formKey:o.formKey})):[];
    const result=await api('/answers-inbox/answer','POST',{jobId:job.id,question:item.question,answer,remember:!!reuse?.checked,formKey:job.formKey,also});
    const parts=[result?.resume?.message||'Answer saved.'],copies=Array.isArray(result?.also)?result.also:[];
    const copied=copies.filter(c=>c.saved).length,skipped=copies.filter(c=>!c.saved);
    if(copied)parts.push('Also saved for '+plural(copied,'other form')+'.');
    for(const c of skipped)parts.push('Not copied to '+(c.company||'one form')+': '+c.message);
    if(result?.remembered)parts.push('Kept for future applications.');
    if(result?.profileConflict)parts.push('Your profile already has a different saved answer, so it was not replaced. Review it in the answer library.');
    notice=job.company+' · '+parts.join(' ');input.dataset.dirty='false';input.blur();status.textContent=parts.join(' ');
   }catch(error){status.textContent=error.message;save.disabled=input.disabled=false;}
   finally{saving--;}
   if(input.dataset.dirty==='false')await refresh?.();
  };
  row.append(save,status);
  return row;
 }

 function renderAnswersInbox(data,deps={}){
  if(!data||!Array.isArray(data.jobs))return;
  let box=document.querySelector('#answers-needed');
  if(!box){box=node('section','','padding:16px;border:1px solid #74ad91;border-radius:12px;margin:16px 0');box.id='answers-needed';if(deps.place)deps.place(box);else document.querySelector('#workspace')?.append(box);}
  box.hidden=!data.jobs.length&&!notice;
  const signature=JSON.stringify([data,notice]);
  if(box.dataset.signature===signature||busy(box))return;
  box.dataset.signature=signature;
  const summary=node('p',data.jobs.length?plural(data.total,'answer')+' needed across '+plural(data.jobs.length,'application')+(data.employer?' · '+data.employer+' to answer on the employer page':''):'No answers are needed right now.');summary.setAttribute('role','status');
  box.replaceChildren(node('h2','Answers needed'),summary,node('p','Type only what is true for you. ApplyPilot saves exactly what you type, never fills in a guess, and continues a form once every answer is in. Final Submit stays yours.','font-size:13px;color:#466552'));
  if(notice)box.append(node('p',notice,'font-size:13px;color:#214d36'));
  for(const job of data.jobs){
   const card=node('div','','padding:12px 0;border-top:1px solid #cfe0d6'),heading=node('strong',job.company+' · '+job.title);card.append(heading);
   if(typeof job.url==='string'&&/^https?:\/\//i.test(job.url)){const link=node('a','Open employer page','margin-left:12px;font-size:13px;text-decoration:underline');link.href=job.url;link.target='_blank';link.rel='noopener noreferrer';card.append(link);}
   if(job.editing)card.append(node('p','An answer for this form is being edited in its employer tab. Finish it there first.','font-size:13px;color:#8a5a00'));
   for(const item of job.questions||[])card.append(questionRow(job,item,deps));
   box.append(card);
  }
 }

 async function update(deps={}){
  renderConnection(deps.connection);
  if(typeof deps.api!=='function')return;
  try{renderAnswersInbox(await deps.api('/answers-inbox'),deps);}
  catch{const box=document.querySelector('#answers-needed');if(box&&!busy(box))box.querySelector('[role=status]')?.replaceChildren(document.createTextNode('Answers needed could not be refreshed. Your saved answers are kept.'));}
 }

 globalThis.ApplyPilotPanels={update,renderAnswersInbox,renderConnection};
})();
