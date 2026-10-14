// Keep the earlier receipt experiment on the same tested transaction foundation.
// The receipt repository remains disconnected from application execution.
import {createLibsqlDatabase} from '../../database/libsql.js';
export {UncertainCommitError} from '../../database/async-database.js';
const adapters = new WeakMap();
export function writeTransaction(client, work) {
  if (!adapters.has(client)) adapters.set(client, createLibsqlDatabase(client));
  return adapters.get(client).write(work);
}
