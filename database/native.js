import {DatabaseSync} from 'node:sqlite';
import {statSync} from 'node:fs';
import {createAsyncDatabase} from './async-database.js';

// Open an existing database only, using a dedicated connection. Never pass the
// legacy app's shared DatabaseSync through an async transaction boundary.
export function openNativeDatabase(path) {
  if (!statSync(path).isFile()) throw Error('database_existing_file_required');
  const connection = new DatabaseSync(path, {enableForeignKeyConstraints: true});
  connection.exec('PRAGMA busy_timeout=0'); // fail contention; never block the event loop waiting for itself
  return createAsyncDatabase({
    async begin(mode) {
      connection.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN');
      return {
        async execute({sql, args}) {
          const statement = connection.prepare(sql);
          statement.setReadBigInts(true);
          const columns = statement.columns().map(column => column.name);
          if (columns.length) {
            const rows = statement.all(...args);
            const metadata = /^(INSERT|UPDATE|DELETE)\b/i.test(sql.trim())
              ? connection.prepare('SELECT changes() AS changes,last_insert_rowid() AS lastInsertRowid').get() : {changes: 0};
            return {columns, rows, rowsAffected: metadata.changes, lastInsertRowid: metadata.lastInsertRowid};
          }
          const result = statement.run(...args);
          return {columns: [], rows: [], rowsAffected: result.changes, lastInsertRowid: result.lastInsertRowid};
        },
        async commit() { connection.exec('COMMIT'); },
        async rollback() { if (connection.isTransaction) connection.exec('ROLLBACK'); },
        async close() { if (connection.isTransaction) connection.exec('ROLLBACK'); }
      };
    },
    close() { connection.close(); }
  });
}
