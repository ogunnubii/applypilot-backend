import {matches,locationPriority} from './matching.js';
import {randomUUID} from 'node:crypto';
import {db,event,now,normalizeURL} from './db.js';

const boardHosts=new Set(['boards.greenhouse.io','job-boards.greenhouse.io','jobs.lever.co','jobs.eu.lever.co']);
export function directDiscoveryLink(value){
 try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443')return false;
 return ['boards.greenhouse.io','job-boards.greenhouse.io'].includes(u.hostname)&&/^\/[^/]+\/jobs\/\d+\/?$/.test(u.pathname)||['jobs.lever.co','jobs.eu.lever.co'].includes(u.hostname)&&/^\/[^/]+\/[a-z0-9-]+(?:\/apply)?\/?$/i.test(u.pathname);
 }catch{return false;}
}
const placeWords=['remote','canada','toronto','ontario','united states','usa','uk','united kingdom'];
const filler=/\b(find|search|show|me|for|a|an|the|jobs?|roles?|positions?|openings?|apply|to|automatically|please|that|are|in|at|from|with|my|all|new|and)\b/gi;

export function parseBoards(input){
  const lines=String(input||'').split(/[\s,]+/).map(s=>s.trim()).filter(Boolean);
  if(lines.length>50)throw Error('Enter up to 50 Greenhouse or Lever board links');
  return [...new Set(lines.map(s=>{
    let u;try{u=new URL(s)}catch{throw Error('Enter complete HTTPS board links')}
    if(u.protocol!=='https:'||!boardHosts.has(u.hostname)||u.username||u.password)throw Error('Only public Greenhouse and Lever board links are supported');
    const token=u.pathname.split('/').filter(Boolean)[0];
    if(!token||!/^[a-z0-9_-]{2,80}$/i.test(token))throw Error('Use an employer board link, such as https://boards.greenhouse.io/company');
    return `${u.origin}/${token}`;
  }))];
}

export function parseIntent(input){
  const instruction=String(input||'').trim().slice(0,5000);
  if(!instruction)throw Error('Describe the roles you want');
  const lower=instruction.toLowerCase();
  const remote=/\bremote\b/.test(lower);
  const places=placeWords.filter(p=>new RegExp(`\\b${p}\\b`,'i').test(lower)&&p!=='remote');
  let roleText=instruction.split(';')[0].replace(/\bbuild and release\b/gi,'Build-Release').replace(/\b(in|near|around)\s+(canada|toronto|ontario|united states|usa|uk|united kingdom)\b/gi,'').replace(/\b(remote|canada|toronto|ontario|united states|usa|uk|united kingdom)\b/gi,'').replace(/\band\b/gi,',').replace(filler,' ').replace(/\s+/g,' ').trim();
  let roles=roleText.split(/\s*(?:,|\bor\b|&)\s*/i).map(s=>s.toLowerCase().trim().replace(/\bbuild-release\b/g,'build and release')).filter(Boolean);
  if(!roles.length)throw Error('Include a role, for example: DevOps engineer; remote; Canada');
  const locationOrder=lower.includes('priority: york region > toronto > gta > remote > canada > worldwide')?'york-toronto-gta-remote-canada-worldwide':null;
  return {roles:roles.slice(0,80),remote:locationOrder?false:remote,places:locationOrder?[]:places,locationOrder};
}

async function readJSON(url){
  const response=await fetch(url,{signal:AbortSignal.timeout(12000),headers:{accept:'application/json'}});
  if(!response.ok)throw Error(`Job board returned ${response.status}`);
  if(Number(response.headers.get('content-length')||0)>8000000)throw Error('Job board response too large');
  const body=await response.text();if(body.length>8000000)throw Error('Job board response too large');
  return JSON.parse(body);
}

const feedCache=new Map();
async function cachedJSON(url){
  const hit=feedCache.get(url);if(hit&&Date.now()-hit.at<60*60*1000)return hit.data;
  const data=await readJSON(url);feedCache.set(url,{at:Date.now(),data});return data;
}

async function broadListings(intent){
  const errors=[],batches=[];
  try{
    const query=new URLSearchParams({count:'200'});
    if(intent.places.includes('canada'))query.set('geo','canada');
    else if(intent.places.includes('usa')||intent.places.includes('united states'))query.set('geo','usa');
    const data=await cachedJSON(`https://jobicy.com/api/v2/remote-jobs?${query}`);
    batches.push({source:'Jobicy',jobs:(data.jobs||[]).map(j=>({title:j.jobTitle,company:j.companyName,location:j.jobGeo,remote:true,url:j.url}))});
  }catch(e){errors.push(`Jobicy: ${String(e.message).slice(0,150)}`)}
  try{
    for(let page=1;page<=5;page++){
      const data=await cachedJSON('https://www.arbeitnow.com/api/job-board-api'+(page===1?'':'?page='+page));
      batches.push({source:'Arbeitnow page '+page,jobs:(data.data||[]).map(j=>({title:j.title,company:j.company_name,location:j.location,remote:j.remote,url:j.url}))});
      if(!data.links?.next||!data.data?.length)break;
    }
  }catch(e){errors.push(`Arbeitnow: ${String(e.message).slice(0,150)}`)}
  return {batches,errors};
}

async function listBoard(board){
  const u=new URL(board),token=u.pathname.slice(1);
  if(u.hostname.includes('greenhouse.io')){
    const data=await cachedJSON(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`);
    return (data.jobs||[]).map(j=>({title:j.title,company:token,location:j.location?.name,url:j.absolute_url}));
  }
  const api=u.hostname==='jobs.eu.lever.co'?'https://api.eu.lever.co':'https://api.lever.co';
  const data=await readJSON(`${api}/v0/postings/${encodeURIComponent(token)}?mode=json&limit=500`);
  if(!Array.isArray(data))throw Error('Job board response is invalid');
  return data.map(j=>({title:j.text,company:token,location:j.categories?.location||j.categories?.allLocations?.join(', '),remote:j.workplaceType==='remote',url:j.applyUrl||j.hostedUrl}));
}

const defaultBoards=['braze','cloudflare','canonical','gitlab','datadog','grafanalabs'].map(x=>'https://boards.greenhouse.io/'+x).concat('https://jobs.lever.co/newton');
const activeSearches=new Map();
export function runSearch(id,userId){
 const key=userId+':'+id;
 if(activeSearches.has(key))return activeSearches.get(key);
 const task=executeSearch(id,userId).finally(()=>activeSearches.delete(key));
 activeSearches.set(key,task);return task;
}
async function executeSearch(id,userId){
  const search=db.prepare('SELECT * FROM searches WHERE id=? AND user_id=?').get(id,userId);
  if(!search)throw Error('Search not found');
  const applicant=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(search.applicant_id,userId);
  if(!applicant)throw Error('Applicant not found');
  const intent=parseIntent(search.instruction),boards=[...new Set([...defaultBoards,...JSON.parse(search.boards_json),...parseBoards(process.env.DISCOVERY_BOARDS||'')])];
  db.prepare('UPDATE searches SET last_run=?,last_error=NULL WHERE id=?').run(now(),id);
  let scanned=0,matched=0,added=0,queued=0,errors=[];
  const sources=[];
  for(let i=0;i<boards.length;i+=4){
    const group=boards.slice(i,i+4),results=await Promise.allSettled(group.map(listBoard));
    results.forEach((result,index)=>{
      if(result.status==='fulfilled')sources.push({source:group[index],jobs:result.value});
      else errors.push(`${group[index]}: ${String(result.reason?.message).slice(0,150)}`);
    });
  }
  const broad=await broadListings(intent);sources.push(...broad.batches);errors.push(...broad.errors);
  if(intent.locationOrder){const ordered=sources.flatMap(s=>s.jobs.map(job=>({...job,source:s.source}))).sort((a,b)=>locationPriority(a)-locationPriority(b));sources.splice(0,sources.length,{source:'Prioritized employer and public feeds',jobs:ordered});}
  for(const {source,jobs} of sources){
    try{
      scanned+=jobs.length;
      for(const job of jobs){
        if(added>=250)break;
        if(!matches(job,intent))continue;
        let url;try{url=normalizeURL(job.url)}catch{continue}
        const direct=directDiscoveryLink(url);
        if(!direct)continue;
        matched++;
        const canQueue=!!(direct&&search.auto_queue&&applicant.consent&&applicant.email&&applicant.resume_path);
        const id=randomUUID(),date=now();
        const result=db.prepare('INSERT OR IGNORE INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(id,userId,applicant.id,String(job.title).slice(0,200),String(job.company).slice(0,200),url,url,canQueue?'queued':'saved',`Source: ${source}${job.location?' · '+String(job.location).slice(0,100):''}${direct?'':' · Add employer application link to queue'}`,date,date);
        if(result.changes){db.prepare('UPDATE jobs SET discovery_priority=? WHERE id=?').run(intent.locationOrder?locationPriority(job):5,id);added++;if(canQueue)queued++;event(id,canQueue?'queued':'saved',`Found by search: ${search.instruction}`)}
        else if(canQueue){
          const existing=db.prepare("SELECT id FROM jobs WHERE applicant_id=? AND normalized_url=? AND status='saved' AND challenge IS NULL").get(applicant.id,url);
          if(existing&&db.prepare("UPDATE jobs SET status='queued',updated_at=? WHERE id=? AND status='saved' AND challenge IS NULL").run(now(),existing.id).changes){queued++;event(existing.id,'queued','Existing match queued by enabled automatic search');}
        }
      }
    }catch(e){errors.push(`${source}: ${String(e.message).slice(0,150)}`)}
  }
  db.prepare('UPDATE searches SET last_error=? WHERE id=?').run(errors.join('; ').slice(0,600)||null,id);
  const result={scanned,matched,added,queued,errors,sources:sources.map(s=>({source:s.source,count:s.jobs.length}))};
  db.prepare('UPDATE searches SET last_result_json=? WHERE id=?').run(JSON.stringify(result),id);
  return result;
}

export async function runDueSearches(){
  const hours=Math.max(1,Math.min(24,Number(process.env.SEARCH_INTERVAL_HOURS)||1));
  const cutoff=new Date(Date.now()-hours*60*60*1000).toISOString();
  const due=db.prepare('SELECT id,user_id FROM searches WHERE enabled=1 AND (last_run IS NULL OR last_run<?) LIMIT 5').all(cutoff);
  for(const search of due){try{await runSearch(search.id,search.user_id)}catch(e){console.error('Discovery:',e.message)}}
}
