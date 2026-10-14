import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createClient} from '@libsql/client';
import {sameApplication} from '../../local-policy.js';
import {receiptQuerySQL} from './receipt-url-sql.mjs';
import {installGuardSchema} from './guard-schema.mjs';
import {createLibsqlDatabase} from '../../database/libsql.js';
import {claimCandidate,recordReceipt} from './guard-repository.mjs';

const base='https://jobs.lever.co/fictional/11111111-1111-1111-1111-111111111111';
const queries=['','?utm_source=a','?utm_SOURCE=b#fragment','?gh_src=one','?lever-source=a','?lever-source=b','?lever-origin=a','?lever-source=a&utm_source=b','?utm_source=z&lever-source=a','?lever-source=a&lever-origin=b','?lever-origin=b&lever-source=a','?lever-source=a&lever-source=b','?lever-source=b&lever-source=a','?Lever-source=a','?lever-source=a+z'];
for(const driver of ['native','libsql'])test(`${driver}: receipt query comparison preserves native retained keys and duplicate ordering`,async t=>{
 let one;
 if(driver==='native'){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());one=(sql,args)=>db.prepare(sql).get(...args);
 }else{
  const db=createClient({url:':memory:',intMode:'number'});t.after(()=>db.close());one=async(sql,args)=>(await db.execute({sql,args})).rows[0];
 }
 const sql=`SELECT ${receiptQuerySQL('a.url')}=${receiptQuerySQL('b.url')} AS same FROM (SELECT ? AS url) a CROSS JOIN (SELECT ? AS url) b`;
 for(const left of queries)for(const right of queries){
  const a=base+left,b=base+right,got=await one(sql,[a,b]);assert.equal(Boolean(got.same),sameApplication(a,b),JSON.stringify([left,right]));
 }
 t.diagnostic(`${queries.length**2} retained-query pairs checked against native strict receipt identity`);
});

test('raw receipt SQL cannot use handoff tracking removal to bypass native attribution',async t=>{
 const raw=createClient({url:':memory:',intMode:'number'});await raw.execute('PRAGMA foreign_keys=ON');await installGuardSchema(raw);await raw.execute("INSERT INTO guard_accounts VALUES('u',0)");
 const db=createLibsqlDatabase(raw);t.after(()=>db.close());
 const claim=await claimCandidate(db,{userId:'u',requestId:'query-request',applicantId:'p',owner:'browser',company:'Fictional',title:'Engineer',url:base+'?lever-source=original',kind:'submission'});
 const now=new Date().toISOString();
 await raw.execute({sql:'INSERT INTO guard_identities VALUES(?,?,?,?,?)',args:['receipt-url','u','Fictional','Engineer',base+'?lever-source=different']});
 await assert.rejects(raw.execute({sql:'INSERT INTO guard_receipts VALUES(?,?,?,?,?,?,?,?)',args:[claim.claimId,'u','browser','receipt-url',null,'Your application has been received.',now,now]}),/unattributable_receipt/);
 assert.equal((await raw.execute('SELECT COUNT(*) n FROM guard_receipts')).rows[0].n,0);
 await recordReceipt(db,{userId:'u',claimId:claim.claimId,owner:'browser',afterSubmit:true,url:base+'?utm_source=ignored&lever-source=original',receipt:'Your application has been received.'});
 assert.equal((await raw.execute('SELECT COUNT(*) n FROM guard_receipts')).rows[0].n,1);
});

test('receipt query generator accepts only fixed qualified column names',()=>{
 for(const input of ['?', 'url; DROP TABLE x', 'x.url OR 1=1', "x.'url'", 'url'])assert.throws(()=>receiptQuerySQL(input),/trusted_receipt_url_column_required/);
});
