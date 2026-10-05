import {publicJobContextUrl} from './google-research.js';

const cache=new Map(),pending=new Map();
export const plainJobText=value=>String(value||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();

// Only public ATS endpoints derived from an exact posting identity are fetched.
// Never fetch arbitrary candidate URLs or follow redirects to another host.
export async function draftJobContext(job,{fetchImpl=fetch,clock=()=>Date.now()}={}){
 const safe=publicJobContextUrl(job.url);if(!safe)return {description:'',sourceUrl:'',status:'unavailable'};
 let metadata;try{metadata=JSON.parse(job.job_metadata_json||'{}')}catch{metadata={}};
 if(metadata.sourceUrl&&publicJobContextUrl(metadata.sourceUrl)===safe&&typeof metadata.description==='string'&&clock()-Date.parse(metadata.checkedAt)<86400000)return {description:plainJobText(metadata.description).slice(0,24000),sourceUrl:safe,status:'saved_posting'};
 if(cache.has(safe)&&cache.get(safe).until>clock())return cache.get(safe).value;
 if(pending.has(safe))return pending.get(safe);
 const task=(async()=>{
  const url=new URL(safe),parts=url.pathname.split('/').filter(Boolean),board=parts[0];let api,select;
  if(!/^[a-z0-9_-]{1,100}$/i.test(board||''))return {description:'',sourceUrl:safe,status:'unavailable'};
  if(['boards.greenhouse.io','job-boards.greenhouse.io'].includes(url.hostname)&&parts.length===3&&parts[1]==='jobs'&&/^\d+$/.test(parts[2])){
   api='https://boards-api.greenhouse.io/v1/boards/'+board+'/jobs/'+parts[2];select=data=>String(data.id)===parts[2]?data.content:'';
  }else if(['jobs.lever.co','jobs.eu.lever.co'].includes(url.hostname)&&parts.length===2&&/^[a-f0-9-]{36}$/i.test(parts[1])){
   api=(url.hostname==='jobs.eu.lever.co'?'https://api.eu.lever.co':'https://api.lever.co')+'/v0/postings/'+board+'/'+parts[1];select=data=>data.id===parts[1]?[data.descriptionPlain,...(data.lists||[]).map(x=>[x.text,x.content].join(' ')),data.additionalPlain].join('\n'):'';
  }else if(url.hostname==='jobs.ashbyhq.com'&&parts.length===2&&/^[a-f0-9-]{36}$/i.test(parts[1])){
   api='https://api.ashbyhq.com/posting-api/job-board/'+board;select=data=>(data.jobs||[]).find(j=>publicJobContextUrl(j.jobUrl)===safe)?.descriptionPlain||'';
  }else return {description:'',sourceUrl:safe,status:'unavailable'};
  try{
   const response=await fetchImpl(api,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{accept:'application/json'}});
   if(!response.ok)throw Error('Posting unavailable');
   if(Number(response.headers?.get('content-length')||0)>8000000)throw Error('Posting too large');
   const raw=await response.text();if(raw.length>8000000)throw Error('Posting too large');
   const description=plainJobText(select(JSON.parse(raw))).slice(0,24000);
   return {description,sourceUrl:safe,status:description?'public_posting':'unavailable'};
  }catch{return {description:'',sourceUrl:safe,status:'unavailable'};}
 })();pending.set(safe,task);
 try{const value=await task;if(cache.size>=200)cache.delete(cache.keys().next().value);cache.set(safe,{value,until:clock()+(value.description?3600000:60000)});return value;}finally{pending.delete(safe);}
}
