import {randomUUID} from 'node:crypto';
import {db,event,now,normalizeURL} from './db.js';

const boardHosts=new Set(['boards.greenhouse.io','job-boards.greenhouse.io','jobs.lever.co','jobs.eu.lever.co']);
const jobHosts=/(^|\.)(greenhouse\.io|lever\.co)$/;
const placeWords=['remote','canada','toronto','ontario','united states','usa','uk','united kingdom'];
const filler=/\b(find|search|show|me|for|a|an|the|jobs?|roles?|positions?|openings?|apply|to|automatically|please|that|are|in|at|from|with|my|all|new|and)\b/gi;

export function parseBoards(input){
  const lines=String(input||'').split(/[\s,]+/).map(s=>s.trim()).filter(Boolean);
  if(!lines.length||lines.length>8)throw Error('Enter 1 to 8 Greenhouse or Lever board links');
  return [...new Set(lines.map(s=>{
    let u;try{u=new URL(s)}catch{throw Error('Enter complete HTTPS board links')}
    if(u.protocol!=='https:'||!boardHosts.has(u.hostname)||u.username||u.password)throw Error('Only public Greenhouse and Lever board links are supported');
    const token=u.pathname.split('/').filter(Boolean)[0];
    if(!token||!/^[a-z0-9_-]{2,80}$/i.test(token))throw Error('Use an employer board link, such as https://boards.greenhouse.io/company');
    return `${u.origin}/${token}`;
  }))];
}

export function parseIntent(input){
  const instruction=String(input||'').trim().slice(0,300);
  if(!instruction)throw Error('Describe the roles you want');
  const lower=instruction.toLowerCase();
  const remote=/\bremote\b/.test(lower);
  const places=placeWords.filter(p=>new RegExp(`\\b${p}\\b`,'i').test(lower)&&p!=='remote');
  let roleText=instruction.split(';')[0].replace(/\b(in|near|around)\s+(canada|toronto|ontario|united states|usa|uk|united kingdom)\b/gi,'').replace(/\bremote\b/gi,'').replace(filler,' ').replace(/\s+/g,' ').trim();
  let roles=roleText.split(/\s*(?:,|\bor\b|\/|&)\s*/i).map(s=>s.toLowerCase().trim()).filter(Boolean);
  if(!roles.length)throw Error('Include a role, for example: DevOps engineer; remote; Canada');
  return {roles:roles.slice(0,8),remote,places};
}

function matches(job,intent){
  const title=String(job.title||'').toLowerCase(),location=String(job.location||'').toLowerCase();
  if(!intent.roles.some(role=>role.split(/\s+/).every(word=>title.includes(word))))return false;
  if(intent.remote&&!(/\bremote\b/.test(location)||job.remote===true))return false;
  if(intent.places.length&&!intent.places.some(place=>location.includes(place)||place==='canada'&&/\b(on|bc|ab|qc|mb|ns|nb|sk|pe|nl)\b/i.test(location)))return false;
  return true;
}

async function readJSON(url){
  const response=await fetch(url,{signal:AbortSignal.timeout(12000),headers:{accept:'application/json'}});
  if(!response.ok)throw Error(`Job board returned ${response.status}`);
  if(Number(response.headers.get('content-length')||0)>8000000)throw Error('Job board response too large');
  const body=await response.text();if(body.length>8000000)throw Error('Job board response too large');
  return JSON.parse(body);
}

async function listBoard(board){
  const u=new URL(board),token=u.pathname.slice(1);
  if(u.hostname.includes('greenhouse.io')){
    const data=await readJSON(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`);
    return (data.jobs||[]).slice(0,500).map(j=>({title:j.title,company:token,location:j.location?.name,url:j.absolute_url}));
  }
  const api=u.hostname==='jobs.eu.lever.co'?'https://api.eu.lever.co':'https://api.lever.co';
  const data=await readJSON(`${api}/v0/postings/${encodeURIComponent(token)}?mode=json&limit=500`);
  if(!Array.isArray(data))throw Error('Job board response is invalid');
  return data.map(j=>({title:j.text,company:token,location:j.categories?.location||j.categories?.allLocations?.join(', '),remote:j.workplaceType==='remote',url:j.applyUrl||j.hostedUrl}));
}

export async function runSearch(id,userId){
  const search=db.prepare('SELECT * FROM searches WHERE id=? AND user_id=?').get(id,userId);
  if(!search)throw Error('Search not found');
  const applicant=db.prepare('SELECT * FROM applicants WHERE id=? AND user_id=?').get(search.applicant_id,userId);
  if(!applicant)throw Error('Applicant not found');
  const intent=parseIntent(search.instruction),boards=JSON.parse(search.boards_json);
  db.prepare('UPDATE searches SET last_run=?,last_error=NULL WHERE id=?').run(now(),id);
  let scanned=0,matched=0,added=0,queued=0,errors=[];
  for(const board of boards){
    try{
      const jobs=await listBoard(board);
      scanned+=jobs.length;
      for(const job of jobs){
        if(added>=30)break;
        if(!matches(job,intent))continue;
        matched++;
        let url;try{url=normalizeURL(job.url)}catch{continue}
        if(!jobHosts.test(new URL(url).hostname))continue;
        const canQueue=!!(search.auto_queue&&applicant.consent&&applicant.email&&applicant.resume_path);
        const id=randomUUID(),date=now();
        const result=db.prepare('INSERT OR IGNORE INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(id,userId,applicant.id,String(job.title).slice(0,200),String(job.company).slice(0,200),url,url,canQueue?'queued':'saved',`Found on ${board}${job.location?' · '+String(job.location).slice(0,100):''}`,date,date);
        if(result.changes){added++;if(canQueue)queued++;event(id,canQueue?'queued':'saved',`Found by search: ${search.instruction}`)}
      }
    }catch(e){errors.push(`${board}: ${String(e.message).slice(0,150)}`)}
  }
  db.prepare('UPDATE searches SET last_error=? WHERE id=?').run(errors.join('; ').slice(0,600)||null,id);
  return {scanned,matched,added,queued,errors};
}

export async function runDueSearches(){
  const cutoff=new Date(Date.now()-6*60*60*1000).toISOString();
  const due=db.prepare('SELECT id,user_id FROM searches WHERE enabled=1 AND (last_run IS NULL OR last_run<?) LIMIT 5').all(cutoff);
  for(const search of due){try{await runSearch(search.id,search.user_id)}catch(e){console.error('Discovery:',e.message)}}
}
