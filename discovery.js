import {workEligibility} from './work-eligibility.js';
import {companyKey,historyKey} from './application-history.js';
import {matchAssessment,locationPriority} from './matching.js';
import {randomUUID} from 'node:crypto';
import {db,event,now,normalizeURL} from './db.js';

const boardHosts=new Set(['boards.greenhouse.io','job-boards.greenhouse.io','jobs.lever.co','jobs.eu.lever.co','jobs.ashbyhq.com']);
export function directDiscoveryLink(value){
 try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443')return false;
 return ['boards.greenhouse.io','job-boards.greenhouse.io'].includes(u.hostname)&&/^\/[^/]+\/jobs\/\d+\/?$/.test(u.pathname)||['jobs.lever.co','jobs.eu.lever.co'].includes(u.hostname)&&/^\/[^/]+\/[a-z0-9-]+(?:\/apply)?\/?$/i.test(u.pathname)||u.hostname==='jobs.ashbyhq.com'&&/^\/[^/]+\/[a-f0-9-]{20,}(?:\/application)?\/?$/i.test(u.pathname);
 }catch{return false;}
}
const placeWords=['remote','york region','greater toronto','gta','canada','toronto','ontario','united states','usa','uk','united kingdom'];
const filler=/\b(find|search|show|me|for|a|an|the|jobs?|roles?|positions?|openings?|apply|to|automatically|please|that|are|in|at|from|with|my|all|new|and)\b/gi;

export function parseBoards(input){
  const lines=String(input||'').split(/[\s,]+/).map(s=>s.trim()).filter(Boolean);
  if(lines.length>50)throw Error('Enter up to 50 Greenhouse, Lever, or Ashby board links');
  return [...new Set(lines.map(s=>{
    let u;try{u=new URL(s)}catch{throw Error('Enter complete HTTPS board links')}
    if(u.protocol!=='https:'||!boardHosts.has(u.hostname)||u.username||u.password)throw Error('Only public Greenhouse, Lever, and Ashby board links are supported');
    let token;try{token=decodeURIComponent(u.pathname.split('/').filter(Boolean)[0]||'')}catch{throw Error('Use a valid employer board link')}
    if(!token||!/^[a-z0-9 ._-]{2,80}$/i.test(token))throw Error('Use an employer board link, such as https://jobs.ashbyhq.com/company');
    return `${u.origin}/${encodeURIComponent(token)}`;
  }))];
}

export function parseIntent(input){
  const rawInstruction=String(input||'').trim().slice(0,5000);
  const worldwideEligibility=/;\s*eligibility:\s*worldwide sponsorship, remote from Canada, or B2B/i.test(rawInstruction);
  const instruction=rawInstruction.split(';').filter(clause=>!/^\s*eligibility:|^\s*Canada B2B only\s*$/i.test(clause)).join(';').trim();
  if(!instruction)throw Error('Describe the roles you want');
  const lower=instruction.toLowerCase(),locationClause=instruction.split(';').slice(1).join(', ').trim();
  const countryOnly=new Set(['canada','usa','united states','uk','united kingdom','worldwide','anywhere','global']);
  const locationOrder=lower.includes('priority: york region > toronto > gta > remote > canada > worldwide')?'york-toronto-gta-remote-canada-worldwide':null;
  // Keep local alternatives separate from remote-scoped alternatives. Thus
  // "Toronto, remote Canada" means Toronto on-site OR remote within Canada;
  // the country must not widen the on-site radius to Vancouver or Calgary.
  const localPlaces=[],remotePlaces=[];let remoteAny=false,pendingRemote=false;
  const add=(target,value)=>{
   if(!value)return;
   if(/^[a-z]{2}$/.test(value)&&target.length&&!placeWords.includes(target.at(-1)))target[target.length-1]+=' '+value;
   else if(!target.includes(value))target.push(value);
  };
  const values=raw=>{
   const value=raw.toLowerCase().replace(/\b(?:remote|only|near|around|in)\b/g,' ').replace(/[^a-z0-9]+/g,' ').trim();
   if(!value)return [];
   const known=placeWords.filter(place=>place!=='remote'&&new RegExp(`\\b${place}\\b`).test(value));
   return known.length?[...new Set(known)]:[value];
  };
  if(locationClause&&!locationOrder){
   for(const raw of locationClause.split(/[;,]/).map(value=>value.trim()).filter(Boolean)){
    const scoped=/^(?:remote(?:\s+only)?|only\s+remote)\b/i.test(raw)||/\bremote(?:\s+only)?$/i.test(raw),parsed=values(raw);
    if(scoped&&!parsed.length){pendingRemote=true;continue;}
    if(scoped){for(const place of parsed)add(remotePlaces,place);pendingRemote=false;continue;}
    if(pendingRemote&&parsed.length&&parsed.every(place=>countryOnly.has(place))){for(const place of parsed)add(remotePlaces,place);pendingRemote=false;continue;}
    if(pendingRemote){remoteAny=true;pendingRemote=false;}
    for(const place of parsed)add(localPlaces,place);
   }
   if(pendingRemote)remoteAny=true;
  }
  const places=[...localPlaces];
  const remote=(remoteAny||remotePlaces.length>0)&&localPlaces.length===0;
  let roleText=instruction.split(';')[0].replace(/\bbuild and release\b/gi,'Build-Release').replace(/\b(in|near|around)\s+(york region|greater toronto|gta|canada|toronto|ontario|united states|usa|uk|united kingdom)\b/gi,'').replace(/\b(remote|york region|greater toronto|gta|canada|toronto|ontario|united states|usa|uk|united kingdom)\b/gi,'').replace(/\band\b/gi,',').replace(filler,' ').replace(/\s+/g,' ').trim();
  let roles=roleText.split(/\s*(?:,|\bor\b|&)\s*/i).map(s=>s.toLowerCase().trim().replace(/\bbuild-release\b/g,'build and release')).filter(Boolean);
  // Preserve a shared title suffix: "DevOps or Infrastructure Engineer"
  // means two engineer roles, not the overly broad bare word "DevOps".
  const titleSuffix=/\b(engineer|administrator|manager|operator|specialist|analyst|nurse|accountant)$/;
  roles=roles.map((role,index)=>role.split(/\s+/).length===1&&titleSuffix.test(roles[index+1]||'')?role+' '+roles[index+1].match(titleSuffix)[1]:role);
  if(!roles.length)throw Error('Include a role, for example: DevOps engineer; remote; Canada');
  return {worldwideEligibility,roles:roles.slice(0,80),remote:locationOrder||worldwideEligibility?false:remote,places:locationOrder||worldwideEligibility?[]:places,localPlaces:locationOrder||worldwideEligibility?[]:localPlaces,remotePlaces:locationOrder||worldwideEligibility?[]:remotePlaces,remoteAny:locationOrder||worldwideEligibility?false:remoteAny,locationOrder};
}

export function profileSearchInstruction(applicant,resumeRoles=[]){
 let roles=[];try{roles=parseIntent(applicant?.focus||'').roles}catch{}
 if(!roles.length)roles=resumeRoles.map(role=>String(role).trim()).filter(Boolean).slice(0,8);
 if(!roles.length)throw Error('Add at least one role of interest to the profile');
 const location=String(applicant?.location||'').trim();let locationPart='';
 if(location){
  if(/\b(?:canada|ontario|toronto|quebec|alberta|british columbia|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland)\b/i.test(location))locationPart=`; ${location}, remote Canada`;
  else if(/\b(?:usa|united states)\b/i.test(location))locationPart=`; ${location}, remote USA`;
  else locationPart=`; ${location}`;
 }
 return roles.join(', ')+locationPart;
}

export function mergeProfileRoles(intent,focus=''){
 let profile=[];try{profile=parseIntent(focus).roles}catch{}
 return {...intent,roles:[...new Set([...intent.roles,...profile])].slice(0,80)};
}

export function searchIntentForApplicant(search,applicant){
 const stored=parseIntent(search.instruction);
 const instruction=search.auto_generated?profileSearchInstruction(applicant,stored.roles):search.instruction;
 return {instruction,intent:mergeProfileRoles(parseIntent(instruction),applicant?.focus)};
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
    const geoPlaces=[...(intent.places||[]),...(intent.remotePlaces||[])];
    if(geoPlaces.includes('canada'))query.set('geo','canada');
    else if(geoPlaces.includes('usa')||geoPlaces.includes('united states'))query.set('geo','usa');
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
  const u=new URL(board),token=decodeURIComponent(u.pathname.slice(1));
  if(u.hostname.includes('greenhouse.io')){
    const data=await cachedJSON(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`);
    return (data.jobs||[]).map(j=>({title:j.title,company:token,location:j.location?.name,description:j.content,descriptionURL:Number.isInteger(j.id)?`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs/${j.id}`:null,url:j.absolute_url}));
  }
  if(u.hostname==='jobs.ashbyhq.com'){
    const data=await cachedJSON(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`);
    return (data.jobs||[]).map(j=>({title:j.title,company:token,location:j.location,description:j.descriptionPlain||j.descriptionHtml,employmentType:j.employmentType,remote:j.isRemote===true||j.workplaceType==='Remote',url:j.applyUrl||j.jobUrl}));
  }
  const api=u.hostname==='jobs.eu.lever.co'?'https://api.eu.lever.co':'https://api.lever.co';
  const data=await readJSON(`${api}/v0/postings/${encodeURIComponent(token)}?mode=json&limit=500`);
  if(!Array.isArray(data))throw Error('Job board response is invalid');
  return data.map(j=>({title:j.text,company:token,location:j.categories?.location||j.categories?.allLocations?.join(', '),description:[j.descriptionPlain,...(j.lists||[]).map(x=>x.text+' '+x.content),j.additionalPlain].join(' '),employmentType:j.categories?.commitment,remote:j.workplaceType==='remote',url:j.applyUrl||j.hostedUrl}));
}

const defaultBoards=['braze','cloudflare','canonical','gitlab','datadog','grafanalabs'].map(x=>'https://boards.greenhouse.io/'+x).concat('https://jobs.lever.co/newton');
// Current public boards with a high concentration of infrastructure,
// reliability, cloud and support work. They are added only for searches in
// that role family and share the normal one-hour feed cache.
const infrastructureBoards=['marble.ai','acquird','homebase','ashby','remarcable-inc','top-hat','lightspeedhq','hopper','baseten','hiive'].map(x=>'https://jobs.ashbyhq.com/'+encodeURIComponent(x));
function curatedBoards(intent,focus=''){
 const text=[...intent.roles,focus].join(' ').toLowerCase();
 return /\b(devops|site reliability|sre|platform|cloud|infrastructure|systems?|sysadmin|network|noc|support|build|release|ci\/cd|production)\b/.test(text)?infrastructureBoards:[];
}
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
  const resolved=searchIntentForApplicant(search,applicant),intent=resolved.intent,requestedBoards=[...JSON.parse(search.boards_json),...parseBoards(process.env.DISCOVERY_BOARDS||'')],boards=[...new Set([...defaultBoards,...curatedBoards(intent,applicant.focus),...requestedBoards])],requestedBoardSet=new Set(requestedBoards);
  if(search.auto_generated&&resolved.instruction!==search.instruction){search.instruction=resolved.instruction;db.prepare('UPDATE searches SET instruction=? WHERE id=?').run(search.instruction,id);}
  db.prepare('UPDATE searches SET last_run=?,last_error=NULL WHERE id=?').run(now(),id);
  let scanned=0,matched=0,strongMatches=0,added=0,queued=0,duplicatesSkipped=0,errors=[];
  const sources=[];
  for(let i=0;i<boards.length;i+=4){
    const group=boards.slice(i,i+4),results=await Promise.allSettled(group.map(listBoard));
    results.forEach((result,index)=>{
      if(result.status==='fulfilled')sources.push({source:group[index],jobs:result.value});
      else if(requestedBoardSet.has(group[index]))errors.push(`${group[index]}: ${String(result.reason?.message).slice(0,150)}`);
    });
  }
  const broad=await broadListings(intent);sources.push(...broad.batches);errors.push(...broad.errors);
  if(intent.locationOrder){const ordered=sources.flatMap(s=>s.jobs.map(job=>({...job,source:s.source}))).sort((a,b)=>locationPriority(a)-locationPriority(b));sources.splice(0,sources.length,{source:'Prioritized employer and public feeds',jobs:ordered});}
  for(const {source,jobs} of sources){
    try{
      scanned+=jobs.length;
      for(const job of jobs){
        if(added>=250)break;
        const assessment=matchAssessment(job,intent,applicant.focus);if(!assessment.matched)continue;
        if(intent.worldwideEligibility&&job.descriptionURL&&!job.description){try{const detail=await cachedJSON(job.descriptionURL);job.description=detail.content||'';}catch(e){errors.push('Could not verify '+job.company+' / '+job.title+': '+String(e.message).slice(0,100));continue;}}
        const eligibility=intent.worldwideEligibility?workEligibility(job):null;if(eligibility&&!eligibility.eligible)continue;
        let url;try{url=normalizeURL(job.url)}catch{continue}
        const direct=directDiscoveryLink(url);
        if(!direct)continue;
        const ck=companyKey(job.company),tk=historyKey(job.title);
        const imported=db.prepare('SELECT 1 FROM external_application_history WHERE user_id=? AND company_key=? AND title_key=?').get(userId,ck,tk);
        const prior=db.prepare("SELECT 1 FROM jobs WHERE user_id=? AND history_company(company)=? AND history_title(title)=? AND (status IN ('submitted','interview','offer','rejected','duplicate','archived','running','local_browser','queued') OR local_attempt_at IS NOT NULL)").get(userId,ck,tk);
        if(imported||prior){duplicatesSkipped++;continue;}
        matched++;
        if(assessment.strong)strongMatches++;
        const canQueue=!!(direct&&assessment.strong&&search.auto_queue&&applicant.consent&&applicant.email&&applicant.resume_path);
        const id=randomUUID(),date=now();
        const result=db.prepare('INSERT OR IGNORE INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(id,userId,applicant.id,String(job.title).slice(0,200),String(job.company).slice(0,200),url,url,canQueue?'queued':'saved',`Source: ${source}${job.location?' · '+String(job.location).slice(0,100):''} · ${assessment.strong?'Strong':'Comparable'} profile match${eligibility?' · '+eligibility.reason:''}`,date,date);
        if(result.changes){db.prepare('UPDATE jobs SET discovery_priority=? WHERE id=?').run(intent.locationOrder?locationPriority(job):5,id);added++;if(canQueue)queued++;event(id,canQueue?'queued':'saved',`Found by search: ${search.instruction}`)}
        else if(canQueue){
          const existing=db.prepare("SELECT id FROM jobs WHERE applicant_id=? AND normalized_url=? AND status='saved' AND challenge IS NULL").get(applicant.id,url);
          if(existing&&db.prepare("UPDATE jobs SET status='queued',updated_at=? WHERE id=? AND status='saved' AND challenge IS NULL").run(now(),existing.id).changes){queued++;event(existing.id,'queued','Existing match queued by enabled automatic search');}
        }
      }
    }catch(e){errors.push(`${source}: ${String(e.message).slice(0,150)}`)}
  }
  db.prepare('UPDATE searches SET last_error=? WHERE id=?').run(errors.join('; ').slice(0,600)||null,id);
  const result={scanned,matched,strongMatches,added,queued,duplicatesSkipped,errors,sources:sources.map(s=>({source:s.source,count:s.jobs.length}))};
  db.prepare('UPDATE searches SET last_result_json=? WHERE id=?').run(JSON.stringify(result),id);
  return result;
}

export async function runDueSearches(){
  const hours=Math.max(1,Math.min(24,Number(process.env.SEARCH_INTERVAL_HOURS)||1));
  const cutoff=new Date(Date.now()-hours*60*60*1000).toISOString();
  const due=db.prepare('SELECT id,user_id FROM searches WHERE enabled=1 AND (last_run IS NULL OR last_run<?) LIMIT 5').all(cutoff);
  for(const search of due){try{await runSearch(search.id,search.user_id)}catch(e){console.error('Discovery:',e.message)}}
}
