import {importEmptyFixtureHistory,nativeFixtureInstaller} from './history-fixture.mjs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createClient} from '@libsql/client/http';
import {createLibsqlDatabase} from '../../database/libsql.js';
import {GUARD_SCHEMA_SQL} from './guard-schema.mjs';

// Synthetic Hrana v2 JSON pipeline fixture for the pinned official HTTP driver.
// fetch is completely replaced: no network sockets, Turso service, credentials,
// or application data. This exercises protocol/client integration, not service
// behavior or production latency. Bootstrap uses the actual guard DDL; runtime
// statements go through the official HTTP driver and shared async adapter.
export async function guardHttpFixture(t) {
 const engine=new DatabaseSync(':memory:');
 engine.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=OFF;'+GUARD_SCHEMA_SQL);
 engine.exec("INSERT INTO guard_accounts VALUES('u',0),('other',0)");await importEmptyFixtureHistory(nativeFixtureInstaller(engine));await importEmptyFixtureHistory(nativeFixtureInstaller(engine),'other');
 const sessions=new Map(),connections=[];
 const counts={requests:0,begin:0,commit:0,rollback:0,claims:0,receipts:0,expired:0,droppedCommitResponses:0};
 let sequence=0,activeBaton=null,dropCommit=false,expirePattern=null;
 const syntheticError=(message,code='SQLITE_ERROR')=>Object.assign(Error(message),{code});
 const encode=value=>{
  if(value===null)return {type:'null'};
  if(typeof value==='bigint'||Number.isInteger(value))return {type:'integer',value:String(value)};
  if(typeof value==='number')return {type:'float',value};
  if(ArrayBuffer.isView(value))return {type:'blob',base64:Buffer.from(value.buffer,value.byteOffset,value.byteLength).toString('base64')};
  return {type:'text',value};
 };
 const decode=value=>{
  if(value.type==='null')return null;
  if(value.type==='integer')return BigInt(value.value);
  if(value.type==='float'||value.type==='text')return value.value;
  if(value.type==='blob')return Buffer.from(value.base64,'base64');
  throw syntheticError('unsupported_fixture_value');
 };
 function execute(context,stmt) {
  if(context.closed||context.expired)throw syntheticError('synthetic_transaction_expired','TRANSACTION_CLOSED');
  const sql=stmt.sql??context.statements.get(stmt.sql_id);
  assert.equal(typeof sql,'string','SQL cache entry must exist');
  assert.equal((stmt.named_args||[]).length,0,'only observed positional protocol subset is modeled');
  const normalized=sql.trim(),isBegin=/^BEGIN\b/i.test(normalized),isCommit=/^COMMIT\b/i.test(normalized),isRollback=/^ROLLBACK\b/i.test(normalized);
  if(activeBaton&&activeBaton!==context.baton)throw syntheticError('synthetic_fixture_connection_busy','SQLITE_BUSY');
  const statement=engine.prepare(normalized==='BEGIN TRANSACTION READONLY'?'BEGIN':sql);
  statement.setReadBigInts(true);
  const columns=statement.columns().map(column=>column.name),args=(stmt.args||[]).map(decode);
  let result;
  if(columns.length)result={cols:columns.map(name=>({name})),rows:statement.all(...args).map(row=>columns.map(column=>encode(row[column]))),affected_row_count:0,last_insert_rowid:null};
  else {
   const changed=statement.run(...args);
   result={cols:[],rows:[],affected_row_count:Number(changed.changes),last_insert_rowid:String(changed.lastInsertRowid)};
  }
  if(isBegin){counts.begin++;activeBaton=context.baton;}
  if(isCommit){counts.commit++;activeBaton=null;}
  if(isRollback){counts.rollback++;activeBaton=null;}
  if(/^INSERT INTO guard_claims\b/i.test(normalized))counts.claims++;
  if(/^INSERT INTO guard_receipts\b/i.test(normalized))counts.receipts++;
  // Expire after the real statement and its triggers ran, so rollback must
  // remove every affected row, not merely reject a statement before mutation.
  if(expirePattern?.test(normalized)){
   expirePattern=null;
   assert(engine.isTransaction,'expiration must occur inside an explicit transaction');
   engine.exec('ROLLBACK');activeBaton=null;context.expired=true;counts.expired++;
   throw syntheticError('synthetic_transaction_expired','TRANSACTION_CLOSED');
  }
  return result;
 }
 function conditionMatches(condition,results,errors) {
  if(!condition)return true;
  switch(condition.type){
   case 'ok':return results[condition.step]!==null&&results[condition.step]!==undefined;
   case 'error':return errors[condition.step]!==null&&errors[condition.step]!==undefined;
   case 'not':return !conditionMatches(condition.cond,results,errors);
   case 'and':return condition.conds.every(value=>conditionMatches(value,results,errors));
   case 'or':return condition.conds.some(value=>conditionMatches(value,results,errors));
   default:throw syntheticError('unsupported_fixture_v2_condition:'+condition.type);
  }
 }
 const errorValue=error=>({message:error.message,code:typeof error.code==='string'?error.code:'SQLITE_ERROR'});
 const fetch=async request=>{
  counts.requests++;
  assert.equal(request.method,'POST');
  assert.equal(new URL(request.url).origin,'https://guard-fixture.invalid');
  assert.equal(new URL(request.url).pathname,'/v2/pipeline');
  assert.equal(request.headers.get('authorization'),null,'fixture uses no credentials');
  const input=await request.json();
  let context;
  if(input.baton){context=sessions.get(input.baton);assert(context,'unknown fixture stream baton');}
  else {const baton='synthetic-stream-'+ ++sequence;context={baton,statements:new Map(),expired:false,closed:false};sessions.set(baton,context);}
  let baton=context.baton;
  const commitBefore=counts.commit;
  const results=input.requests.map(command=>{
   try{
    const response={type:command.type};
    if(command.type==='close'){
     if(activeBaton===context.baton&&engine.isTransaction){engine.exec('ROLLBACK');activeBaton=null;counts.rollback++;}
     context.closed=true;baton=null;
    } else if(context.closed||context.expired)throw syntheticError('synthetic_transaction_expired','TRANSACTION_CLOSED');
    else if(command.type==='store_sql')context.statements.set(command.sql_id,command.sql);
    else if(command.type==='close_sql')context.statements.delete(command.sql_id);
    else if(command.type==='execute')response.result=execute(context,command.stmt);
    else if(command.type==='batch'){
     const step_results=[],step_errors=[];
     for(const step of command.batch.steps){
      if(!conditionMatches(step.condition,step_results,step_errors)){step_results.push(null);step_errors.push(null);continue;}
      try{step_results.push(execute(context,step.stmt));step_errors.push(null);}
      catch(error){step_results.push(null);step_errors.push(errorValue(error));}
     }
     response.result={step_results,step_errors};
    } else throw syntheticError('unsupported_fixture_protocol_request:'+command.type);
    return {type:'ok',response};
   }catch(error){return {type:'error',error:errorValue(error)};}
  });
  if(dropCommit&&counts.commit>commitBefore){dropCommit=false;counts.droppedCommitResponses++;throw syntheticError('synthetic_commit_response_lost');}
  return new Response(JSON.stringify({baton,base_url:null,results}),{status:200,headers:{'content-type':'application/json'}});
 };
 const connect=()=>{
  const client=createClient({url:'https://guard-fixture.invalid',intMode:'bigint',fetch});
  const db=createLibsqlDatabase(client);connections.push(db);return db;
 };
 const db=connect();
 t.after(async()=>{await Promise.all(connections.map(connection=>connection.close()));await nextTurn();await nextTurn();engine.close();});
 return {db,connect,engine,counts,
  dropNextCommitResponse(){dropCommit=true;},
  expireAfterStatement(pattern){assert(pattern instanceof RegExp);expirePattern=pattern;}
 };
}
