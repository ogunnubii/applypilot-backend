import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {normalizeSearchScope,scopeIntent,currentSearchScope,searchScopeSignature} from '../search-scope.js';
import {jobIntelligence} from '../job-intelligence.js';
import {supportIntent,remoteCanadaIntent,t4FallbackIntent} from '../support-career.js';
import {worldwideTechIntent} from '../tech-search.js';

const source=readFileSync(new URL('../discovery.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('const placeWords='),source.indexOf('export const SEARCH_INTERVAL_SECONDS')).replace(/export /g,'');
const resolve=new Function('normalizeSearchScope','scopeIntent','supportIntent','remoteCanadaIntent','t4FallbackIntent','worldwideTechIntent',code+';return searchIntentForApplicant;')(normalizeSearchScope,scopeIntent,supportIntent,remoteCanadaIntent,t4FallbackIntent,worldwideTechIntent);
const scope=normalizeSearchScope({roles:['DevOps Engineer','Platform Engineer'],localPlaces:[],remotePlaces:['Canada'],remoteWorldwide:true,remoteFromCountry:'canada',authorizedCountries:['canada'],preferBusinessContract:true,allowEmploymentFallback:true,preferRemote:true});
const search={instruction:'DevOps Engineer, Platform Engineer; remote Canada',scope_json:null};
const applicant={id:'p',focus:'DevOps Engineer'};
const posting={title:'DevOps Engineer',remote:true,location:'Remote - US; Remote - Canada',employmentType:'Full time',description:'Full time cloud infrastructure role available remotely in Canada.'};

test('supplemental discovery uses the configured applicant scope and campaign signature',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE searches(id,user_id,applicant_id,enabled,scope_json,created_at)');
 const insert=db.prepare('INSERT INTO searches VALUES(?,?,?,?,?,?)');
 insert.run('main','u','p',1,JSON.stringify(scope),'2026-01-01');
 insert.run('supplement','u','p',1,null,'2026-01-02');
 insert.run('other-user','other','p',1,JSON.stringify({...scope,allowEmploymentFallback:false}),'2026-01-03');
 insert.run('other-applicant','u','other',1,JSON.stringify({...scope,allowEmploymentFallback:false}),'2026-01-04');
 insert.run('disabled','u','p',0,JSON.stringify({...scope,allowEmploymentFallback:false}),'2026-01-05');
 const original=JSON.stringify({search,applicant});
 const legacy=jobIntelligence(posting,resolve(search,applicant).intent);
 assert.equal(legacy.eligibility.eligible,false);
 const result=resolve(search,applicant,currentSearchScope(db,{user_id:'u',applicant_id:'p'}));
 const metadata=jobIntelligence(posting,result.intent);
 assert.equal(metadata.eligibility.eligible,true);
 assert.equal(metadata.eligibility.kind,'canada-employment-fallback');
 assert.equal(metadata.searchScopeSignature,searchScopeSignature(scope));
 assert.equal(metadata.strong,true);
 assert.equal(JSON.stringify({search,applicant}),original);
 assert.match(source,/searchIntentForApplicant\(search,applicant,currentSearchScope\(db,\{user_id:userId,applicant_id:applicant.id\}\)\)/);
 db.close();
});

test('explicit search scope and eligibility restrictions still take precedence',()=>{
 const explicit={...search,scope_json:JSON.stringify({...scope,allowEmploymentFallback:false})};
 assert.equal(jobIntelligence(posting,resolve(explicit,applicant,scope).intent).eligibility.eligible,false);
 const intent=resolve(search,applicant,scope).intent;
 for(const data of [
  {...posting,location:'Remote - US'},
  {...posting,description:'Must be authorized to work in the United States.'},
  {...posting,remote:false,location:'New York'},
 ])assert.equal(jobIntelligence(data,intent).eligibility.eligible,false);
 assert.equal(jobIntelligence(posting,resolve(search,applicant,{...scope,authorizedCountries:[]}).intent).eligibility.eligible,false);
 assert.equal(resolve(search,applicant).intent.scope,undefined);
});

test('metadata enrichment refreshes a mismatched scope before daily expiry without resetting attempts',async()=>{
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE jobs(id,user_id,applicant_id,title,status,metadata_attempt_at,created_at,job_metadata_json,attempts,local_attempt_at)');
 const fresh=new Date().toISOString(),old=new Date(Date.now()-20*60000).toISOString(),signature=searchScopeSignature(scope);
 const add=(id,{user='u',status='needs_review',sig='old-scope',last=old,attempts=0,attempt=null}={})=>db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,user,'p',posting.title,status,last,old,JSON.stringify({available:true,checkedAt:fresh,searchScopeSignature:sig}),attempts,attempt);
 add('mismatch');add('matching',{sig:signature});add('cooldown',{last:fresh});add('other',{user:'other'});add('archived',{status:'archived'});add('attempted',{attempts:3,attempt:'2026-01-01'});
 const part=source.slice(source.indexOf('async function refreshTrackedJobs'),source.indexOf('async function executeSearch'));
 const seen=[];
 const refresh=new Function('db','searchScopeSignature','detailForJob','saveMetadata','jobIntelligence','now',part+';return refreshTrackedJobs;')(db,searchScopeSignature,async row=>{seen.push(row.id);return posting;},(id,m)=>db.prepare('UPDATE jobs SET job_metadata_json=? WHERE id=?').run(JSON.stringify(m),id),jobIntelligence,()=>new Date().toISOString());
 const before=db.prepare("SELECT attempts,local_attempt_at,status FROM jobs WHERE id='attempted'").get();
 const result=await refresh('u',applicant,scopeIntent(scope));assert.equal(result.refreshed,2);assert.deepEqual(seen.sort(),['attempted','mismatch']);
 assert.equal(JSON.parse(db.prepare("SELECT job_metadata_json FROM jobs WHERE id='mismatch'").get().job_metadata_json).searchScopeSignature,signature);
 assert.deepEqual(db.prepare("SELECT attempts,local_attempt_at,status FROM jobs WHERE id='attempted'").get(),before);
 assert.equal((await refresh('u',applicant,scopeIntent(scope))).refreshed,0);db.close();
});
