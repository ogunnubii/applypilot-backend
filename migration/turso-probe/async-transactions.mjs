// Explicit asynchronous transaction boundary for the hosted-port experiments.
// Not imported by the production app; never opens a connection or retries writes.
export class UncertainCommitError extends Error{
 constructor(){super('database_commit_outcome_uncertain');this.code='database_commit_outcome_uncertain';}
}
const safeValue=value=>{
 if(typeof value==='bigint'){
  if(value>BigInt(Number.MAX_SAFE_INTEGER)||value<BigInt(Number.MIN_SAFE_INTEGER))throw Error('database_integer_out_of_safe_range');
  return Number(value);
 }
 return value;
};
const row=value=>value===undefined?undefined:Object.fromEntries(Object.keys(value).filter(k=>!/^\d+$/.test(k)).map(k=>[k,safeValue(value[k])]));
export async function writeTransaction(client,work){
 const transaction=await client.transaction('write');let commitStarted=false,finished=false;
 const execute=async(sql,args)=>{
  if(finished)throw Error('transaction_already_finished');
  return transaction.execute({sql,args});
 };
 const tx={
  async get(sql,...args){return row((await execute(sql,args)).rows[0]);},
  async all(sql,...args){return (await execute(sql,args)).rows.map(row);},
  async run(sql,...args){const result=await execute(sql,args);return {changes:result.rowsAffected,lastInsertRowid:result.lastInsertRowid};}
 };
 try{
  // PRAGMA foreign_keys must already be enabled on this actual connection.
  // Setting it inside a transaction is a SQLite no-op, so never pretend it worked.
  if((await tx.get('PRAGMA foreign_keys'))?.foreign_keys!==1)throw Error('foreign_keys_must_be_enabled');
  const result=await work(tx);
  commitStarted=true;await transaction.commit();finished=true;return result;
 }catch(error){
  finished=true;
  if(commitStarted)throw new UncertainCommitError();
  try{await transaction.rollback()}catch{throw Error('database_rollback_failed_connection_closed')}
  throw error;
 }finally{
  finished=true;transaction.close();
 }
}
