import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createClient} from '@libsql/client/http';
import {createLibsqlDatabase} from './libsql.js';
import {UncertainCommitError} from './async-database.js';

// Protocol fixture for the real official HTTP client. fetch is fully replaced:
// no sockets, live Turso endpoint, credential store, or provider is involved.
// Implements the v2 JSON subset used by this pinned client's transactions.
function httpFixture(t, {dropCommit = false, expireOnInsert = false} = {}) {
  const engine = new DatabaseSync(':memory:');
  engine.exec('PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY); INSERT INTO parent VALUES(1); CREATE TABLE item(id INTEGER PRIMARY KEY,parent INTEGER REFERENCES parent(id),label TEXT);');
  const statements = new Map(), counts = {begin: 0, commit: 0, rollback: 0, insert: 0, requests: 0};
  let nextBaton = 0;
  const encode = value => value === null ? {type: 'null'} : typeof value === 'number' || typeof value === 'bigint' ? {type: 'integer', value: String(value)} : {type: 'text', value};
  const decode = value => value.type === 'null' ? null : value.type === 'integer' ? BigInt(value.value) : value.value;
  function execute(stmt) {
    const sql = stmt.sql ?? statements.get(stmt.sql_id);
    if (/^BEGIN/.test(sql)) counts.begin++;
    if (/^COMMIT/.test(sql)) counts.commit++;
    if (/^ROLLBACK/.test(sql)) counts.rollback++;
    if (/^INSERT/.test(sql)) {
      counts.insert++;
      if (expireOnInsert) { if (engine.isTransaction) engine.exec('ROLLBACK'); throw Error('synthetic_transaction_expired'); }
    }
    // libSQL's read transaction syntax is equivalent to a native snapshot here.
    const statement = engine.prepare(sql === 'BEGIN TRANSACTION READONLY' ? 'BEGIN' : sql);
    statement.setReadBigInts(true);
    const columns = statement.columns().map(c => c.name), args = (stmt.args || []).map(decode);
    if (columns.length) return {cols: columns.map(name => ({name})), rows: statement.all(...args).map(row => columns.map(c => encode(row[c]))), affected_row_count: 0, last_insert_rowid: null};
    const result = statement.run(...args);
    return {cols: [], rows: [], affected_row_count: Number(result.changes), last_insert_rowid: String(result.lastInsertRowid)};
  }
  const fetch = async request => {
    counts.requests++;
    assert.equal(new URL(request.url).hostname, 'fictional.invalid');
    assert.equal(new URL(request.url).pathname, '/v2/pipeline');
    const input = await request.json();
    let baton = input.baton || 'fictional-baton-' + ++nextBaton, committed = false;
    const results = input.requests.map(command => {
      try {
        let response = {type: command.type};
        if (command.type === 'store_sql') statements.set(command.sql_id, command.sql);
        else if (command.type === 'close_sql') statements.delete(command.sql_id);
        else if (command.type === 'close') { if (engine.isTransaction) engine.exec('ROLLBACK'); baton = null; }
        else if (command.type === 'execute') {
          const previous = counts.commit; response.result = execute(command.stmt); committed ||= counts.commit > previous;
        } else if (command.type === 'batch') {
          const step_results = [], step_errors = [];
          const condition = c => !c || c.type === 'ok' && step_results[c.step] !== null || c.type === 'not' && !condition(c.cond) || c.type === 'and' && c.conds.every(condition);
          for (const step of command.batch.steps) {
            if (!condition(step.condition)) { step_results.push(null); step_errors.push(null); continue; }
            try { const previous = counts.commit; step_results.push(execute(step.stmt)); step_errors.push(null); committed ||= counts.commit > previous; }
            catch (error) { step_results.push(null); step_errors.push({message: error.message, code: 'SQLITE_CONSTRAINT'}); }
          }
          response.result = {step_results, step_errors};
        } else throw Error('unsupported synthetic protocol request');
        return {type: 'ok', response};
      } catch (error) { return {type: 'error', error: {message: error.message, code: 'SQLITE_ERROR'}}; }
    });
    if (committed && dropCommit) throw Error('synthetic_commit_response_lost');
    return new Response(JSON.stringify({baton, base_url: null, results}), {status: 200, headers: {'content-type': 'application/json'}});
  };
  const client = createClient({url: 'https://fictional.invalid', authToken: 'SYNTHETIC_TEST_ONLY', intMode: 'bigint', fetch});
  const db = createLibsqlDatabase(client);
  t.after(async () => { await db.close(); await nextTurn(); engine.close(); });
  return {db, engine, counts};
}

test('official HTTP driver preserves one scoped connection through successful async reads/writes', async t => {
  const {db, counts} = httpFixture(t);
  await db.write(async tx => {
    await tx.run('INSERT INTO item(parent,label) VALUES(?,?)', 1, 'fictional one');
    await tx.run('INSERT INTO item(parent,label) VALUES(?,?)', 1, 'fictional two');
    assert.deepEqual(await tx.all('SELECT label FROM item ORDER BY id'), [{label: 'fictional one'}, {label: 'fictional two'}]);
  });
  assert.equal((await db.read(tx => tx.get('SELECT COUNT(*) AS n FROM item'))).n, 2);
  assert.equal(counts.begin, 2); assert.equal(counts.commit, 2); assert.equal(counts.rollback, 0);
});
test('official HTTP driver rolls back a partial write when a later foreign key fails', async t => {
  const {db, engine, counts} = httpFixture(t);
  await assert.rejects(db.write(async tx => {
    await tx.run('INSERT INTO item(parent,label) VALUES(?,?)', 1, 'fictional');
    await tx.run('INSERT INTO item(parent,label) VALUES(?,?)', 999, 'invalid');
  }), /FOREIGN KEY/);
  assert.equal(engine.prepare('SELECT COUNT(*) n FROM item').get().n, 0);
  assert.equal(counts.commit, 0); assert.equal(counts.rollback, 1);
});
test('official HTTP driver loses a commit response after durable write: uncertain, one insert, no retry', async t => {
  const {db, engine, counts} = httpFixture(t, {dropCommit: true});
  await assert.rejects(db.write(tx => tx.run('INSERT INTO item(parent,label) VALUES(?,?)', 1, 'fictional')), UncertainCommitError);
  assert.equal(engine.prepare('SELECT COUNT(*) n FROM item').get().n, 1);
  assert.equal(counts.commit, 1); assert.equal(counts.insert, 1); assert.equal(counts.rollback, 0);
});
test('official HTTP driver transaction expiration never commits work outside the failed transaction', async t => {
  const {db, engine, counts} = httpFixture(t, {expireOnInsert: true});
  await assert.rejects(db.write(tx => tx.run('INSERT INTO item(parent,label) VALUES(?,?)', 1, 'fictional')));
  assert.equal(engine.prepare('SELECT COUNT(*) n FROM item').get().n, 0);
  assert.equal(counts.commit, 0); assert.equal(counts.insert, 1);
});
