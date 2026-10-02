// Independently implemented form heuristics; see OPEN_SOURCE_NOTES.md.
export function pickResumeField(fields){
 const candidates=fields.map((f,index)=>({index,label:[f.label,f.id,f.name,f.context].filter(Boolean).join(' ')}));
 const explicit=candidates.filter(f=>/\b(resume|résumé|cv)\b/i.test(f.label)&&!/cover[ _-]?letter/i.test(f.label));
 if(explicit.length===1)return explicit[0].index;
 if(fields.length===1&&!/cover[ _-]?letter|portfolio|certificate/i.test(candidates[0].label))return 0;
 return -1;
}
export function canonicalJobURL(value){
 const u=new URL(value);if(u.protocol!=='https:')throw Error('Use an HTTPS job link');u.hash='';
 for(const k of [...u.searchParams.keys()]){const key=k.toLowerCase();if(key.startsWith('utm_')||['ref','source','gh_src','lang','language','locale'].includes(key))u.searchParams.delete(k);}
 if(/^jobs(\.eu)?\.lever\.co$/.test(u.hostname)){u.pathname=u.pathname.replace(/\/apply\/?$/,'').replace(/\/$/,'');u.search='';}
 if(u.hostname==='jobs.ashbyhq.com'){u.pathname=u.pathname.replace(/\/application\/?$/,'').replace(/\/$/,'');u.search='';}
 if(['boards.greenhouse.io','job-boards.greenhouse.io'].includes(u.hostname)){u.hostname='boards.greenhouse.io';u.pathname=u.pathname.replace(/\/$/,'');}
 if(/(?:^|\.)(?:myworkdayjobs|workdayjobs)\.com$/i.test(u.hostname))u.pathname=u.pathname.replace(/^\/[a-z]{2}(?:[-_][a-z]{2})?(?=\/)/i,'');
 u.searchParams.sort();
 return u.toString().replace(/\/$/,'');
}

export function approvedRadioIndex(options,answers){
 const norm=s=>String(s||'').trim().replace(/\s+/g,' ').replace(/\s*\*$/,'').toLowerCase();
 const matches=options.map((o,index)=>({o,index})).filter(({o})=>{
  if(!o.question||!o.label)return false;
  const keys=Object.keys(answers).filter(k=>norm(k)===norm(o.question));
  return keys.length===1&&norm(answers[keys[0]])===norm(o.label);
 });
 return matches.length===1?matches[0].index:-1;
}
