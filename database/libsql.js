import {createAsyncDatabase} from './async-database.js';

// Ownership transfers to this adapter. The client must not be used elsewhere.
export function createLibsqlDatabase(client) {
  return createAsyncDatabase({
    async begin(mode) {
      const transaction = await client.transaction(mode);
      return {
        async execute(statement) { return {...await transaction.execute(statement), positionalRows: true}; },
        commit: () => transaction.commit(), rollback: () => transaction.rollback(), close: () => transaction.close()
      };
    },
    close: () => client.close()
  });
}

// Deliberately no file/syncUrl/offline mode or environment-reading factory.
// Remote activation stays blocked until full runtime import, schema, guards and
// callers are qualified. Validation never contacts the supplied target.
export async function openRemoteDatabase({url, authToken}) {
  const target = new URL(url);
  if (!['https:', 'libsql:'].includes(target.protocol) || !target.hostname || target.username || target.password || target.search || target.hash || !['', '/'].includes(target.pathname))
    throw Error('database_remote_origin_required');
  if (typeof authToken !== 'string' || !authToken) throw Error('database_authentication_required');
  // Protected-history completion is not a full runtime import. Keep the sole
  // remote runtime factory closed until every writer, schema, authorization,
  // durable upload and full-import qualification is implemented and tested.
  // There is intentionally no environment flag or caller-provided bypass.
  throw Error('database_remote_runtime_not_qualified');
}
