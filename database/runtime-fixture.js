// Synthetic full native schema for integration tests. Never loads caller data.
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {registerNativeFunctions} from './native-functions.js';
import {hashFile,inspectDatabase} from '../migration/state-snapshot.mjs';

export const FIXTURE_OWNER='11111111-1111-1111-1111-111111111111';
export const FIXTURE_AT='2026-10-13T12:00:00.000Z';
export const fixtureJobId=n=>String(n).padStart(8,'0')+'-1111-1111-1111-111111111111';
export const fixtureURL=n=>'https://jobs.lever.co/fictional'+n+'/'+fixtureJobId(n);
export function runtimeFixture(root){
 const inside=root&&relative(resolve(tmpdir()),resolve(root));if(!inside||inside.startsWith('..'))throw Error('Synthetic Temp root required');
 const dir=mkdtempSync(join(root,'runtime-history-')),path=join(dir,'source.sqlite'),resume=join(dir,'resume.pdf');writeFileSync(resume,'%PDF-1.4 SYNTHETIC RESUME ONLY');
 execFileSync(process.execPath,['--import','./migration/test-network-guard.mjs','--input-type=module','-e',
  "import {db} from './db.js';import {installArchive} from './application-archive.js';import {installLibrary} from './answer-library.js';import {installResearch} from './google-research.js';import {installFactDrafts} from './draft-provenance.js';installArchive(db);installLibrary(db);installResearch(db);installFactDrafts(db);db.exec('PRAGMA wal_checkpoint(TRUNCATE);PRAGMA journal_mode=DELETE;');db.close();"],
  {cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,DATABASE_PATH:path,UPLOAD_DIR:dir,APPLYPILOT_BACKGROUND_TASKS:'paused'},stdio:'pipe',windowsHide:true});
 const source=new DatabaseSync(path);registerNativeFunctions(source);source.exec('PRAGMA foreign_keys=ON');
 for(const uid of ['u','other'])source.prepare('INSERT INTO users VALUES(?,?,?,?)').run(uid,uid+'@example.invalid','SYNTHETIC_PASSWORD_HASH',FIXTURE_AT);
 source.prepare("INSERT INTO applicants(id,user_id,name,email,resume_path,consent,ai_consent,gemini_facts_consent,google_research_consent,created_at) VALUES('p','u','Fictional','u@example.invalid',?,1,1,1,1,?)").run(resume,FIXTURE_AT);
 const add=(n,{status='saved',attempt=false}={})=>{
  source.prepare('INSERT INTO jobs(id,user_id,applicant_id,title,company,url,normalized_url,status,created_at,updated_at,local_owner,local_attempt_at,challenge) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(fixtureJobId(n),'u','p','Engineer '+n,'Fictional '+n,fixtureURL(n),fixtureURL(n),status,FIXTURE_AT,FIXTURE_AT,attempt?FIXTURE_OWNER:null,attempt?FIXTURE_AT:null,attempt?'Unconfirmed submission':null);
  if(attempt)source.prepare("INSERT INTO events(job_id,at,type,message) VALUES(?,?,'submission_started','Synthetic unresolved attempt')").run(fixtureJobId(n),FIXTURE_AT);
 };
 return {dir,path,resume,source,add,finish(){source.close();return {databasePath:path,manifest:{format:1,complete:true,created_at:FIXTURE_AT,database_completed_at:FIXTURE_AT,database_sha256:hashFile(path),database:inspectDatabase(path)}};}};
}
