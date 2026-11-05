// One persisted start/stop switch per account for the local program. When an
// account has never used it, existing behavior is unchanged. When stopped:
// discovery skips that account, found jobs are not queued, and the extension
// stops opening new applications (an open form is left for the applicant).
import {setPipeline} from './application-pipeline.js';
export function installAutopilot(db){
 db.exec('CREATE TABLE IF NOT EXISTS autopilot_state(user_id TEXT PRIMARY KEY REFERENCES users(id),running INTEGER NOT NULL,updated_at TEXT NOT NULL,source TEXT NOT NULL)');
}
export function autopilotState(db,userId){
 const row=db.prepare('SELECT running,updated_at,source FROM autopilot_state WHERE user_id=?').get(userId);
 return row?{configured:true,running:!!row.running,updatedAt:row.updated_at,source:row.source}:{configured:false,running:null,updatedAt:null,source:null};
}
export const autopilotStopped=(db,userId)=>autopilotState(db,userId).running===false;
export function setAutopilot(db,userId,running,source='dashboard'){
 if(typeof running!=='boolean')throw Error('Choose whether ApplyPilot should run.');
 if(!['dashboard','extension','launcher'].includes(source))source='dashboard';
 const at=new Date().toISOString();
 db.prepare('INSERT INTO autopilot_state(user_id,running,updated_at,source) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET running=excluded.running,updated_at=excluded.updated_at,source=excluded.source').run(userId,running?1:0,at,source);
 const pipeline=setPipeline(db,userId,running);
 return {...autopilotState(db,userId),pipeline:{enabled:pipeline.enabled,queued:pipeline.result?.queued||0}};
}
