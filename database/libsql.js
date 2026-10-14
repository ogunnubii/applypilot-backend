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
// Calling this connects to an explicitly provided remote target; startup has no
// remote switch until the remaining schemas, guards and callers are ported.
export async function openRemoteDatabase({url, authToken}) {
  const target = new URL(url);
  if (!['https:', 'libsql:'].includes(target.protocol) || !target.hostname || target.username || target.password || target.search || target.hash || !['', '/'].includes(target.pathname))
    throw Error('database_remote_origin_required');
  if (typeof authToken !== 'string' || !authToken) throw Error('database_authentication_required');
  const {createClient} = await import('@libsql/client');
  return createLibsqlDatabase(createClient({url, authToken, intMode: 'bigint'}));
}
