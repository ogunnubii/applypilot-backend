// LinkedIn and Indeed search results: the applicant chooses to add the jobs
// visible on the page they are viewing. Nothing is crawled, paginated or
// clicked on the board; only job ids and the card's visible text are read.
// Each added job is still checked on its own page before any form opens.
(()=>{
 if(globalThis.__applyPilotBoardImport)return;globalThis.__applyPilotBoardImport=true;
 const P=globalThis.ApplyPilotPolicy,board=/(^|\.)linkedin\.com$/.test(location.hostname)?'linkedin':/(^|\.)indeed\.com$/.test(location.hostname)?'indeed':null;
 if(!board||!P)return;
 const compact=v=>String(v||'').replace(/\s+/g,' ').trim();
 const textIn=(root,selector)=>compact(root.querySelector(selector)?.textContent);
 // Badges are matched per element: textContent of a card runs words together.
 const hasLabel=(root,pattern)=>[root,...root.querySelectorAll('*')].some(e=>e.children.length<=1&&pattern.test(compact(e.textContent)));
 function cards(){
  const found=new Map();
  if(board==='linkedin'){
   for(const link of document.querySelectorAll('a[href*="/jobs/view/"]')){
    const id=(link.getAttribute('href')||'').match(/\/jobs\/view\/(\d{6,20})/)?.[1];if(!id||found.has(id))continue;
    const card=link.closest('[data-job-id],li,.job-card-container')||link;
    found.set(id,{url:'https://www.linkedin.com/jobs/view/'+id,title:compact(link.getAttribute('aria-label')||link.textContent).replace(/\s+with verification$/i,''),
     company:textIn(card,'.artdeco-entity-lockup__subtitle,.job-card-container__primary-description,[data-testid="company-name"]'),
     location:textIn(card,'.job-card-container__metadata-item,.artdeco-entity-lockup__caption,[data-testid="job-location"]'),
     nativeApply:hasLabel(card,/^easy apply$/i),applied:hasLabel(card,/^applied\b/i)});
   }
  }else{
   for(const node of document.querySelectorAll('[data-jk]')){
    const jk=String(node.getAttribute('data-jk')||'').toLowerCase();if(!/^[a-f0-9]{16}$/.test(jk)||found.has(jk))continue;
    const card=node.closest('.job_seen_beacon,.cardOutline,li,td')||node;
    found.set(jk,{url:'https://www.indeed.com/viewjob?jk='+jk,title:textIn(card,'h2.jobTitle span[title],h2.jobTitle,[id^="jobTitle"]')||compact(node.textContent),
     company:textIn(card,'[data-testid="company-name"],.companyName'),location:textIn(card,'[data-testid="text-location"],.companyLocation'),
     nativeApply:hasLabel(card,/^(?:easily apply|indeed apply|easily apply to this job)$/i),applied:hasLabel(card,/^applied\b/i)});
   }
  }
  return [...found.values()].filter(j=>P.supported(j.url));
 }
 let box,button,status;
 function mount(){
  if(box)return;
  box=document.createElement('div');box.setAttribute('data-applypilot-import','');box.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483646;background:#fff;color:#111;border:1px solid #888;border-radius:8px;padding:10px;font:14px system-ui;max-width:300px;box-shadow:0 2px 8px rgba(0,0,0,.2)';
  button=document.createElement('button');button.type='button';status=document.createElement('div');status.setAttribute('role','status');status.style.marginTop='6px';
  box.append(button,status);document.documentElement.append(box);
  button.onclick=add;
 }
 function refresh(){
  const all=cards(),usable=all.filter(j=>j.nativeApply&&!j.applied);
  if(!all.length){if(box)box.hidden=true;return;}
  mount();box.hidden=false;button.disabled=!usable.length;
  button.textContent=usable.length?'Add '+usable.length+' '+(board==='linkedin'?'Easy Apply':'Indeed Apply')+' job'+(usable.length===1?'':'s')+' to ApplyPilot':'No '+(board==='linkedin'?'Easy Apply':'Indeed Apply')+' jobs on this page';
 }
 async function add(){
  const all=cards(),jobs=all.filter(j=>j.nativeApply&&!j.applied).slice(0,50);if(!jobs.length)return;
  button.disabled=true;status.textContent='Adding…';
  try{
   const r=await chrome.runtime.sendMessage({action:'board-import',board,jobs:jobs.map(({url,title,company,location})=>({url,title,company,location}))});
   if(!r?.ok)throw Error(r?.error||'ApplyPilot could not add these jobs.');
   const d=r.data;status.textContent=`Added ${d.added}; already tracked ${d.existing}; repeats blocked ${d.duplicates}`+(all.length>jobs.length?`; skipped ${all.length-jobs.length} without ${board==='linkedin'?'Easy Apply':'Indeed Apply'} or already applied`:'')+'. Each is checked on its own page before applying.';
  }catch(e){status.textContent=e.message;}
  finally{button.disabled=false;}
 }
 globalThis.__applyPilotBoardCards=cards;
 refresh();new MutationObserver(()=>{clearTimeout(globalThis.__applyPilotBoardTimer);globalThis.__applyPilotBoardTimer=setTimeout(refresh,500);}).observe(document.documentElement,{childList:true,subtree:true});
})();
