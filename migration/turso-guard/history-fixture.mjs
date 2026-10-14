import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {HISTORY_SOURCE_INVENTORY,importNativeHistory} from './history-import.mjs';
import {hashFile,inspectDatabase} from '../state-snapshot.mjs';

// TEST ONLY. Use the real verified importer, even for an empty synthetic source.
// No fake completion records, disabled gates, live source or credentials.
let source;
function emptySource(){
 if(source)return source;
 const root=process.env.APPLYPILOT_ASYNC_TEST_ROOT,inside=root&&relative(resolve(tmpdir()),resolve(root));
 if(!inside||inside.startsWith('..'))throw Error('Run via checks/run-async-tests.mjs');
 const databasePath=join(mkdtempSync(join(root,'empty-history-')),'source.sqlite'),db=new DatabaseSync(databasePath);
 const quote=s=>'"'+s.replaceAll('"','""')+'"';
 for(const {table,columns} of HISTORY_SOURCE_INVENTORY)db.exec(`CREATE TABLE ${quote(table)}(${columns.map(c=>quote(c)+' TEXT').join(',')})`);
 db.exec("INSERT INTO users VALUES('u'),('other'),('foreign')");db.close();
 source={databasePath,manifest:{format:1,complete:true,created_at:'2026-10-13T12:00:00.000Z',database_completed_at:'2026-10-13T12:00:00.000Z',database_sha256:hashFile(databasePath),database:inspectDatabase(databasePath)}};
 return source;
}
export async function importEmptyFixtureHistory(client,userId='u'){
 return importNativeHistory({client,...emptySource(),userId});
}

// Trusted bootstrap for the synthetic HTTP protocol engine, before counting
// runtime requests. Subsequent claims still use the official HTTP client.
export function nativeFixtureInstaller(engine){
 return {async transaction(){
  engine.exec('BEGIN IMMEDIATE');let closed=false;
  return {get closed(){return closed;},
   async execute(input){const {sql,args=[]}=typeof input==='string'?{sql:input}:input,stmt=engine.prepare(sql),columns=stmt.columns().map(c=>c.name);return columns.length?{rows:stmt.all(...args)}:{...stmt.run(...args),rows:[]};},
   async executeMultiple(sql){engine.exec(sql);},
   async commit(){engine.exec('COMMIT');closed=true;},async rollback(){if(engine.isTransaction)engine.exec('ROLLBACK');closed=true;},close(){if(engine.isTransaction)engine.exec('ROLLBACK');closed=true;}
  };
 }};
}
