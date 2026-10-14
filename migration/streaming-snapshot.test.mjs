import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectDatabase,createRecoverySnapshot,verifyRecoverySnapshot,hashFile} from './state-snapshot.mjs';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'applypilot-streaming-fixture-')),source=join(root,'source.sqlite'),bundle=join(root,'recovery');
 const db=new DatabaseSync(source);db.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0');
 t.after(()=>{db.close();const boundary=relative(resolve(tmpdir()),resolve(root));assert.ok(boundary&&!boundary.startsWith('..'));rmSync(root,{recursive:true,force:true});});
 return {root,source,bundle,db};
}
const encode=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?{integer:String(v)}:v instanceof Uint8Array?{blob:Buffer.from(v).toString('hex')}:v);
const hash=value=>createHash('sha256').update(value).digest('hex');

test('streaming row hashes exactly match legacy format1 across duplicate rows, chunks, blobs and Unicode',t=>{
 const {db,source,root}=fixture(t);
 db.exec('CREATE TABLE data(big INTEGER,txt TEXT,raw BLOB,nul TEXT,r REAL)');
 const text='A'.repeat(32767)+'😀'+('\\\"\n\t\u0000é'.repeat(16000));
 const blob=Buffer.alloc(131073);for(let i=0;i<blob.length;i++)blob[i]=i%251;
 const insert=db.prepare('INSERT INTO data VALUES(?,?,?,?,?)');
 insert.run(9223372036854775807n,text,blob,null,0.125);insert.run(9223372036854775807n,text,blob,null,0.125);insert.run(-9223372036854775808n,'',Buffer.alloc(0),null,-0);
 const legacy=db.prepare('SELECT * FROM data');legacy.setReadBigInts(true);
 const rows=legacy.all().map(row=>hash(encode(Object.keys(row).sort().map(key=>[key,row[key]])))).sort();
 assert.deepEqual(inspectDatabase(source).tables.data,{rows:3,digest:hash(encode(rows))});
 assert.deepEqual(readdirSync(root).filter(name=>name.startsWith('.applypilot-hashes-')),[]);
 const file=join(root,'large.pdf');writeFileSync(file,blob);assert.equal(hashFile(file),hash(blob));
});

test('recovery checkpoint snapshots active WAL, retains uncertain evidence, and makes no freeze/upload claim',async t=>{
 const {db,source,bundle}=fixture(t);
 db.exec("CREATE TABLE attempts(id TEXT PRIMARY KEY,phase TEXT,receipt TEXT);INSERT INTO attempts VALUES('fictional','uncertain',NULL)");
 assert.ok(existsSync(source+'-wal'));
 const result=await createRecoverySnapshot(source,bundle);
 assert.equal(result.kind,'sqlite-recovery');assert.equal(result.uploads_included,false);assert.equal(result.external_workflows_frozen,false);
 const m=await verifyRecoverySnapshot(bundle);assert.ok(m.database_started_at<=m.database_completed_at);
 db.exec("INSERT INTO attempts VALUES('after-checkpoint','uncertain',NULL)");
 const copy=new DatabaseSync(join(bundle,'database.sqlite'),{readOnly:true});
 try{assert.equal(copy.prepare('SELECT COUNT(*) n FROM attempts').get().n,1);assert.equal(copy.prepare('SELECT receipt FROM attempts').get().receipt,null);}finally{copy.close();}
 assert.equal((await verifyRecoverySnapshot(bundle)).database.tables.attempts.rows,1);
 assert.ok(!existsSync(join(bundle,'resumes')));
});

test('recovery snapshot leaves INCOMPLETE on integrity failure and never overwrites a destination',async t=>{
 const {db,source,bundle}=fixture(t);
 db.exec('PRAGMA foreign_keys=OFF;CREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE child(p INTEGER REFERENCES parent(id));INSERT INTO child VALUES(9)');
 await assert.rejects(createRecoverySnapshot(source,bundle),/foreign_key_check_failed/);
 assert.ok(existsSync(join(bundle,'INCOMPLETE')));await assert.rejects(verifyRecoverySnapshot(bundle),/incomplete_snapshot/);
 await assert.rejects(createRecoverySnapshot(source,bundle),/destination_already_exists/);
});

test('online backup remains transactionally consistent while an independent connection writes',async t=>{
 const {db,source,bundle}=fixture(t);
 db.exec('CREATE TABLE pair(id INTEGER PRIMARY KEY,n INTEGER);INSERT INTO pair VALUES(1,0),(2,0);CREATE TABLE payload(bytes BLOB);INSERT INTO payload VALUES(zeroblob(6500000))');
 const writer=new DatabaseSync(source);let writes=0,writeError;
 const timer=setInterval(()=>{
  try{writer.exec('BEGIN IMMEDIATE;UPDATE pair SET n=n+1;COMMIT');writes++;if(writes>=5)clearInterval(timer);}
  catch(error){writeError=error;clearInterval(timer);}
 },1);
 try{
  await createRecoverySnapshot(source,bundle);assert.ifError(writeError);assert(writes>0,'fixture must actually write during backup');
  const copy=new DatabaseSync(join(bundle,'database.sqlite'),{readOnly:true});
  try{const rows=copy.prepare('SELECT n FROM pair ORDER BY id').all();assert.equal(rows[0].n,rows[1].n);assert(rows[0].n>=0&&rows[0].n<=writes);}finally{copy.close();}
  await verifyRecoverySnapshot(bundle);
 }finally{clearInterval(timer);writer.close();}
});
