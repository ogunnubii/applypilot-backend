import {AsyncLocalStorage} from 'node:async_hooks';

const scope = new AsyncLocalStorage();
export class DatabaseError extends Error {
  constructor(code) { super(code); this.name = 'DatabaseError'; this.code = code; }
}
export class UncertainCommitError extends DatabaseError {
  constructor() { super('database_commit_outcome_uncertain'); }
}
const failure = code => new DatabaseError(code);
function value(input) {
  if (typeof input === 'bigint') {
    if (input > BigInt(Number.MAX_SAFE_INTEGER) || input < BigInt(Number.MIN_SAFE_INTEGER))
      throw failure('database_integer_out_of_safe_range');
    return Number(input);
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
  return input;
}
function resultRow(result, row) {
  return row === undefined ? undefined : Object.fromEntries(result.columns.map((column, index) => [column, value(result.positionalRows ? row[index] : row[column])]));
}

// The driver is private. Repositories get scoped async methods, never the client.
// One transaction per adapter at a time; database locking is still authoritative
// across processes/adapters. No local cache, automatic retries, or network work
// belongs inside a transaction callback.
export function createAsyncDatabase(driver) {
  let tail = Promise.resolve(), closed = false, poisoned = false, closingDriver;
  const closeDriver = () => closingDriver ||= Promise.resolve().then(() => driver.close());
  function enqueue(work) {
    if (scope.getStore()) return Promise.reject(failure('database_nested_scope_use_transaction_handle'));
    if (closed || poisoned) return Promise.reject(failure('database_connection_closed'));
    const operation = tail.then(() => {
      if (poisoned) throw failure('database_connection_closed');
      return work();
    });
    tail = operation.catch(() => {});
    return operation;
  }
  async function transaction(mode, work) {
    if (!['read', 'write'].includes(mode) || typeof work !== 'function') throw failure('database_invalid_transaction');
    return enqueue(async () => {
      const raw = await driver.begin(mode);
      const token = {};
      let active = true, commitStarted = false, firstFailure, pending = new Set();
      const execute = (kind, sql, args) => {
        const operation = (async () => {
          if (!active || scope.getStore() !== token) throw failure('transaction_already_finished_or_outside_scope');
          if (pending.size) throw failure('transaction_parallel_statements_not_supported');
          // SQL is developer-owned, never request input. Limit this first-stage
          // interface to single statements; transaction/PRAGMA control is private.
          if (typeof sql !== 'string' || !/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(sql.trim()) || sql.trim().replace(/;$/, '').includes(';'))
            throw failure('database_unsupported_statement');
          if (mode === 'read' && (kind === 'run' || !/^SELECT\b/i.test(sql.trim()))) throw failure('database_read_scope_write');
          for (const arg of args) {
            if (typeof arg === 'number' && (!Number.isFinite(arg) || (Number.isInteger(arg) && !Number.isSafeInteger(arg))))
              throw failure('database_invalid_number');
          }
          const result = await raw.execute({sql, args});
          if (kind === 'get') return resultRow(result, result.rows[0]);
          if (kind === 'all') return result.rows.map(row => resultRow(result, row));
          if (result.columns?.length) throw failure('database_returned_rows_require_get_or_all');
          return {changes: value(result.rowsAffected), lastInsertRowid: value(result.lastInsertRowid)};
        })();
        pending.add(operation);
        // Attach rejection handling immediately, including for forgotten awaits.
        operation.then(() => pending.delete(operation), error => { firstFailure ||= error; pending.delete(operation); });
        return operation;
      };
      const tx = Object.freeze({
        get: (sql, ...args) => execute('get', sql, args),
        all: (sql, ...args) => execute('all', sql, args),
        run: (sql, ...args) => execute('run', sql, args)
      });
      try {
        const fk = await raw.execute({sql: 'PRAGMA foreign_keys', args: []});
        if (value(fk.rows[0]?.foreign_keys) !== 1) throw failure('foreign_keys_must_be_enabled');
        const result = await scope.run(token, () => work(tx));
        active = false;
        const unfinished = pending.size > 0;
        await Promise.allSettled([...pending]);
        if (unfinished) throw failure('transaction_has_unawaited_statements');
        if (firstFailure) throw firstFailure; // catching a SQL error cannot commit partial work
        commitStarted = true;
        await raw.commit();
        return result;
      } catch (error) {
        active = false;
        await Promise.allSettled([...pending]);
        if (commitStarted) throw new UncertainCommitError();
        try { await raw.rollback(); }
        catch { poisoned = true; throw failure('database_rollback_failed_connection_closed'); }
        throw error;
      } finally {
        active = false;
        try { await raw.close(); }
        catch { poisoned = true; }
        if (poisoned) { try { await closeDriver(); } catch {} }
      }
    });
  }
  return Object.freeze({
    read: work => transaction('read', work),
    write: work => transaction('write', work),
    async close() {
      if (scope.getStore()) throw failure('database_close_inside_transaction');
      if (closed) return;
      closed = true;
      await tail;
      await closeDriver();
    }
  });
}
