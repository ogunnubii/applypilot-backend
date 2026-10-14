import {companyKey} from '../application-history.js';
import {handoffIdentity} from '../preparation-handoff.js';

const fail=code=>{throw Object.assign(Error(code),{code});};
// Native runtime integration only. These UDFs are registered on every native
// connection; this is not a replacement for the SQL-only remote guard port.
const matches=(company,title,url)=>`(same_application(${company},${title},${url},i.company,i.title,i.url) OR (history_company(${company})=history_company(i.company) AND history_title(${title})=history_title(i.title)))`;
const held=(company,url)=>`company_keys_overlap(application_company_keys(${company},${url}),application_company_keys(i.company,i.url))`;
const ready=user=>`EXISTS(SELECT 1 FROM runtime_history_boundary WHERE id=1 AND phase='complete') AND EXISTS(SELECT 1 FROM guard_history_import_status WHERE user_id=${user} AND pending=0 AND completed>0 AND source_snapshot_sha IS NOT NULL) AND EXISTS(SELECT 1 FROM guard_accounts WHERE user_id=${user} AND stopped=0)`;
function checks(user,company,title,url){return `
 SELECT CASE WHEN NOT (${ready(user)}) THEN RAISE(ABORT,'imported_history_not_ready_or_stopped') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM guard_protections p LEFT JOIN guard_identity_keys k ON k.id=p.identity_id WHERE p.user_id=${user} AND k.valid IS NOT 1) OR EXISTS(SELECT 1 FROM guard_holds h LEFT JOIN guard_identity_keys k ON k.id=h.identity_id WHERE h.user_id=${user} AND k.valid IS NOT 1) THEN RAISE(ABORT,'invalid_imported_protection') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM guard_protections p JOIN guard_identities i ON i.id=p.identity_id WHERE p.user_id=${user} AND ${matches(company,title,url)}) THEN RAISE(ABORT,'imported_application_protected') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM guard_holds h JOIN guard_identities i ON i.id=h.identity_id WHERE h.user_id=${user} AND ${held(company,url)}) THEN RAISE(ABORT,'imported_employer_held') END;`;}
export const BOUNDARY_MARKER_DENY_SQL=`
CREATE TRIGGER runtime_history_marker_no_update BEFORE UPDATE ON runtime_history_boundary BEGIN SELECT RAISE(ABORT,'immutable_import_boundary'); END;
CREATE TRIGGER runtime_history_marker_no_delete BEFORE DELETE ON runtime_history_boundary BEGIN SELECT RAISE(ABORT,'immutable_import_boundary'); END;
CREATE TRIGGER runtime_history_marker_no_insert BEFORE INSERT ON runtime_history_boundary BEGIN SELECT RAISE(ABORT,'immutable_import_boundary'); END;`;
export const NATIVE_HISTORY_BOUNDARY_SQL=`
CREATE TRIGGER runtime_history_jobs_insert BEFORE INSERT ON jobs WHEN NEW.status IN ('queued','running','local_browser') OR NEW.attempts>0 OR NEW.local_attempt_at IS NOT NULL BEGIN ${checks('NEW.user_id','NEW.company','NEW.title','NEW.url')} END;
CREATE TRIGGER runtime_history_jobs_update BEFORE UPDATE OF status,attempts,local_attempt_at,company,title,url,local_owner,local_phase,handoff_available ON jobs
 WHEN (NEW.status IN ('queued','running','local_browser') AND NEW.status IS NOT OLD.status)
 OR (NEW.local_owner IS NOT NULL AND NEW.local_owner IS NOT OLD.local_owner)
 OR (NEW.local_phase IN ('ready','verifying') AND NEW.local_phase IS NOT OLD.local_phase) OR (NEW.handoff_available=1 AND OLD.handoff_available IS NOT 1)
 OR NEW.attempts>OLD.attempts OR (NEW.local_attempt_at IS NOT NULL AND NEW.local_attempt_at IS NOT OLD.local_attempt_at)
 OR (NEW.status IN ('queued','running','local_browser') AND (NEW.company IS NOT OLD.company OR NEW.title IS NOT OLD.title OR NEW.url IS NOT OLD.url))
 BEGIN ${checks('NEW.user_id','NEW.company','NEW.title','NEW.url')} END;
CREATE TRIGGER runtime_history_attempt_insert BEFORE INSERT ON autonomous_attempts BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM jobs WHERE id=NEW.job_id) THEN RAISE(ABORT,'attempt_job_missing') END;
 ${checks('(SELECT user_id FROM jobs WHERE id=NEW.job_id)','(SELECT company FROM jobs WHERE id=NEW.job_id)','(SELECT title FROM jobs WHERE id=NEW.job_id)','(SELECT url FROM jobs WHERE id=NEW.job_id)')} END;
CREATE TRIGGER runtime_history_reservation_insert BEFORE INSERT ON preparation_handoff_reservations BEGIN
 ${checks('NEW.user_id',"json_extract(NEW.identity_json,'$.employer')","json_extract(NEW.identity_json,'$.title')","json_extract(NEW.identity_json,'$.url')")} END;
`;

export async function importedHistoryState(tx,uid){
 if(!await tx.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_history_boundary'"))return null;
 const marker=await tx.get('SELECT phase FROM runtime_history_boundary WHERE id=1');
 const state=await tx.get('SELECT s.pending,s.completed,s.source_snapshot_sha,a.stopped,e.epoch FROM guard_history_import_status s JOIN guard_accounts a USING(user_id) JOIN guard_preparation_epochs e USING(user_id) WHERE s.user_id=?',uid);
 if(marker?.phase!=='complete'||!state||state.pending||!state.completed||!state.source_snapshot_sha)fail('history_import_incomplete');
 return {source_snapshot_sha:state.source_snapshot_sha,epoch:state.epoch,stopped:state.stopped===1};
}
export async function importedPreparationProblem(tx,job){
 const state=await importedHistoryState(tx,job.user_id);if(!state)return '';
 if(state.stopped)return 'imported_history_not_ready_or_stopped';
 if(await tx.get('SELECT 1 FROM guard_protections p LEFT JOIN guard_identity_keys k ON k.id=p.identity_id WHERE p.user_id=? AND k.valid IS NOT 1 UNION ALL SELECT 1 FROM guard_holds h LEFT JOIN guard_identity_keys k ON k.id=h.identity_id WHERE h.user_id=? AND k.valid IS NOT 1 LIMIT 1',job.user_id,job.user_id))return 'invalid_imported_protection';
 if(await tx.get(`SELECT 1 FROM guard_protections p JOIN guard_identities i ON i.id=p.identity_id WHERE p.user_id=? AND ${matches('?','?','?')} LIMIT 1`,job.user_id,job.company,job.title,job.url,job.company,job.title))return 'imported_application_protected';
 if(await tx.get(`SELECT 1 FROM guard_holds h JOIN guard_identities i ON i.id=h.identity_id WHERE h.user_id=? AND ${held('?','?')} LIMIT 1`,job.user_id,job.company,job.url))return 'imported_employer_held';
 return '';
}
export async function appendImportedProjection(tx,uid,data){
 const state=await importedHistoryState(tx,uid);if(!state)return data;
 // Include import/Stop epoch in the private snapshot digest, not its public
 // schema. Raw native reservation writers independently enforce the same gate.
 data.history_boundary=state;
 for(const table of ['guard_protections','guard_holds']){
  for(let offset=0;;offset+=100){
   const id=table==='guard_protections'?'protection_id':'hold_id',status=table==='guard_protections'?'kind':'reason';
   const page=await tx.all(`SELECT p.${id} record_id,p.${status} record_status,i.company,i.title,i.url,k.valid FROM ${table} p JOIN guard_identities i ON i.id=p.identity_id LEFT JOIN guard_identity_keys k ON k.id=i.id WHERE p.user_id=? ORDER BY p.${id} LIMIT 100 OFFSET ?`,uid,offset);
   if(offset+page.length>20000)fail('incomplete_projection');
   for(const row of page){
    if(row.valid!==1)fail('invalid_protected_identity');
    const identity=handoffIdentity({employer:row.company,title:row.title,url:row.url,location:'Unknown'});
    if(table==='guard_protections')data.records.push({record_id:'imported:'+row.record_id,status:row.record_status,identity});
    else data.employer_holds.push({employer:identity.employer,reason_code:row.record_status==='security'?'excluded':'application_limit',aliases:[...new Set([companyKey(identity.employer),...identity.employer_aliases])].sort()});
   }
   if(data.records.length>20000||data.employer_holds.length>20000||Buffer.byteLength(JSON.stringify(data))>10*1024*1024-1024)fail('incomplete_projection');
   if(page.length<100)break;
  }
 }
 return data;
}
