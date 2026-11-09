// Worker and Chrome-helper freshness for the dashboard. Read-only: nothing here
// starts, restarts or retries an application.
export const WORKER_FRESH_MS=45000;
// The helper polls every 30 seconds; four missed polls count as offline.
export const HELPER_FRESH_MS=120000;

const tableExists=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
function freshness(at,limit,now){
 const time=typeof at==='string'?Date.parse(at):NaN;
 if(!Number.isFinite(time))return {state:'unknown',lastSeenAt:null,ageSeconds:null};
 const age=Math.max(0,now-time);
 return {state:age<limit?'online':'offline',lastSeenAt:new Date(time).toISOString(),ageSeconds:Math.round(age/1000)};
}
const ago=seconds=>seconds<90?seconds+' seconds ago':Math.round(seconds/60)+' minutes ago';

export function connectionStatus(db,uid,now=Date.now()){
 const heartbeat=tableExists(db,'worker_status')?db.prepare('SELECT heartbeat FROM worker_status WHERE id=1').get()?.heartbeat:null;
 // Only the signed-in helper's own queue poll records a check-in for this account.
 const checkin=tableExists(db,'browser_helper_checkins')?db.prepare('SELECT last_seen_at FROM browser_helper_checkins WHERE user_id=?').get(uid)?.last_seen_at:null;
 const worker=freshness(heartbeat,WORKER_FRESH_MS,now),helper=freshness(checkin,HELPER_FRESH_MS,now);
 const problems=[];
 if(worker.state!=='online')problems.push(worker.state==='unknown'?'The ApplyPilot worker has not started. Start ApplyPilot on this PC; saved answers are kept.':'The ApplyPilot worker stopped responding '+ago(worker.ageSeconds)+'. Restart ApplyPilot on this PC; saved answers are kept.');
 if(helper.state!=='online')problems.push(helper.state==='unknown'?'The Chrome helper has not checked in. Open Chrome with ApplyPilot Local enabled and signed in.':'The Chrome helper last checked in '+ago(helper.ageSeconds)+'. Open Chrome with ApplyPilot Local enabled; parked forms wait safely.');
 return {ok:!problems.length,worker,helper,message:problems.length?problems.join(' '):'Worker and Chrome helper are connected.'};
}
