import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,sep} from 'node:path';
import {createSnapshot,inspectDatabase,restoreToEmpty} from './state-snapshot.mjs';
import {preflight,activationEnvironment,acquireRuntimeLock,validateConfig} from './local-deployment.mjs';
import {resolveResumePath} from '../storage-paths.js';

async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'applypilot-local-deploy-test-')),source=join(root,'source.sqlite'),uploads=join(root,'uploads'),bundle=join(root,'bundle'),data=join(root,'runtime');
 t.after(()=>{const r=relative(resolve(tmpdir()),resolve(root));assert(r&&!r.startsWith('..'+sep)&&r!=='..');rmSync(root,{recursive:true,force:true})});
 const db=new DatabaseSync(source);
 db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE users(id TEXT PRIMARY KEY,password_hash TEXT);
 CREATE TABLE applicants(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),resume_path TEXT,approved_answers TEXT);
 CREATE TABLE resume_previous(applicant_id TEXT PRIMARY KEY,user_id TEXT,path TEXT,saved_at TEXT);
 CREATE TABLE protected_attempts(id TEXT PRIMARY KEY,phase TEXT,attempts INTEGER,receipt TEXT);
 INSERT INTO users VALUES('fictional','NOT_A_CREDENTIAL');
 INSERT INTO applicants VALUES('p','fictional','/verified-old/resumes/current.pdf','FICTIONAL_APPROVED_FACT');
 INSERT INTO resume_previous VALUES('p','fictional','/verified-old/resumes/previous.docx','2026');
 INSERT INTO protected_attempts VALUES('uncertain','uncertain',1,NULL);`);db.close();
 mkdirSync(uploads);writeFileSync(join(uploads,'current.pdf'),'%PDF-FICTIONAL');writeFileSync(join(uploads,'previous.docx'),'FICTIONAL-DOCX');
 await createSnapshot(source,uploads,bundle);restoreToEmpty(bundle,data);
 const config={format:1,data_dir:data,source_bundle:bundle,source_manifest_sha256:createHash('sha256').update(readFileSync(join(bundle,'manifest.json'))).digest('hex'),legacy_upload_dir:'/verified-old/resumes',public_origin:'http://localhost:8080',bind_host:'127.0.0.1',port:8080,local_browser_only:true,background_work:false};
 return {root,source,bundle,data,config};
}

test('local preflight verifies unchanged ledger and resolves both current and previous legacy resume paths',async t=>{
 const f=await fixture(t),before=inspectDatabase(join(f.data,'database.sqlite'));
 assert.deepEqual(preflight(f.config),{ready:true,activated:false,table_count:4,resume_references:2,background_work:false,hosted_browser:false});
 assert.deepEqual(inspectDatabase(join(f.data,'database.sqlite')),before);
 const path=resolveResumePath('/verified-old/resumes/current.pdf',{root:join(f.data,'resumes'),legacyRoot:f.config.legacy_upload_dir});
 assert.equal(readFileSync(path,'utf8'),'%PDF-FICTIONAL');
 const db=new DatabaseSync(join(f.data,'database.sqlite'),{readOnly:true});
 try{assert.equal(db.prepare('SELECT resume_path FROM applicants').get().resume_path,'/verified-old/resumes/current.pdf');assert.equal(db.prepare('SELECT phase FROM protected_attempts').get().phase,'uncertain')}finally{db.close()}
});

test('absent or incomplete restored data cannot initialize a new ledger',async t=>{
 const f=await fixture(t);rmSync(join(f.data,'database.sqlite'));
 assert.throws(()=>preflight(f.config));assert(!existsSync(join(f.data,'database.sqlite')));
 writeFileSync(join(f.data,'INCOMPLETE'),'unfinished');assert.throws(()=>preflight(f.config),/incomplete_restore/);
});

test('changed protected data, manifest and resume bytes block first activation',async t=>{
 const f=await fixture(t),dbPath=join(f.data,'database.sqlite'),bytes=readFileSync(dbPath);
 const db=new DatabaseSync(dbPath);db.exec('UPDATE protected_attempts SET attempts=0');db.close();
 assert.throws(()=>preflight(f.config),/restored_state_mismatch/);
 writeFileSync(dbPath,bytes);
 assert.throws(()=>preflight({...f.config,source_manifest_sha256:'0'.repeat(64)}),/source_manifest_mismatch/);
 writeFileSync(join(f.data,'resumes','current.pdf'),'changed');assert.throws(()=>preflight(f.config),/restored_state_mismatch/);
});

test('loopback, paused background work and independent backup are required',async t=>{
 const f=await fixture(t);
 for(const mutation of [{bind_host:'0.0.0.0'},{public_origin:'https://unapproved.invalid'},{local_browser_only:false},{port:8081}])assert.throws(()=>validateConfig({...f.config,...mutation}),/only_loopback/);
 assert.throws(()=>validateConfig({...f.config,background_work:true}),/must_remain_paused/);
 assert.throws(()=>validateConfig({...f.config,data_dir:f.bundle}),/separate_from_backup/);
});

test('activation requires all cutover attestations and existing identity configuration',async t=>{
 const {config}=await fixture(t);
 const approval={format:1,source_manifest_sha256:config.source_manifest_sha256,target_origin:config.public_origin,source_writers_frozen:true,backup_verified:true,same_extension_transition_reviewed:true,chrome_helper_stopped:true,ap2_stopped:true,secrets_provisioning_approved:true,cutover_approved:true};
 // Fixed synthetic sentinel, never an account or live credential.
 const env={SESSION_SECRET:'SYNTHETIC_TEST_SENTINEL_NOT_FOR_USE',REGISTRATION_CODE:'SYNTHETIC_TEST_ONLY'};
 for(const key of Object.keys(approval).filter(key=>approval[key]===true))assert.throws(()=>activationEnvironment(config,{...approval,[key]:false},env),/explicit_cutover_approval/);
 assert.throws(()=>activationEnvironment(config,approval,{}),/existing_identity_configuration/);
 const runtime=activationEnvironment(config,approval,env);
 assert.equal(runtime.SESSION_SECRET,env.SESSION_SECRET);assert.equal(runtime.BIND_HOST,'127.0.0.1');assert.equal(runtime.APPLYPILOT_BACKGROUND_TASKS,'paused');assert.equal(runtime.PUBLIC_SIGNUP,'false');
 assert.equal(runtime.DATABASE_PATH,join(config.data_dir,'database.sqlite'));
});

test('a second writer and a stale lock both require operator review',async t=>{
 const {data}=await fixture(t),release=acquireRuntimeLock(data);
 assert.throws(()=>acquireRuntimeLock(data),/runtime_already_locked/);release();release();
 writeFileSync(join(data,'api-runtime.lock'),'stale synthetic lock');
 assert.throws(()=>acquireRuntimeLock(data),/runtime_already_locked/);
});

test('resume alias rejects traversal, unrelated roots, URLs and prefix lookalikes',()=>{
 const root=resolve(tmpdir(),'fictional-resume-root'),options={root,legacyRoot:'/verified-old/resumes'};
 for(const stored of ['/verified-old/resumes/../secret.pdf','/verified-old/resumes2/a.pdf','/unrelated/a.pdf','relative.pdf','https://example.invalid/a.pdf','/verified-old/resumes/a/./b.pdf'])assert.throws(()=>resolveResumePath(stored,options));
 assert.equal(resolveResumePath(join(root,'new.pdf'),options),join(root,'new.pdf'));
 assert.equal(resolveResumePath('/existing/default.pdf',{legacyRoot:''}),'/existing/default.pdf');
});
