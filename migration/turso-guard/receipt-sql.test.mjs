import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createClient} from '@libsql/client';
import {receipt} from '../../local-policy.js';
import {applicationEvidence} from '../../operation-evidence.js';
import {receiptAcceptedSQL,receiptClassificationSQL,RECEIPT_SQL_POLICY} from './receipt-sql.mjs';

const oracle = text => applicationEvidence({confirmation:text,receipt_event:1}).confirmed;
const ws = [9,10,11,12,13,32,160,5760,...Array.from({length:11},(_,i)=>8192+i),8232,8233,8239,8287,12288,65279].map(c=>String.fromCodePoint(c));
const good = 'Your application has been received.';
const thanks = 'Thank you for applying.';
const sent = 'Your job application has been sent to Fictional Employer.';

async function fixture(t,driver) {
 const schema='CREATE TABLE receipt_fixture(id INTEGER PRIMARY KEY,receipt_text);';
 if(driver==='native') {
  const db=new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close());
  const classified=db.prepare('SELECT '+receiptClassificationSQL('?1')+' AS classification');
  return {
   classify:value=>classified.get(value).classification,
   exec:sql=>db.exec(sql),run:(sql,args=[])=>db.prepare(sql).run(...args),
   all:(sql,args=[])=>db.prepare(sql).all(...args),
  };
 }
 const client=createClient({url:':memory:',intMode:'number'});t.after(()=>client.close());await client.executeMultiple(schema);
 return {
  classify:async value=>(await client.execute({sql:'SELECT '+receiptClassificationSQL('?1')+' AS classification',args:[value]})).rows[0].classification,
  exec:sql=>client.executeMultiple(sql),run:(sql,args=[])=>client.execute({sql,args}),
  all:async(sql,args=[])=>[...(await client.execute({sql,args})).rows],
 };
}

async function differential(db,inputs,t) {
 const corpus=[...new Set(inputs)];
 const start=performance.now();
 // Exercise one bound receipt per call, as the write trigger does. A bulk
 // correlated SELECT is a different SQLite query plan and is not the API.
 for(const text of corpus) {
  const classification=await db.classify(text);
  assert(Buffer.byteLength(text)<=RECEIPT_SQL_POLICY.maxBytes&&!text.includes('\0'));
  assert.equal(classification==='accepted',oracle(text),JSON.stringify({text,classification,nativeReceipt:receipt(text)}));
 }
 t.diagnostic(`${corpus.length} bounded inputs compared with native applicationEvidence; SQL ${Math.round(performance.now()-start)} ms`);
}

test('installer accepts only trusted identifiers/numbered bindings; policy bound is explicit',()=>{
 assert.equal(RECEIPT_SQL_POLICY.maxBytes,8192);
 for(const unsafe of ['?',"NEW.receipt_text) OR 1=1--",'validated=1','(SELECT 1)','receipt text','receipt;DROP TABLE guard_receipts','',null,{},"'Your application has been received.'"])
  assert.throws(()=>receiptAcceptedSQL(unsafe),/trusted_receipt_sql_reference_required/);
 for(const valid of ['NEW.receipt_text','receipt_text','input.receipt_text','?1'])assert.equal(typeof receiptAcceptedSQL(valid),'string');
});

test('non-Unicode native case folding and word boundaries have no hidden non-ASCII Latin aliases',()=>{
 // Native receipt regexes are /i, not /iu. Long s/Kelvin sign must not become
 // ASCII letters merely because another identity normalizer uses NFKD.
 const ascii=/^[a-z]$/i;let extra=0;const whitespace=[];
 for(let cp=1;cp<=0x10ffff;cp++)if(!(cp>=0xd800&&cp<=0xdfff)){
  const c=String.fromCodePoint(cp);
  if(cp>=128&&ascii.test(c))extra++;
  if(/\s/.test(c))whitespace.push(c);
 }
 assert.equal(extra,0);
 assert.deepEqual(whitespace,ws,'full Unicode scalar sweep pins the whitespace inventory');
 assert.equal(oracle('Your application has been ſubmitted.'),false);
});

test('native receipt and placeholder policy changes require explicit SQL-port review',()=>{
 const hash=value=>createHash('sha256').update(value.replaceAll('\r\n','\n')).digest('hex');
 assert.equal(hash(receipt.toString()),'12a80353446035ded201a2f9754a038ca0aacf906397038747b0b3e43c43fdfe','review native receipt change before updating this fingerprint');
 assert.equal(hash(applicationEvidence.toString().match(/const placeholder=(.+);/)[1]),'cd58a25471f3d100b3eaf8e5fd9f4fd1cfd4e7ba96c1ebf7452bde65a95516f3','review native placeholder change before updating this fingerprint');
});

for(const driver of ['native','libsql']) {
 test(`${driver}: every affirmative grammar variant, prefix and word boundary agrees with native`,async t=>{
  const db=await fixture(t,driver),phrases=[];
  for(const person of ['','your '])for(const tense of ['','has been ','was '])for(const adverb of ['','successfully '])for(const outcome of ['submitted','received'])phrases.push(`${person}application ${tense}${adverb}${outcome}`);
  for(const thank of ['thanks','thank you'])for(const object of ['applying','your application'])phrases.push(`${thank} for ${object}`);
  const corpus=[];
  for(const phrase of phrases)for(const prefix of ['','Applicant verified: ','Browser extension observed:\t'])for(const tail of ['','.','!','?','; no further action is needed.',' successfully.','X','_suffix','0','é','😀'])corpus.push(prefix+phrase+tail);
  for(const text of [good,thanks,sent])for(const form of [s=>s,s=>s.toUpperCase(),s=>s.replace(/[A-Za-z]/g,(c,i)=>i%2?c.toUpperCase():c.toLowerCase())])corpus.push(form(text));
  corpus.push('Your application has been received. Do not reply to this email.','Your application has been received. You do not need to reapply.','Once your application has been received, we will email you.','The next page will say "Thank you for applying".','Please submit your application','"Your application has been received."','Your application received an error.','Your application received a error.');
  await differential(db,corpus,t);
 });

 test(`${driver}: failures, adjacent pronouns, sentence boundaries and unrelated footers match native`,async t=>{
  const db=await fixture(t,driver),failures=[];
  for(const job of ['','job '])for(const tense of ['','was '])for(const verb of ['received','submitted'])failures.push(`no ${job}application ${tense}${verb}`);
  for(const negation of ['not','never'])for(const tense of ['','been '])for(const verb of ['submitted','received','processed','sent','delivered','accepted'])failures.push(`${negation} ${tense}${verb}`);
  for(const unable of ["couldn't",'couldn’t','could not','cannot',"can't",'can’t','unable to','failed to'])for(const be of ['','be '])for(const verb of ['submit','submitted','receive','received','process','processed','send','sent','deliver','delivered','accept','accepted'])failures.push(`${unable} ${be}${verb}`);
  for(const noun of ['submission','delivery'])for(const outcome of ['failed','has failed','had failed','was unsuccessful'])failures.push(`${noun} ${outcome}`);
  failures.push('unsuccessful','a error occurred','an error occurred','with error','with errors','pending','awaiting','queued');
  const corpus=[];
  for(const fail of failures)for(const text of [
   `${thanks} Your application ${fail}.`,`${good} It ${fail}.`,`${thanks} It ${fail}.`,
   `${good} The unrelated account is ${fail}.`,`${good} Your application x${fail}x.`,
   `${good} Your application _${fail}_.`,`${good} Your application é${fail}😀.`,
   `Application received ${fail}.`,`${good}\n\nIt ${fail}.`,
  ])corpus.push(text);
  for(const separator of ['. ','.\n','.\r\n','!\t','?\v','. \n \n','.\n \n','.\r\n\t','.\u00a0','.\u2028','.\u2029','.\uFEFF','.',': ','\n','\r\r\n','\n\n'])
   for(const previous of ['Your application has been received','Thank you for applying','Your application has been received. Independent paragraph'])
    for(const next of ['It could not be processed.','Your application is pending.','Delivery failed.','It was unsuccessful.','Itinerary pending.','Do not reply to this email.'])corpus.push(previous+separator+next);
  corpus.push(good+' Submission has  failed.',good+' Your application couldn‘t be received.',good+' Your application could not have been received.',good+' Your application could\tnot be received.',good+' no application submittedX.');
  await differential(db,corpus,t);
 });

 test(`${driver}: spam, quota and placeholder vetoes override polite confirmation anywhere`,async t=>{
  const db=await fixture(t,driver),corpus=[];
  const vetoes=['reached your application limit','application limit reached','application limit has been reached',"couldn't submit your application",'couldn’t submit your application','could not submit your application','placeholder','example.com','github.com','not submitted','not yet submitted','not confirmed','not yet confirmed','unconfirmed','simulation','simulated','test receipt'];
  for(const veto of vetoes)for(const form of [s=>s,s=>s.toUpperCase()])for(const text of [good+' '+veto,`${veto}\n${good}`,`${thanks}\nNote: ${veto}.`,sent+'\n'+veto,good+' x'+veto+'x'])corpus.push(form(text));
  for(const prefix of ['',' ','\t','\n','\u00a0','Applicant verified: ','Browser extension observed: '])for(const suffix of ['.','!','x','_suffix','é'])corpus.push(good+'\n'+prefix+'Your application submission was flagged as possible spam'+suffix);
  for(const text of [good+' quota remains available.',good+' reached\tyour application limit',good+' application limit has  been reached',good+' exampleXcom',good+' test\treceipt',good+' This is notconfirmed',good+' This is non-simulated data.'])corpus.push(text);
  await differential(db,corpus,t);
  assert.equal(receipt(good+' placeholder')!== '',true,'receipt alone is insufficient');
  assert.equal(await db.classify(good+' placeholder'),'rejected_placeholder');
  assert.equal(await db.classify(good+'\nYour application submission was flagged as possible spam.'),'rejected_spam');
 });

 test(`${driver}: Unicode whitespace and case lookalikes preserve exact native semantics`,async t=>{
  const db=await fixture(t,driver),corpus=[];
  for(const space of [...ws,'\u0085','\u180e','\u200b','\u2060'])for(const text of [
   space+good+space,'Applicant verified:'+space+good,'Browser extension observed:'+space+thanks,
   'Your application has been received.'+space+'It could not be received.',
   space+sent,'Applicant verified:'+space+sent,good+'\n'+space+'Your application submission was flagged as possible spam.',
  ])corpus.push(text);
  for(const nonASCII of ['ſ','K','İ','ı','Ａ','😀','é','\u0301'])for(const text of [good+nonASCII+' pending',good+'\nYour application '+nonASCII+'pending'+nonASCII+'.',nonASCII+good,good+' '+nonASCII+'No application received.'])corpus.push(text);
  await differential(db,corpus,t);
 });

 test(`${driver}: sent-to receipts use physical lines, first matching candidate and UTF-16 employer lengths`,async t=>{
  const db=await fixture(t,driver),corpus=[];
  const employers=['A','AB','A'.repeat(100),'A'.repeat(101),'😀','😀'.repeat(50),'😀'.repeat(51),'A😀','é'.repeat(100),'Fictional Employer','No','not','Nottingham','awaiting','failed','pending','Pendingham','queued','Acme, pending submission','  ','\t\t','Acme.Example','Acme!Example','Acme?Example'];
  for(const employer of employers)for(const punctuation of ['.','!','?','', '.X','.\t'])for(const prefix of ['','Applicant verified: ','Browser extension observed: '])corpus.push(prefix+'Your job application has been sent to '+employer+punctuation);
  for(const before of ['','\n','\r\n','job application confirmation\n','Different sentence. ','Different sentence.\t','Different sentence.\n','Once you submit, ','The page will say "','\t\n\u00a0'])for(const after of ['',' Reference: fictional','\nReference: fictional','X','\u200b'])corpus.push(before+sent+after);
  corpus.push('Your job application has been sent to Not Employer.\n'+sent,sent+'\nYour job application has been sent to Not Employer.',thanks+'\nYour job application has been sent to Not Employer.','Applicant verified:  '+sent,'Applicant verified:\t'+sent,good+'\n'+sent+' Delivery failed.');
  await differential(db,corpus,t);
 });

 test(`${driver}: bounds/type/NUL fail closed; late contradictions must be checked before truncation`,async t=>{
  const db=await fixture(t,driver);
  const within=good+' '.repeat(RECEIPT_SQL_POLICY.maxBytes-Buffer.byteLength(good));
  assert.equal(await db.classify(within),'accepted');
  assert.equal(await db.classify(within+' '),'unsupported_length');
  assert.equal(await db.classify(good+'é'.repeat(4096)),'unsupported_length');
  for(const value of [null,1,new Uint8Array(Buffer.from(good))])assert.equal(await db.classify(value),'unsupported_non_text');
  assert.equal(await db.classify(good+'\0Your application could not be submitted.'),'unsupported_nul');
  const late=[good+' '.repeat(350)+'Your application could not be submitted.',good+' '.repeat(350)+'placeholder',good+' '.repeat(350)+'\nYour application submission was flagged as possible spam.'];
  for(const text of late){assert(oracle(text.slice(0,300)));assert(!oracle(text));assert.equal(await db.classify(text)==='accepted',false);}
  assert.equal(applicationEvidence({confirmation:good,receipt_event:0}).confirmed,false,'durable recorded event remains an independent requirement');
 });

 test(`${driver}: raw SQL cannot smuggle malformed UTF-8 through a TEXT cast`,async t=>{
  const db=await fixture(t,driver);
  for(const invalid of ['80','c080','eda080','f4908080','ff','e08080','f0808080','c2','e282','f09080']) {
   const sql='WITH input(receipt_text) AS(SELECT ?1||CAST(?2 AS TEXT)) SELECT '+receiptClassificationSQL('input.receipt_text')+' AS classification FROM input';
   const result=(await db.all(sql,[good,Buffer.from(invalid,'hex')]))[0];
   assert.equal(result.classification,'unsupported_utf8',invalid);
  }
  for(const scalar of ['\uFFFD','\u0080','\uFFFE','\uFFFF','\u{10FFFF}','😀'])assert.equal(await db.classify(good+scalar),'accepted','valid Unicode is not malformed UTF-8: U+'+scalar.codePointAt(0).toString(16));
 });

 test(`${driver}: full scalar sweep verifies the only unicode()/char() roundtrip exceptions`,async t=>{
  const db=await fixture(t,driver);
  const rows=await db.all(`WITH RECURSIVE scalar(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM scalar WHERE n<1114111)
   SELECT n FROM scalar WHERE n NOT BETWEEN 55296 AND 57343 AND unicode(char(n))!=n`);
  assert.deepEqual(rows.map(r=>r.n),[65534,65535]);
 });

 test(`${driver}: raw direct INSERT and caller flags cannot bypass SQL, with both recursive trigger settings`,async t=>{
  const db=await fixture(t,driver);
  await db.exec(`CREATE TABLE protected_receipts(id INTEGER PRIMARY KEY,receipt_text,validated,classification);
   CREATE TRIGGER receipt_guard BEFORE INSERT ON protected_receipts BEGIN
    SELECT CASE WHEN NOT ${receiptAcceptedSQL('NEW.receipt_text')} THEN RAISE(ABORT,'unsupported_receipt_text') END;
   END;`);
  for(const recursive of [0,1]) {
   await db.exec('PRAGMA recursive_triggers='+recursive);
   for(const text of [null,1,'Your application has not been submitted.',good+'\nApplication limit reached.',good+' '.repeat(400)+'Your application could not be submitted.',"'); DROP TABLE protected_receipts; --",'{"validated":true,"classification":"accepted","receipt":"'+good+'"}']) {
    await assert.rejects(async()=>await db.run('INSERT INTO protected_receipts(receipt_text,validated,classification) VALUES(?,1,?)',[text,'accepted']),/unsupported_receipt_text/);
   }
   await db.run('INSERT INTO protected_receipts(receipt_text,validated,classification) VALUES(?,0,?)',[good,'rejected']);
   // Bound malicious-looking bytes remain data; the native tail grammar allows
   // arbitrary text after a valid opening, but no SQL statement can execute it.
   await db.run('INSERT INTO protected_receipts(receipt_text) VALUES(?)',[good+"'); DROP TABLE protected_receipts; --"]);
  }
  assert.equal((await db.all('SELECT COUNT(*) n FROM protected_receipts'))[0].n,4);
 });

 test(`${driver}: deterministic adversarial sentence mixtures agree with the native oracle`,async t=>{
  const db=await fixture(t,driver),corpus=[];
  const clauses=[good,thanks,sent,'Application submitted successfully.','Your application was received with errors.','No application received.','It could not be processed.','Your application is queued.','We have your application.','Unrelated footer pending.','Please do not reply.','Your application submission was flagged as possible spam.','placeholder','Your application has not been submitted.','The page will say "Thank you for applying".','Application received an error.','It was unsuccessful.','Application received_pending.','Your job application has been sent to Not Company.'];
  const separators=[' ','\n','\n \n','\r\n','\t','\u00a0','\u2028',''];
  let seed=0x312884a;
  const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return Math.floor(seed/4294967296*n);};
  for(let i=0;i<1400;i++){let value=clauses[random(clauses.length)];for(let j=0,n=random(4);j<n;j++)value+=separators[random(separators.length)]+clauses[random(clauses.length)];corpus.push(value);}
  await differential(db,corpus,t);
 });

 test(`${driver}: maximum-size single-receipt validation stays bounded for long text and many sentences`,async t=>{
  const db=await fixture(t,driver);
  for(const text of [good+' '.repeat(RECEIPT_SQL_POLICY.maxBytes-good.length),good+'\nx\n'.repeat(2500),good+'\nx\n'.repeat(2500)+'Your application could not be processed.']) {
   const start=performance.now();const actual=await db.classify(text);const ms=performance.now()-start;
   assert.equal(actual==='accepted',oracle(text));
   t.diagnostic(`${Buffer.byteLength(text)} bytes / ${text.split('\n').length} physical lines: ${ms.toFixed(1)} ms`);
  }
 });
}
