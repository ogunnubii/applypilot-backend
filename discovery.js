import {worldwideTechIntent} from './tech-search.js';
import {excludesFrench,frenchApplication,archiveFrench} from './language-policy.js';
import {employerHold} from './employer-limits.js';
import {companyApplicationPolicy,deferForCompanyLimit,isCompanyApplicationPolicyError,markExactRequisitionDuplicate} from './company-application-policy.js';
import {pipelineEnabled,queueFoundApplications} from './application-pipeline.js';
import {priorApplication} from './application-dedup.js';
import {diversifyApplications,applicationDiversityHistory,spreadDiscoveryBoards} from './application-diversity.js';
import {jobIntelligence,nextApplicationEligible} from './job-intelligence.js';
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
  const broadTech=worldwideTechIntent(rawInstruction);
  const worldwideEligibility=broadTech||/\bworldwide\b[^;]*(?:sponsorship|visa)/i.test(rawInstruction)||/;\s*eligibility:\s*worldwide sponsorship, remote from Canada, or B2B/i.test(rawInstruction);
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
  return {broadTech,worldwideEligibility,roles:roles.slice(0,80),remote:locationOrder||worldwideEligibility?false:remote,places:locationOrder||worldwideEligibility?[]:places,localPlaces:locationOrder||worldwideEligibility?[]:localPlaces,remotePlaces:locationOrder||worldwideEligibility?[]:remotePlaces,remoteAny:locationOrder||worldwideEligibility?false:remoteAny,locationOrder};
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

export const SEARCH_INTERVAL_SECONDS=60;
const feedCache=new Map(),pendingFeeds=new Map(),boardBackoff=new Map();
async function readJSON(url){
 const endpoint=new URL(url);const host=endpoint.origin+endpoint.pathname.split('/').slice(0,5).join('/');if(Math.max(boardBackoff.get(host)||0,boardBackoff.get(endpoint.origin)||0)>Date.now())throw Error('Source temporarily cooling down after an error');
 const response=await fetch(url,{signal:AbortSignal.timeout(10000),headers:{accept:'application/json'}});
 if(!response.ok){
  if(response.status===429||response.status>=500){const retry=response.headers.get('retry-after'),seconds=Number(retry),until=retry?(Number.isFinite(seconds)?Date.now()+seconds*1000:Date.parse(retry)):0;boardBackoff.set(response.status===429?endpoint.origin:host,Math.min(Date.now()+3600000,Math.max(Date.now()+60000,until||Date.now()+300000)));}
  const error=Error('Job board returned '+response.status);error.status=response.status;throw error;
 }
 // Large public employer feeds include hundreds of full descriptions. Bound
 // the decoded stream as well as Content-Length, including compressed feeds.
 const limit=24000000;
 if(Number(response.headers.get('content-length')||0)>limit){await response.body?.cancel().catch(()=>{});throw Error('Job board response too large');}
 if(response.body){
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.byteLength;if(size>limit)throw Error('Job board response too large');chunks.push(Buffer.from(chunk));}
  return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
 }
 const body=await response.text();if(Buffer.byteLength(body)>limit)throw Error('Job board response too large');return JSON.parse(body);
}
async function cachedJSON(url,ttl=60000){
 const hit=feedCache.get(url);if(hit&&Date.now()-hit.at<ttl)return hit.data;
 if(pendingFeeds.has(url))return pendingFeeds.get(url);
 const task=readJSON(url).then(data=>{if(feedCache.size>=3000)feedCache.delete(feedCache.keys().next().value);feedCache.set(url,{at:Date.now(),data});return data;}).finally(()=>pendingFeeds.delete(url));
 pendingFeeds.set(url,task);return task;
}
export function sourceBatch(boards,cursor=0,size=4){
 if(!boards.length)return {boards:[],next:0};const start=(Math.max(0,Number(cursor)||0))%boards.length,n=Math.min(size,boards.length);
 return {boards:Array.from({length:n},(_,i)=>boards[(start+i)%boards.length]),next:(start+n)%boards.length};
}

async function broadListings(intent){
  const errors=[],batches=[];
  try{
    const query=new URLSearchParams({count:'200'});
    const geoPlaces=[...(intent.places||[]),...(intent.remotePlaces||[])];
    if(geoPlaces.includes('canada'))query.set('geo','canada');
    else if(geoPlaces.includes('usa')||geoPlaces.includes('united states'))query.set('geo','usa');
    const data=await cachedJSON(`https://jobicy.com/api/v2/remote-jobs?${query}`,3600000);
    batches.push({source:'Jobicy',jobs:(data.jobs||[]).map(j=>({title:j.jobTitle,company:j.companyName,location:j.jobGeo,remote:true,url:j.url}))});
  }catch(e){errors.push(`Jobicy: ${String(e.message).slice(0,150)}`)}
  try{
    for(let page=1;page<=5;page++){
      const data=await cachedJSON('https://www.arbeitnow.com/api/job-board-api'+(page===1?'':'?page='+page),3600000);
      batches.push({source:'Arbeitnow page '+page,jobs:(data.data||[]).map(j=>({title:j.title,company:j.company_name,location:j.location,remote:j.remote,url:j.url}))});
      if(!data.links?.next||!data.data?.length)break;
    }
  }catch(e){errors.push(`Arbeitnow: ${String(e.message).slice(0,150)}`)}
  return {batches,errors};
}

export async function listBoard(board,options={}){
  const u=new URL(board),token=decodeURIComponent(u.pathname.slice(1));
  if(u.hostname.includes('greenhouse.io')){
    const data=await cachedJSON(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`);
    return (data.jobs||[]).map(j=>({title:j.title,company:token,location:j.location?.name,publishedAt:j.first_published,description:j.content,descriptionURL:Number.isInteger(j.id)?`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs/${j.id}?pay_transparency=true`:null,url:j.absolute_url}));
  }
  if(u.hostname==='jobs.ashbyhq.com'){
    const data=await cachedJSON(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`);
    return (data.jobs||[]).filter(j=>options.includeUnlisted||j.isListed!==false).map(j=>({title:j.title,company:token,location:j.location,publishedAt:j.publishedAt,compensation:j.compensation,description:j.descriptionPlain||j.descriptionHtml,employmentType:j.employmentType,remote:j.isRemote===true||j.workplaceType==='Remote',url:j.applyUrl||j.jobUrl}));
  }
  const api=u.hostname==='jobs.eu.lever.co'?'https://api.eu.lever.co':'https://api.lever.co';
  const data=await cachedJSON(`${api}/v0/postings/${encodeURIComponent(token)}?mode=json&limit=500`);
  if(!Array.isArray(data))throw Error('Job board response is invalid');
  return data.map(j=>({title:j.text,company:token,salaryRange:j.salaryRange,salaryDescriptionPlain:j.salaryDescriptionPlain,publishedAt:j.createdAt?new Date(j.createdAt).toISOString():null,location:j.categories?.location||j.categories?.allLocations?.join(', '),description:[j.descriptionPlain,...(j.lists||[]).map(x=>x.text+' '+x.content),j.additionalPlain].join(' '),employmentType:j.categories?.commitment,remote:j.workplaceType==='remote',url:j.applyUrl||j.hostedUrl}));
}

const defaultBoards=['braze','cloudflare','canonical','gitlab','datadog','grafanalabs'].map(x=>'https://boards.greenhouse.io/'+x).concat('https://jobs.lever.co/newton');
// Current public boards with a high concentration of infrastructure,
// reliability, cloud and support work. They are added only for searches in
// that role family and share a one-minute feed cache.
const infrastructureBoards=["https://jobs.lever.co/zopa","https://jobs.lever.co/spotify","https://jobs.lever.co/palantir","https://job-boards.greenhouse.io/anthropic","https://jobs.ashbyhq.com/openai","https://jobs.ashbyhq.com/cohere","https://jobs.ashbyhq.com/perplexity","https://jobs.ashbyhq.com/marble.ai","https://jobs.ashbyhq.com/acquird","https://jobs.ashbyhq.com/homebase","https://jobs.ashbyhq.com/ashby","https://jobs.ashbyhq.com/remarcable-inc","https://jobs.ashbyhq.com/top-hat","https://jobs.ashbyhq.com/lightspeedhq","https://jobs.ashbyhq.com/hopper","https://jobs.ashbyhq.com/baseten","https://jobs.ashbyhq.com/hiive","https://jobs.ashbyhq.com/n8n","https://jobs.ashbyhq.com/modal","https://jobs.ashbyhq.com/ramp","https://jobs.ashbyhq.com/linear","https://jobs.ashbyhq.com/vanta","https://jobs.ashbyhq.com/notion","https://jobs.ashbyhq.com/cursor","https://jobs.ashbyhq.com/supabase","https://job-boards.greenhouse.io/gitlab","https://job-boards.greenhouse.io/cloudflare","https://job-boards.greenhouse.io/grafanalabs","https://job-boards.greenhouse.io/canonical","https://job-boards.greenhouse.io/datadog","https://job-boards.greenhouse.io/mongodb","https://job-boards.greenhouse.io/elastic","https://job-boards.greenhouse.io/cockroachlabs","https://job-boards.greenhouse.io/databricks","https://job-boards.greenhouse.io/stripe","https://job-boards.greenhouse.io/reddit","https://job-boards.greenhouse.io/figma","https://job-boards.greenhouse.io/netlify","https://job-boards.greenhouse.io/vercel","https://job-boards.greenhouse.io/turing"];
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
export async function detailForJob(row){
 const u=new URL(row.url),parts=u.pathname.split('/').filter(Boolean),board=u.origin+'/'+parts[0];
 if(u.hostname.includes('greenhouse.io')){
  const j=await cachedJSON('https://boards-api.greenhouse.io/v1/boards/'+encodeURIComponent(parts[0])+'/jobs/'+parts[2]+'?pay_transparency=true',3600000);
  return {title:j.title,company:row.company,url:row.url,location:j.location?.name,description:j.content,pay_input_ranges:j.pay_input_ranges,publishedAt:j.first_published};
 }
 if(u.hostname==='jobs.ashbyhq.com'){
  const jobs=await listBoard(board,{includeUnlisted:true});return jobs.find(j=>normalizeURL(j.url)===normalizeURL(row.url))||null;
 }
 if(u.hostname==='jobs.lever.co'||u.hostname==='jobs.eu.lever.co'){
  const host=u.hostname==='jobs.eu.lever.co'?'https://api.eu.lever.co':'https://api.lever.co';
  const j=await cachedJSON(host+'/v0/postings/'+encodeURIComponent(parts[0])+'/'+parts[1],3600000);
  return {title:j.text,company:row.company,url:row.url,location:j.categories?.location,employmentType:j.categories?.commitment,remote:j.workplaceType==='remote',description:[j.descriptionPlain,...(j.lists||[]).map(x=>x.content),j.additionalPlain].join(' '),salaryRange:j.salaryRange,salaryDescriptionPlain:j.salaryDescriptionPlain};
 }
 return undefined;
}
function saveMetadata(id,metadata){
 db.prepare('UPDATE jobs SET job_metadata_json=?,match_score=?,discovery_priority=?,metadata_attempt_at=? WHERE id=?').run(JSON.stringify(metadata),metadata.score||0,metadata.available!==false&&metadata.eligibility?.eligible?100-(metadata.score||0):1000,now(),id);
}
async function refreshTrackedJobs(userId,applicant,intent){
 const cutoff=new Date(Date.now()-15*60000).toISOString(),daily=new Date(Date.now()-86400000).toISOString();
 const rows=db.prepare("SELECT * FROM jobs WHERE user_id=? AND applicant_id=? AND status NOT IN ('duplicate','archived') AND (metadata_attempt_at IS NULL OR metadata_attempt_at<?) AND (json_extract(job_metadata_json,'$.available')=0 OR json_extract(job_metadata_json,'$.checkedAt') IS NULL OR json_extract(job_metadata_json,'$.checkedAt')<?) ORDER BY CASE WHEN status IN ('saved','queued') THEN 0 ELSE 1 END,metadata_attempt_at,created_at DESC LIMIT 4").all(userId,applicant.id,cutoff,daily);
 let refreshed=0;const errors=[];
 await Promise.all(rows.map(async row=>{
  db.prepare('UPDATE jobs SET metadata_attempt_at=? WHERE id=?').run(now(),row.id);
  try{const job=await detailForJob(row);
   if(job){saveMetadata(row.id,jobIntelligence(job,intent,applicant.focus));refreshed++;}
   else if(job===null)saveMetadata(row.id,{available:false,score:0,checkedAt:now(),reasons:['Employer no longer lists this posting'],pay:[]});
  }catch(error){
   if([404,410].includes(error.status))saveMetadata(row.id,{available:false,score:0,checkedAt:now(),reasons:['Employer posting is no longer available'],pay:[]});
   else errors.push('Pay/match refresh for '+row.company+': '+String(error.message).slice(0,100));
  }
 }));
 return {refreshed,errors};
}
async function executeSearch(id,userId){
 const search=db.prepare('SELECT * FROM searches WHERE id=? AND user_id=?').get(id,userId);
 if(!search)throw Error('Search not found');
 const applicant=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(search.applicant_id,userId);
 if(!applicant)throw Error('Applicant not found');
 const resolved=searchIntentForApplicant(search,applicant),intent=resolved.intent,requestedBoards=[...JSON.parse(search.boards_json),...parseBoards(process.env.DISCOVERY_BOARDS||'')],boards=[...new Set([...requestedBoards,...(intent.broadTech?[...curatedBoards(intent,applicant.focus),...defaultBoards]:[...defaultBoards,...curatedBoards(intent,applicant.focus)])].map(board=>board.replace('job-boards.greenhouse.io','boards.greenhouse.io')))];
 const batch=sourceBatch(spreadDiscoveryBoards(boards),search.source_cursor);
 if(search.auto_generated&&resolved.instruction!==search.instruction)db.prepare('UPDATE searches SET instruction=? WHERE id=?').run(resolved.instruction,id);
 db.prepare('UPDATE searches SET last_run=?,last_error=NULL,source_cursor=? WHERE id=?').run(now(),batch.next,id);
 let scanned=0,matched=0,strongMatches=0,added=0,queued=0,duplicatesSkipped=0,detailsFetched=0;const errors=[],sources=[];
 const results=await Promise.allSettled(batch.boards.map(listBoard));
 results.forEach((result,index)=>{if(result.status==='fulfilled')sources.push({source:batch.boards[index],jobs:result.value});else errors.push(batch.boards[index]+': '+String(result.reason?.message).slice(0,150));});
 // Aggregators are supplementary and cached for an hour; direct employer boards rotate every minute.
 if(!search.source_cursor){const broad=await broadListings(intent);sources.push(...broad.batches);errors.push(...broad.errors);}
 const candidates=sources.flatMap(s=>{scanned+=s.jobs.length;return s.jobs.map(job=>({...job,source:s.source}));})
  .map(job=>({job,assessment:matchAssessment(job,intent,applicant.focus)})).filter(x=>x.assessment.matched)
  .sort((a,b)=>b.assessment.score-a.assessment.score||String(a.job.url).localeCompare(String(b.job.url)));
 const history=applicationDiversityHistory(db,userId);
 const diverseCandidates=diversifyApplications(candidates.map(c=>({...c.job,assessment:c.assessment})),history);
 for(const job of diverseCandidates){const assessment=job.assessment;
  if(added>=100)break;let url;try{url=normalizeURL(job.url)}catch{continue;}if(!directDiscoveryLink(url))continue;
  if(job.descriptionURL){
   const hit=feedCache.get(job.descriptionURL),cached=hit&&Date.now()-hit.at<3600000;
   if(!cached&&detailsFetched>=12)continue;if(!cached)detailsFetched++;
   try{const detail=await cachedJSON(job.descriptionURL,3600000);job.description=detail.content||'';job.pay_input_ranges=detail.pay_input_ranges;job.publishedAt=detail.first_published||job.publishedAt;}catch(e){errors.push('Could not verify '+job.company+': '+String(e.message).slice(0,100));continue;}
  }
  if(excludesFrench(db,userId)&&frenchApplication(job))continue;
  const metadata=jobIntelligence(job,intent,applicant.focus),existing=db.prepare('SELECT * FROM jobs WHERE applicant_id=? AND normalized_url=?').get(applicant.id,url);
  if(existing)saveMetadata(existing.id,metadata);
  if(intent.worldwideEligibility&&!metadata.eligibility.eligible)continue;
  const ck=companyKey(job.company),tk=historyKey(job.title);
  const imported=db.prepare('SELECT 1 FROM external_application_history WHERE user_id=? AND company_key=? AND title_key=?').get(userId,ck,tk);
  const prior=db.prepare("SELECT 1 FROM jobs WHERE user_id=? AND history_company(company)=? AND history_title(title)=? AND (status IN ('submitted','interview','offer','rejected','duplicate','archived','running','local_browser','queued') OR local_attempt_at IS NOT NULL)").get(userId,ck,tk);
  if(imported||prior||priorApplication(db,userId,{...job,id:existing?.id})){duplicatesSkipped++;continue;}
  const exactPolicy=typeof companyApplicationPolicy==='function'?companyApplicationPolicy(db,applicant.id,{...job,id:existing?.id,applicant_id:applicant.id,normalized_url:url}):{allowed:true};
  if(!exactPolicy.allowed&&exactPolicy.duplicate){
   if(existing&&typeof markExactRequisitionDuplicate==='function')markExactRequisitionDuplicate(db,existing,exactPolicy);
   duplicatesSkipped++;continue;
  }
  matched++;if(assessment.strong)strongMatches++;
  const jobId=randomUUID(),date=now();
  const result=db.prepare("INSERT OR IGNORE INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'saved',?,?,?)")
   .run(jobId,userId,applicant.id,String(job.title).slice(0,200),String(job.company).slice(0,200),url,url,'Source: '+job.source+(job.location?' · '+String(job.location).slice(0,100):'')+' · '+metadata.reasons.join(' · '),date,date);
  if(result.changes){saveMetadata(jobId,metadata);added++;event(jobId,'saved','Found by search: '+resolved.instruction);}
 }
 const enrichment=await refreshTrackedJobs(userId,applicant,intent);archiveFrench(db,userId);errors.push(...enrichment.errors);
 // The account-wide pipeline includes every found role, regardless of ranking. Prior attempts remain protected.
 if(pipelineEnabled(db,userId))queued+=queueFoundApplications(db,userId,{applicantId:applicant.id}).queued;
 else if(search.auto_queue&&applicant.consent&&applicant.email&&applicant.resume_path){
 const pending=db.prepare("SELECT * FROM jobs WHERE user_id=? AND applicant_id=? AND status='saved' AND challenge IS NULL AND local_attempt_at IS NULL AND attempts=0 ORDER BY match_score DESC,created_at DESC,id").all(userId,applicant.id);
  const ready=pending.filter(row=>nextApplicationEligible(row)&&!employerHold(db,row)&&!priorApplication(db,userId,row)&&!db.prepare('SELECT 1 FROM external_application_history WHERE user_id=? AND company_key=? AND title_key=?').get(userId,companyKey(row.company),historyKey(row.title)));
  for(const best of ready){
   let policy=typeof companyApplicationPolicy==='function'?companyApplicationPolicy(db,best.applicant_id,best):{allowed:true};
   if(!policy.allowed){
    if(policy.duplicate&&typeof markExactRequisitionDuplicate==='function')markExactRequisitionDuplicate(db,best,policy);
    else if(typeof deferForCompanyLimit==='function')deferForCompanyLimit(db,best,policy);
    continue;
   }
   try{
    if(db.prepare("UPDATE jobs SET status='queued',updated_at=? WHERE id=? AND status='saved' AND challenge IS NULL AND local_attempt_at IS NULL AND attempts=0").run(now(),best.id).changes){queued++;event(best.id,'queued','Verified match queued by automatic search');}
   }catch(error){
    if(!(typeof isCompanyApplicationPolicyError==='function'&&isCompanyApplicationPolicyError(error)))throw error;
    const current=db.prepare('SELECT * FROM jobs WHERE id=?').get(best.id)||best;
    policy=typeof companyApplicationPolicy==='function'?companyApplicationPolicy(db,current.applicant_id,current):{allowed:false,message:String(error.message||error),duplicate:/Exact requisition/i.test(String(error.message||error))};
    if(policy.allowed)policy={...policy,allowed:false,message:String(error.message||error),duplicate:/Exact requisition/i.test(String(error.message||error))};
    if(policy.duplicate&&typeof markExactRequisitionDuplicate==='function')markExactRequisitionDuplicate(db,current,policy);
    else if(typeof deferForCompanyLimit==='function')deferForCompanyLimit(db,current,policy);
   }
  }
 }
 const result={scanned,matched,strongMatches,added,queued,duplicatesSkipped,refreshed:enrichment.refreshed,errors,sources:sources.map(s=>({source:s.source,count:s.jobs.length})),sourceCount:boards.length,checkedBoards:batch.boards.length,intervalSeconds:SEARCH_INTERVAL_SECONDS,finishedAt:now()};
 db.prepare('UPDATE searches SET last_error=?,last_result_json=? WHERE id=?').run(errors.join('; ').slice(0,600)||null,JSON.stringify(result),id);
 return result;
}
export async function runDueSearches(){
 // One-second tolerance avoids skipping a minute because of timer jitter.
 const cutoff=new Date(Date.now()-(SEARCH_INTERVAL_SECONDS-1)*1000).toISOString();
 const due=db.prepare('SELECT id,user_id FROM searches WHERE enabled=1 AND (last_run IS NULL OR last_run<?) ORDER BY COALESCE(last_run,created_at),id LIMIT 5').all(cutoff);
 await Promise.all(due.map(async search=>{try{await runSearch(search.id,search.user_id)}catch(e){console.error('Discovery:',e.message);}}));
}
