import {companyApplicationKeys} from './company-application-policy.js';
import {applicationRoleKey} from './application-dedup.js';

export const COMPANY_ROTATION_SIZE=5;
export function applicationPlatform(value){
 try{const host=new URL(typeof value==='string'?value:value?.url).hostname.toLowerCase();
  for(const [key,pattern] of [['greenhouse',/(^|\.)greenhouse\.io$/],['ashby',/(^|\.)ashbyhq\.com$/],['lever',/(^|\.)lever\.co$/],['workday',/(^|\.)(?:myworkdayjobs|workdayjobs)\.com$/],['workable',/(^|\.)workable\.com$/],['smartrecruiters',/(^|\.)smartrecruiters\.com$/],['bamboohr',/(^|\.)bamboohr\.com$/],['recruitee',/(^|\.)recruitee\.com$/]])if(pattern.test(host))return key;
  return host.replace(/^www\./,'');
 }catch{return '';}
}
const began=job=>['running','local_browser','submitted','interview','rejected','offer'].includes(job.status)||!!job.local_attempt_at||!!job.confirmation||Number(job.attempts)>0||job.external===true;
export function diversifyApplications(jobs,history=[]){
 const rows=[...jobs],parents=new Map(),keyCache=new Map();
 const root=key=>{if(!parents.has(key))parents.set(key,key);let value=key;while(parents.get(value)!==value)value=parents.get(value);return value;};
 const keys=job=>{if(!keyCache.has(job))keyCache.set(job,companyApplicationKeys(job));return keyCache.get(job);};
 for(const job of [...history,...rows]){const all=keys(job);for(const key of all.slice(1)){const a=root(all[0]),b=root(key);if(a!==b)parents.set(b,a);}}
 const companies=new Map(),platforms=new Map();for(const job of [...history,...rows]){const all=keys(job);companies.set(job,all.length?root(all[0]):'unknown:'+String(job.id||job.url));platforms.set(job,applicationPlatform(job));}
 const company=job=>companies.get(job),platform=job=>platforms.get(job);
 const companyCounts=new Map(),platformCounts=new Map(),candidateIds=new Set(rows.map(j=>j.id).filter(Boolean)),seen=new Set();
 const add=(map,key)=>{if(key)map.set(key,(map.get(key)||0)+1);};
 for(const job of history){
  if(candidateIds.has(job.id)||!began(job))continue;
  const employer=company(job),identity=employer+':'+(applicationRoleKey(job.title)||job.normalized_url||job.url||job.id);
  if(seen.has(identity))continue;seen.add(identity);add(companyCounts,employer);add(platformCounts,platform(job));
 }
 const score=job=>Number(job.match_score??job.assessment?.score)||0;
 const counts=job=>{const n=companyCounts.get(company(job))||0;return [Math.floor(n/COMPANY_ROTATION_SIZE),n===0?0:1,platformCounts.get(platform(job))||0,n];};
 const compare=(a,b)=>{const ac=counts(a),bc=counts(b);for(let i=0;i<ac.length;i++)if(ac[i]!==bc[i])return ac[i]-bc[i];return score(b)-score(a)||String(a.created_at||'').localeCompare(String(b.created_at||''))||String(a.id||a.url).localeCompare(String(b.id||b.url));};
 const ordered=[];
 while(rows.length){let best=0;for(let i=1;i<rows.length;i++)if(compare(rows[i],rows[best])<0)best=i;const [job]=rows.splice(best,1);ordered.push(job);add(companyCounts,company(job));add(platformCounts,platform(job));}
 return ordered;
}
export function applicationDiversityHistory(db,userId){
 return [...db.prepare("SELECT id,company,title,url,normalized_url,status,attempts,local_attempt_at,confirmation FROM jobs WHERE user_id=? AND status!='duplicate'").all(userId),...db.prepare('SELECT id,company,title,status FROM external_application_history WHERE user_id=?').all(userId).map(j=>({...j,external:true}))];
}
export function prioritizeApplications(db,userId,jobs){
 const pending=jobs.filter(j=>['saved','queued','paused','needs_review','local_browser'].includes(j.status)&&!j.local_attempt_at&&!['Unconfirmed submission','Submission in progress'].includes(j.challenge)),ids=new Set(pending.map(j=>j.id));
 return [...diversifyApplications(pending,applicationDiversityHistory(db,userId)).map((job,index)=>({...job,queue_position:index+1})),...jobs.filter(j=>!ids.has(j.id))];
}
export function spreadDiscoveryBoards(boards){
 const groups=new Map();for(const board of boards){const platform=applicationPlatform(board);if(!groups.has(platform))groups.set(platform,[]);if(!groups.get(platform).includes(board))groups.get(platform).push(board);}
 const ordered=[];while([...groups.values()].some(group=>group.length))for(const group of groups.values())if(group.length)ordered.push(group.shift());return ordered;
}
