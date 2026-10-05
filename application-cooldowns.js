import {employerHold} from './employer-limits.js';

// A cooldown is a presentation/work-queue state, never a submission outcome.
// Deriving it on each read means time expiry cannot be missed while offline.
export function applicationCooldown(db,job,{now=Date.now()}={}){
 if(!job||['archived','duplicate','submitted','interview','rejected','offer'].includes(job.status))return null;
 const hold=employerHold(db,job,new Date(now).toISOString());
 if(hold)return {kind:'employer',until:hold.hold_until||null,reason:hold.message,estimated:true};
 return null;
}
export function splitApplicationCooldowns(db,userId,jobs,options={}){
 const active=[],deferred=[];
 for(const job of jobs){
  const cooldown=applicationCooldown(db,{...job,user_id:userId},options);
  if(cooldown)deferred.push({id:job.id,company:job.company,title:job.title,url:job.url,cooldown});
  else active.push(job);
 }
 return {jobs:active,deferred};
}
export function hideCooldownActions(snapshot,ids){
 const held=new Set(ids),keys=['active','blocked','stalled','awaiting'];
 const applications=snapshot.applications.map(row=>held.has(row.id)?{...row,deferred:true,...Object.fromEntries(keys.map(key=>[key,false]))}:row);
 const totals={...snapshot.totals};
 for(const key of keys)totals[key]=applications.filter(row=>row[key]).length;
 return {...snapshot,applications,totals};
}
