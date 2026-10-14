import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,sep} from 'node:path';
import {createSnapshot,inspectDatabase,restoreToEmpty} from './state-snapshot.mjs';
import {hostedPreflight,hostedEnvironment,hostedConfigDigest,validateHostedConfig,publicOrigin,localDurableFilesystem,activateHosted} from './hosted-deployment.mjs';
import {probeHost} from './host-capability-probe.mjs';

async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'applypilot-hosted-test-')),source=join(root,'source.sqlite'),uploads=join(root,'uploads'),bundle=join(root,'bundle'),data=join(root,'runtime');
 t.after(()=>{const r=relative(resolve(tmpdir()),resolve(root));assert(r&&!r.startsWith('..'+sep)&&r!=='..');rmSync(root,{recursive:true,force:true})});
 const db=new DatabaseSync(source);
 db.exec(`CREATE TABLE applicants(id TEXT PRIMARY KEY,resume_path TEXT);
 CREATE TABLE resume_previous(applicant_id TEXT PRIMARY KEY,path TEXT);
 CREATE TABLE protected_attempts(id TEXT PRIMARY KEY,phase TEXT,receipt TEXT);
 INSERT INTO applicants VALUES('fictional','/app/data/resumes/current.pdf');
 INSERT INTO resume_previous VALUES('fictional','/app/data/resumes/previous.pdf');
 INSERT INTO protected_attempts VALUES('fictional-uncertain','uncertain',NULL);`);db.close();
 mkdirSync(uploads);writeFileSync(join(uploads,'current.pdf'),'%PDF-SYNTHETIC');writeFileSync(join(uploads,'previous.pdf'),'%PDF-SYNTHETIC-OLD');
 await createSnapshot(source,uploads,bundle);restoreToEmpty(bundle,data);
 const config={format:1,provider:'alwaysdata',data_dir:data,source_bundle:bundle,source_manifest_sha256:createHash('sha256').update(readFileSync(join(bundle,'manifest.json'))).digest('hex'),legacy_upload_dir:'/app/data/resumes',public_origin:'https://fictional.alwaysdata.net',bind_host:'127.0.0.1',port:8080,local_browser_only:true,background_work:false};
 return {root,data,bundle,config};
}
test('public-host preflight preserves all rows and both legacy resume paths',async t=>{
 const {config,data}=await fixture(t),before=inspectDatabase(join(data,'database.sqlite'));
 const result=hostedPreflight(config);assert.equal(result.state_verified,true);assert.equal(result.resume_references,2);assert.equal(result.activated,false);
 assert.deepEqual(inspectDatabase(join(data,'database.sqlite')),before);
 assert.equal(existsSync(join(data,'ACTIVE-HOSTED-DEPLOYMENT.json')),false);
});
test('missing, incomplete or changed data cannot become a new hosted ledger',async t=>{
 const {config,data}=await fixture(t),path=join(data,'database.sqlite');
 const db=new DatabaseSync(path);db.exec("UPDATE protected_attempts SET phase='ready'");db.close();
 assert.throws(()=>hostedPreflight(config),/restored_state_mismatch/);
 writeFileSync(join(data,'INCOMPLETE'),'synthetic');assert.throws(()=>hostedPreflight(config),/incomplete_restore/);
 rmSync(join(data,'INCOMPLETE'));rmSync(path);assert.throws(()=>hostedPreflight(config));assert.equal(existsSync(path),false);
});
test('public host configuration rejects non-HTTPS, arbitrary URLs and execution changes',async t=>{
 const {config,bundle}=await fixture(t);
 for(const origin of ['http://example.test','https://example.test/','https://x:secret@example.test','https://example.test/path','https://example.test:8443','https://localhost','https://127.0.0.1'])assert.throws(()=>publicOrigin(origin),/public_https/);
 for(const change of [{background_work:true},{local_browser_only:false},{data_dir:bundle},{provider:'render'}])assert.throws(()=>validateHostedConfig({...config,...change}));
 assert.equal(localDurableFilesystem(0x6969),false); // NFS
 assert.equal(localDurableFilesystem(0x01021994),false); // tmpfs
 assert.equal(localDurableFilesystem(0x794c7630),false); // overlay
});
test('approval is bound to all target settings and supplies no new identity or credentials',async t=>{
 const {config}=await fixture(t),approval=JSON.parse(readFileSync(new URL('./hosted-approval.example.json',import.meta.url),'utf8'));
 approval.config_digest=hostedConfigDigest(config);for(const key of Object.keys(approval))if(typeof approval[key]==='boolean')approval[key]=true;
 const env={SESSION_SECRET:'SYNTHETIC_HOSTED_TEST_SENTINEL_ONLY',REGISTRATION_CODE:'SYNTHETIC'};
 for(const gate of Object.keys(approval).filter(k=>approval[k]===true))assert.throws(()=>hostedEnvironment(config,{...approval,[gate]:false},env),/explicit_hosted/);
 assert.throws(()=>hostedEnvironment({...config,public_origin:'https://other.invalid'},approval,env),/explicit_hosted/);
 assert.throws(()=>hostedEnvironment(config,approval,{}),/existing_identity/);
 const runtime=hostedEnvironment(config,approval,env);assert.equal(runtime.SESSION_SECRET,env.SESSION_SECRET);assert.equal(runtime.PUBLIC_ORIGIN,config.public_origin);assert.equal(runtime.SERVICE_ORIGIN,config.public_origin);assert.equal(runtime.PUBLIC_SIGNUP,'false');assert.equal(runtime.APPLYPILOT_BACKGROUND_TASKS,'paused');
});
test('a restart retains operational state but cannot silently switch public origin',async t=>{
 const {config,data}=await fixture(t);
 writeFileSync(join(data,'ACTIVE-HOSTED-DEPLOYMENT.json'),JSON.stringify({format:1,config_digest:hostedConfigDigest(config)}));
 const db=new DatabaseSync(join(data,'database.sqlite'));db.exec("INSERT INTO protected_attempts VALUES('fictional-later','uncertain',NULL)");db.close();
 assert.equal(hostedPreflight(config).activated,true);
 assert.throws(()=>hostedPreflight({...config,public_origin:'https://other.invalid'}),/active_hosted_identity/);
});
test('candidate host probe uses synthetic data and verifies WAL, guard and restart semantics',async t=>{
 const {root}=await fixture(t),destination=join(root,'new-probe');
 const result=probeHost(destination);assert.equal(result.synthetic_only,true);assert.equal(result.storage_semantics_verified,true);assert.equal(result.host_ready,false);
 assert.throws(()=>probeHost(destination),/must_not_exist/);
});
test('Windows runtime cannot activate a public Linux candidate',async t=>{
 if(process.platform!=='win32'){t.skip('Windows-only refusal check');return}
 const {config}=await fixture(t);await assert.rejects(activateHosted(config,{},{}),/linux_node_twenty_four_required/);
});
