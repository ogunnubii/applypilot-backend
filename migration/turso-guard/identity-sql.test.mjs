import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createClient} from '@libsql/client';
import {historyKey,companyKey} from '../../application-history.js';
import {applicationRoleKey,sameApplication} from '../../application-dedup.js';
import {handoffIdentity,handoffURL} from '../../preparation-handoff.js';
import {IDENTITY_SCHEMA_SQL,IDENTITY_MAPPING,IDENTITY_TABLE_SQL,IDENTITY_MAPPING_SQL,IDENTITY_VIEW_SQL,IDENTITY_MATERIALIZED_SQL,IDENTITY_MATERIALIZED_SCHEMA_SQL} from './identity-sql.mjs';

async function fixture(t, driver, schema=IDENTITY_SCHEMA_SQL) {
 if (driver === 'native') {
  const db = new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close());
  const run=(sql,args=[])=>db.prepare(sql).run(...args);
  return {run, all:(sql,args=[])=>db.prepare(sql).all(...args), exec:sql=>db.exec(sql),rollback:async work=>{db.exec('BEGIN IMMEDIATE');try{await work({run});}finally{db.exec('ROLLBACK');}}};
 }
 const client=createClient({url:':memory:',intMode:'number'});t.after(()=>client.close());await client.executeMultiple(schema);
 return {run:(sql,args=[])=>client.execute({sql,args}),all:async(sql,args=[])=>[...(await client.execute({sql,args})).rows],exec:sql=>client.executeMultiple(sql),rollback:async work=>{const tx=await client.transaction('write');try{await work({run:(sql,args=[])=>tx.execute({sql,args})});}finally{await tx.rollback();tx.close();}}};
}

for(const driver of ['native','libsql']) {
 test(`${driver}: indexed keys match the independent SQL view and native algorithms; insertion rollback is atomic`,async t=>{
  const db=await fixture(t,driver,IDENTITY_MATERIALIZED_SCHEMA_SQL);
  await db.exec(IDENTITY_VIEW_SQL.replace('CREATE VIEW guard_identity_keys AS','CREATE VIEW guard_oracle_keys AS'));
  const examples=[['Clutch Technologies Inc.','Développeur — remote',`https://jobs.ashbyhq.com/ClutchTechnologies/${uuid}`],['PricewaterhouseCoopers','Engineer',`https://jobs.eu.lever.co/pwc/${uuid}?utm_source=x`],['ARHS Developments','Engineer — on-site',null],['Fictional','Engineer','https://example.org/private?token=fictional'],['公司','工程师',null],['Acme Ｉｎｃ','𝕯eveloper – hybrid',null],['Fictional','Engineer',`https://jobs.ashbyhq.com/fictional/${'-'.repeat(36)}`]];
  for(let i=0;i<examples.length;i++)await insert(db,String(i),...examples[i]);
  const indexed=await db.all('SELECT * FROM guard_identity_keys ORDER BY id'),oracle=await db.all('SELECT * FROM guard_oracle_keys ORDER BY id');
  assert.deepEqual(indexed.map(r=>({...r})),oracle.map(r=>({...r})));
  for(const r of indexed){const [company,title]=examples[Number(r.id)];assert.equal(r.company_key,companyKey(company));assert.equal(r.role_key,applicationRoleKey(title));}
  await db.rollback(tx=>insert(tx,'rolled-back','Fictional','Engineer',null));
  assert.equal((await db.all("SELECT id FROM guard_identities WHERE id='rolled-back'")).length,0);
  assert.equal((await db.all("SELECT id FROM guard_derived_keys WHERE id='rolled-back'")).length,0);
 });

 test(`${driver}: indexed cache verifies every supplied field against raw identity, including nullable equality`,async t=>{
  const db=await fixture(t,driver,IDENTITY_MATERIALIZED_SCHEMA_SQL);
  await db.exec(IDENTITY_VIEW_SQL.replace('CREATE VIEW guard_identity_keys AS','CREATE VIEW guard_oracle_keys AS'));
  // Privileged fixture-only DDL creates the otherwise unreachable missing-cache
  // condition, exercising verification independently of duplicate-id rejection.
  await db.exec('DROP TRIGGER guard_identity_derive');
  await insert(db,'source','Fictional Inc.','Engineer',null);
  const expected={...(await db.all("SELECT * FROM guard_oracle_keys WHERE id='source'"))[0]};
  const columns=Object.keys(expected),statement='INSERT INTO guard_derived_keys('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')';
  for(const field of columns){const bad={...expected,[field]:field==='valid'?0:'forged-'+field};await assert.rejects(async()=>await db.run(statement,columns.map(c=>bad[c])),/invalid_derived_identity_keys/,field);}
  await db.run(statement,columns.map(c=>expected[c]));assert.deepEqual({...await row(db,'source')},expected,'exact canonical direct insert is harmless');
  await insert(db,'non-null','Fictional','Engineer',`https://jobs.ashbyhq.com/fictional/${uuid}`);
  const withURL={...(await db.all("SELECT * FROM guard_oracle_keys WHERE id='non-null'"))[0]};
  await assert.rejects(async()=>await db.run(statement,columns.map(c=>c==='canonical_url'?null:withURL[c])),/invalid_derived_identity_keys/);
  assert.equal((await db.all("SELECT id FROM guard_derived_keys WHERE id='non-null'")).length,0);
 });

 test(`${driver}: indexed source/cache replacement and deletion are rejected with recursive triggers both off and on`,async t=>{
  const db=await fixture(t,driver,IDENTITY_MATERIALIZED_SCHEMA_SQL);
  await insert(db,'one','Fictional','Engineer',null);
  for(const setting of ['OFF','ON']){
   await db.exec('PRAGMA recursive_triggers='+setting);
   for(const sql of [
    "UPDATE guard_derived_keys SET company_key='forged' WHERE id='one'",
    "DELETE FROM guard_derived_keys WHERE id='one'",
    'INSERT OR REPLACE INTO guard_derived_keys SELECT * FROM guard_derived_keys',
    'INSERT OR IGNORE INTO guard_derived_keys SELECT * FROM guard_derived_keys',
    'INSERT INTO guard_derived_keys SELECT * FROM guard_derived_keys WHERE true ON CONFLICT(id) DO UPDATE SET company_key=excluded.company_key',
    "UPDATE guard_identities SET company='Other' WHERE id='one'",
    "DELETE FROM guard_identities WHERE id='one'",
    "INSERT OR REPLACE INTO guard_identities VALUES('one','fictional','Other','Engineer',NULL)",
    "INSERT INTO guard_identities VALUES('one','fictional','Other','Engineer',NULL) ON CONFLICT(id) DO UPDATE SET company=excluded.company",
   ])await assert.rejects(async()=>await db.run(sql),/immutable_/);
   await insert(db,'fresh-'+setting,'Fictional','Engineer',null);
   assert.equal((await row(db,'fresh-'+setting)).company_key,'fictional','nested verification still fires');
  }
  assert.equal((await row(db,'one')).company_key,'fictional');
  await assert.rejects(async()=>await db.run("UPDATE guard_identity_keys SET company_key='forged'"),/view/);
 });

 test(`${driver}: cache bootstrap backfills existing raw identities through verified normalization`,async t=>{
  const db=await fixture(t,driver,IDENTITY_TABLE_SQL+IDENTITY_MAPPING_SQL);
  await insert(db,'historical','ARHS Developments LLC','Engineer',null);
  await insert(db,'unsupported','Fictional','Engineer','https://example.org/jobs?auth=fictional');
  await db.exec(IDENTITY_MATERIALIZED_SQL);
  assert.equal((await row(db,'historical')).company_key,'arhs');assert.equal((await row(db,'unsupported')).valid,0);
  assert.equal((await db.all('SELECT count(*) AS n FROM guard_derived_keys'))[0].n,2);
 });
}

test('local libSQL: 10,000 indexed identities use a primary-key search for a single-id lookup',async t=>{
 const db=await fixture(t,'libsql',IDENTITY_MATERIALIZED_SCHEMA_SQL);
 const started=performance.now();
 // One synthetic SQL statement avoids per-statement prepare overhead. These
 // are test fixtures, not a proposed remote bulk-import transaction size.
 await db.run(`INSERT INTO guard_identities(id,user_id,company,title,url)
 WITH RECURSIVE seq(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM seq WHERE n<9999)
 SELECT 'scale-'||n,'fictional','Fictional Technologies Inc.','Senior Platform Engineer','https://jobs.ashbyhq.com/fictional/${uuid}' FROM seq`);
 const insertMs=performance.now()-started;
 const plan=await db.all('EXPLAIN QUERY PLAN SELECT * FROM guard_identity_keys WHERE id=?',['scale-5000']);
 assert.ok(plan.some(r=>/SEARCH guard_derived_keys USING PRIMARY KEY \(id=\?\)/.test(r.detail)),JSON.stringify(plan));
 const before=performance.now(),one=await row(db,'scale-5000'),singleMs=performance.now()-before;
 assert.equal(one.company_key,'fictionaltechnologies');
 const allStarted=performance.now(),all=await db.all('SELECT * FROM guard_identity_keys'),allMs=performance.now()-allStarted;
 assert.equal(all.length,10000);
 t.diagnostic(JSON.stringify({identities:10000,insert_ms:Number(insertMs.toFixed(3)),single_id_ms:Number(singleMs.toFixed(3)),all_ms:Number(allMs.toFixed(3)),query_plan:plan.map(r=>r.detail)}));
});
async function insert(db,id,company,title,url=null){await db.run('INSERT INTO guard_identities VALUES(?,?,?,?,?)',[id,'fictional',company,title,url]);}
const row = async(db,id)=>(await db.all('SELECT * FROM guard_identity_keys WHERE id=?',[id]))[0];
const uuid='12345678-1234-1234-1234-123456789abc';
const sourceMapping=JSON.parse(readFileSync(new URL('./unicode-identity-map.json',import.meta.url),'utf8'));

test('pinned mapping exhaustively covers every Unicode scalar under the declared Node Unicode version',()=>{
 assert.equal(process.versions.unicode,IDENTITY_MAPPING.unicode,'Requalify/rebuild the map before changing Unicode rules');
 const mapping=new Map(sourceMapping.rows.map(([cp,...parts])=>[cp,parts]));
 let scalars=0;
 for(let cp=1;cp<=0x10ffff;cp++){
  if(cp>=0xd800&&cp<=0xdfff)continue;
  const c=String.fromCodePoint(cp),form=c.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const expected=[form.replace(/[^a-z0-9]/g,''),[...form].map(c=>/[a-z0-9-]/.test(c)?c:/[\u2013\u2014]/.test(c)?'|':/\s/.test(c)?' ':'~').join('').replace(/~+/g,'~'),[...c.toLowerCase()].map(c=>/[a-z0-9_.]/.test(c)?c:/\s/.test(c)?' ':'~').join('')];
  assert.deepEqual(mapping.get(cp)||['','~','~'],expected,'scalar U+'+cp.toString(16));scalars++;
 }
 assert.equal(scalars,1112063);
});

for(const driver of ['native','libsql']) {
 test(`${driver}: company and title SQL normalization matches native algorithms on Unicode and suffix corpus`,async t=>{
  const db=await fixture(t,driver);
  const cases=['Acme Inc.','AcmeINC','Acme_inc','Acme-inc','Inc','Acme inc..','Acme Inc .','Acme\u00a0Corporation\uFEFF','Àcme Ltd.','A\u0301cme','Clutch Technologies','ARHS Developments LLC','PricewaterhouseCoopers Incorporated','Łódź','ẞtraße','Straße','İNC','AİNC','KInc','AKInc','ＡＣＭＥ Ｉｎｃ','𝔸𝕔𝕞𝕖','ﬃ','Ⅳ','①','㍑','한글 Engineer','Z\u1AB0','Z\u0300\u1AB0','Z\u1AB0\u0300','Senior Développeur - remote','Engineer - on-site','Engineer - Remote - EU','Engineer -- remote','Engineer - remøote','Engineer - remoté','Engineer - sponsor eligible','Engineer — remote','Engineer - ㍑remote','Engineer\u00a0-\u00a0hybrid'];
  // Every mapping entry that changes ASCII output, in mixed strings; compare
  // whole-string native normalization, not just the generated per-scalar map.
  for(const [cp,key] of sourceMapping.rows)if(key)cases.push('A'+String.fromCodePoint(cp)+'Z');
  let n=0;
  for(const value of cases){await insert(db,String(n++),value,value);}
  const rows=await db.all('SELECT * FROM guard_identity_keys');
  for(const r of rows){const value=cases[Number(r.id)];assert.equal(r.company_key,companyKey(value),value);assert.equal(r.history_title_key,historyKey(value),value);assert.equal(r.role_key,applicationRoleKey(value),value);}
  t.diagnostic(`${cases.length} whole-string Unicode/suffix identities compared to native functions`);
 });

 test(`${driver}: role annotation stripping preserves functional distinctions and exact native en/em dash semantics`,async t=>{
  const db=await fixture(t,driver);let n=0;const inputs=[];
  for(const separator of [' - ','  -  ','\u00a0-\u2003','- ',' -',' -- ',' — ',' – '])for(const suffix of ['remote','on-site','hybrid','sponsorship','relocation offered','remote - hybrid','on-site on-site','on-site remote','notremote','remøote','rémote','software'])inputs.push('Backend Engineer'+separator+suffix);
  inputs.push('Backend - Team - remote','Backend - remote - hybrid','Backend - on-site - Hybrid','Backend - remote - On-site','Backend - senior on-site - team','Backend - remote\u0300','Backend - re\u1AB0mote');
  for(const input of inputs)await insert(db,String(n++),'Fictional',input);
  for(const r of await db.all('SELECT * FROM guard_identity_keys'))assert.equal(r.role_key,applicationRoleKey(inputs[Number(r.id)]),inputs[Number(r.id)]);
  t.diagnostic(`${inputs.length} annotation variants compared`);
 });

 test(`${driver}: ATS posting, tenant aliases and canonical URLs match supported native identities`,async t=>{
  const db=await fixture(t,driver);
  const urls=[`https://jobs.ashbyhq.com/ClutchTechnologies/${uuid}`,`https://JOBS.ASHBYHQ.COM/ClutchTechnologies/${uuid.toUpperCase()}/?utm_source=x#step`,'https://boards.greenhouse.io/ARHSDevelopments/jobs/00123','https://job-boards.greenhouse.io/ARHSDevelopments/jobs/00123/application?gh_src=fictional',`https://jobs.lever.co/PricewaterhouseCoopers/${uuid}`,`https://jobs.eu.lever.co/PricewaterhouseCoopers/${uuid}?lever-source=x&lever-origin=y`,'https://example.org/careers/engineer/','https://example.org'];
  for(let i=0;i<urls.length;i++)await insert(db,String(i),'Fictional','Engineer',urls[i]);
  for(const r of await db.all('SELECT * FROM guard_identity_keys')){
   const url=urls[Number(r.id)],native=handoffIdentity({employer:'Fictional',title:'Engineer',location:'Unknown',url});assert.equal(r.valid,1,url);assert.equal(r.canonical_url,handoffURL(url),url);
   if(native.ats){assert.equal(r.tenant_key,companyKey(native.tenant),url);assert.equal(r.handoff_posting_key,`${native.ats}:${native.tenant}:${native.requisition_id}`,url);}
   else assert.equal(r.posting_key,'');
  }
  assert.equal((await row(db,'4')).handoff_posting_key,(await row(db,'5')).handoff_posting_key,'handoff treats US/EU Lever as one ATS');
  assert.notEqual((await row(db,'4')).posting_key,(await row(db,'5')).posting_key,'native sameApplication preserves Lever hostname distinction');
 });

 test(`${driver}: supported SQL repeat predicates agree with native pairwise duplicate oracle`,async t=>{
  const db=await fixture(t,driver);
  const jobs=[
   {company:'Clutch Technologies Inc',title:'Engineer - remote',url:`https://jobs.ashbyhq.com/clutch/${uuid}`},
   {company:'Different',title:'Different',url:`https://jobs.ashbyhq.com/clutch/${uuid}?utm_source=x`},
   {company:'Clutch',title:'Engineer',url:`https://jobs.ashbyhq.com/other/00000000-0000-0000-0000-000000000000`},
   {company:'Other',title:'Engineer',url:'https://example.org/jobs/one'},
   {company:'ARHS Developments LLC',title:'Développeur',url:'https://boards.greenhouse.io/arhs/jobs/123'},
   {company:'Other',title:'Other',url:'https://job-boards.greenhouse.io/arhs/jobs/123'},
   {company:'ARHS',title:'Developpeur',url:'https://example.org/jobs/two'},
   {company:'Other',title:'Developpeur',url:'https://boards.greenhouse.io/ARHSDevelopments/jobs/456'},
   {company:'Example',title:'Engineer - on-site',url:`https://jobs.lever.co/example/${uuid}`},
   {company:'Different',title:'Other',url:`https://jobs.eu.lever.co/example/${uuid}`},
   {company:'Example',title:'Engineer',url:'https://example.org/jobs/three'},
   {company:'Example',title:'Data Engineer',url:'https://example.org/jobs/three'}
  ];
  for(let i=0;i<jobs.length;i++){const j=jobs[i];await insert(db,String(i),j.company,j.title,j.url);}
  const matches=await db.all(`SELECT a.id AS aid,b.id AS bid,CASE WHEN (a.posting_key!='' AND a.posting_key=b.posting_key) OR (a.role_key!='' AND a.role_key=b.role_key AND (a.company_key=b.company_key OR (a.tenant_key!='' AND a.tenant_key IN (b.company_key,b.tenant_key)) OR (b.tenant_key!='' AND b.tenant_key=a.company_key))) THEN 1 ELSE 0 END AS matched FROM guard_identity_keys a CROSS JOIN guard_identity_keys b`);
  for(const result of matches)assert.equal(Boolean(result.matched),sameApplication(jobs[Number(result.aid)],jobs[Number(result.bid)]),`${result.aid}/${result.bid}`);
  t.diagnostic(`${matches.length} pairwise duplicate comparisons`);
 });

 test(`${driver}: unsupported identities fail closed and null historical URL remains usable`,async t=>{
  const db=await fixture(t,driver);
  const invalid=['http://example.org/x','https://user:password@example.org/x','https://example.org:443/x','https://example.org/x?query=y','https://example.org/x?token=fictional','https://example.org/%65ngineer','https://jobs.ashbyhq.com/A%20B/'+uuid,'https://éxample.org/x','https://example.org/a/../b','https://example.org//x','https://127.0.0.1/x','https://0x7f.0x0.0x0.0x1/x','https://example.123/x','https://[::1]/x','https://host.local/x','https://host.localhost/x','https://example.org/x y','https://example.org/\u0000x','https://example.org/x\\y','not a URL',''];
  for(let i=0;i<invalid.length;i++)await insert(db,String(i),'Fictional','Engineer',invalid[i]);
  for(const r of await db.all('SELECT * FROM guard_identity_keys'))assert.equal(r.valid,0,invalid[Number(r.id)]);
  await insert(db,'history','Fictional','Engineer',null);assert.equal((await row(db,'history')).valid,1);
  await insert(db,'empty','公司','工程师',null);assert.equal((await row(db,'empty')).valid,0);
  await insert(db,'control','Fictional','Engineer\u0000Other',null);assert.equal((await row(db,'control')).valid,0);
  await insert(db,'newline','Fictional','Engineer\nOther',null);assert.equal((await row(db,'newline')).valid,0);
  await insert(db,'long','A'.repeat(201),'Engineer',null);assert.equal((await row(db,'long')).valid,0);
  await insert(db,'utf16','A'+'😀'.repeat(100),'Engineer',null);assert.equal((await row(db,'utf16')).valid,0);
 });

 test(`${driver}: immutable mapping rejects direct mutations and replacement; normalized view has no writable keys`,async t=>{
  const db=await fixture(t,driver);
  for(const sql of ['UPDATE guard_unicode_map SET ascii_key=\'forged\' WHERE codepoint=65','DELETE FROM guard_unicode_map WHERE codepoint=65',"INSERT OR REPLACE INTO guard_unicode_map VALUES(65,'forged','forged','forged')","INSERT OR IGNORE INTO guard_unicode_map VALUES(65,'forged','forged','forged')","UPDATE guard_identity_version SET sha256='forged'","DELETE FROM guard_identity_version","INSERT OR REPLACE INTO guard_identity_version SELECT * FROM guard_identity_version"]){await assert.rejects(async()=>await db.run(sql),/immutable_identity_mapping/);}
  await insert(db,'one','Fictional Inc','Engineer');
  await assert.rejects(async()=>await db.run("UPDATE guard_identity_keys SET company_key='forged' WHERE id='one'"),/view/);
  assert.equal((await row(db,'one')).company_key,'fictional');
 });
}
