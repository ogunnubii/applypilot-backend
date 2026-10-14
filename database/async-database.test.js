import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createAsyncDatabase, UncertainCommitError} from './async-database.js';
import {openNativeDatabase} from './native.js';
import {openRemoteDatabase} from './libsql.js';
import {fixture} from './test-fixture.js';

const schema = `CREATE TABLE parent(id INTEGER PRIMARY KEY); INSERT INTO parent VALUES(1);
 CREATE TABLE item(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES parent(id), label TEXT UNIQUE, data BLOB);`;
for (const kind of ['native', 'libsql']) {
  test(kind + ': scoped reads/writes preserve rows, binary and integer results', async t => {
    const {db} = await fixture(t, kind, schema);
    assert.deepEqual(await db.write(tx => tx.run('INSERT INTO item(parent,label,data) VALUES(?,?,?)', 1, 'fictional', new Uint8Array([0, 255]))), {changes: 1, lastInsertRowid: 1});
    assert.deepEqual(await db.read(tx => tx.get('SELECT id,label,data FROM item')), {id: 1, label: 'fictional', data: new Uint8Array([0, 255])});
    assert.deepEqual(await db.read(tx => tx.get('SELECT 1 AS "0"')), {'0': 1});
    assert.deepEqual(await db.read(tx => tx.get('SELECT 5 AS "1",6 AS x')), {'1': 5, x: 6});
    assert.equal(await db.read(tx => tx.get('SELECT id FROM item WHERE id=9')), undefined);
    assert.deepEqual(await db.read(tx => tx.all('SELECT id FROM item')), [{id: 1}]);
    await assert.rejects(db.read(tx => tx.get('SELECT 9007199254740993 AS n')), /integer_out_of_safe_range/);
    await assert.rejects(db.write(tx => tx.run('INSERT INTO parent VALUES(?)', 9007199254740992)), /invalid_number/);
  });
  test(kind + ': rollback covers FK violations, callback failure and caught SQL errors', async t => {
    const {db} = await fixture(t, kind, schema);
    for (const catchFailure of [false, true]) {
      await assert.rejects(db.write(async tx => {
        await tx.run('INSERT INTO item(parent,label) VALUES(1,?)', 'before-failure');
        try { await tx.run('INSERT INTO item(parent,label) VALUES(999,?)', 'bad-parent'); }
        catch (error) { if (!catchFailure) throw error; }
      }), /FOREIGN KEY/);
      assert.equal((await db.read(tx => tx.get('SELECT COUNT(*) AS n FROM item'))).n, 0);
    }
    await assert.rejects(db.write(async tx => { await tx.run('INSERT INTO parent VALUES(2)'); throw Error('synthetic callback'); }), /synthetic callback/);
    assert.equal((await db.read(tx => tx.get('SELECT COUNT(*) AS n FROM parent'))).n, 1);
  });
  test(kind + ': serialized callers cannot bleed into another transaction; handles expire', async t => {
    const {db, path} = await fixture(t, kind, schema);
    let signal, release, escaped;
    const entered = new Promise(resolve => { signal = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const first = db.write(async tx => { escaped = tx; await tx.run('INSERT INTO parent VALUES(2)'); signal(); await hold; throw Error('rollback first'); });
    first.catch(() => {});
    await entered;
    const observer = new DatabaseSync(path, {readOnly: true});
    assert.equal(observer.prepare('SELECT COUNT(*) AS n FROM parent').get().n, 1);
    observer.close();
    let secondEntered = false;
    const second = db.write(async tx => { secondEntered = true; return tx.run('INSERT INTO parent VALUES(3)'); });
    await Promise.resolve(); assert.equal(secondEntered, false);
    release(); await assert.rejects(first, /rollback first/); await second;
    assert.deepEqual(await db.read(tx => tx.all('SELECT id FROM parent ORDER BY id')), [{id: 1}, {id: 3}]);
    await assert.rejects(escaped.get('SELECT 1'), /already_finished/);
  });
  test(kind + ': nested, parallel, read-scope writes and transaction SQL fail closed', async t => {
    const {db} = await fixture(t, kind, schema);
    await assert.rejects(db.write(() => db.read(tx => tx.get('SELECT 1'))), /nested_scope/);
    await assert.rejects(db.read(tx => tx.run('INSERT INTO parent VALUES(2)')), /read_scope_write/);
    await assert.rejects(db.read(tx => tx.get('DELETE FROM parent RETURNING id')), /read_scope_write/);
    await assert.rejects(db.write(tx => tx.run('COMMIT')), /unsupported_statement/);
    await assert.rejects(db.write(tx => tx.run('SELECT 1; COMMIT')), /unsupported_statement/);
    await assert.rejects(db.write(tx => tx.run('INSERT INTO parent VALUES(2) RETURNING id')), /returned_rows_require/);
    await assert.rejects(db.write(tx => Promise.all([tx.run('INSERT INTO parent VALUES(2)'), tx.run('INSERT INTO parent VALUES(3)')])), /parallel_statements/);
    assert.deepEqual(await db.read(tx => tx.all('SELECT id FROM parent')), [{id: 1}]);
  });
  test(kind + ': two adapter instances cannot simultaneously claim the same writer lock', async t => {
    const {db, path} = await fixture(t, kind, schema);
    const second = openNativeDatabase(path);
    try { await db.write(async tx => {
      await tx.run('INSERT INTO parent VALUES(2)');
      // A separate async context represents another request/process.
      const observer = new DatabaseSync(path); observer.exec('PRAGMA busy_timeout=0');
      assert.throws(() => observer.exec('BEGIN IMMEDIATE'), /locked/); observer.close();
    });
    assert.equal((await second.read(tx => tx.get('SELECT COUNT(*) AS n FROM parent'))).n, 2);
    } finally { await second.close(); }
  });
}

function fakeDriver({commit, rollback, execute, close} = {}) {
  const counts = {begin: 0, commit: 0, rollback: 0, transactionClose: 0, clientClose: 0};
  const driver = {
    async begin() { counts.begin++; return {
      async execute(statement) { return statement.sql === 'PRAGMA foreign_keys' ? {columns: ['foreign_keys'], rows: [{foreign_keys: 1n}]} : execute?.(statement) ?? {columns: [], rows: [], rowsAffected: 1}; },
      async commit() { counts.commit++; await commit?.(); },
      async rollback() { counts.rollback++; await rollback?.(); },
      async close() { counts.transactionClose++; await close?.(); }
    }; },
    close() { counts.clientClose++; }
  };
  return {db: createAsyncDatabase(driver), counts};
}
test('lost commit acknowledgement returns uncertainty after one attempt, without rollback or retry', async () => {
  let durable = false;
  const {db, counts} = fakeDriver({commit: () => { durable = true; throw Error('synthetic dropped response'); }});
  await assert.rejects(db.write(tx => tx.run('INSERT INTO fictional VALUES(1)')), UncertainCommitError);
  assert.equal(durable, true);
  assert.deepEqual(counts, {begin: 1, commit: 1, rollback: 0, transactionClose: 1, clientClose: 0});
  await db.close();
});
test('a pending unawaited write is drained then rolled back, never committed', async () => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const {db, counts} = fakeDriver({execute: () => { started(); return new Promise(resolve => { release = () => resolve({columns: [], rows: [], rowsAffected: 1}); }); }});
  const result = db.write(tx => { tx.run('INSERT INTO fictional VALUES(1)'); });
  await entered; release();
  await assert.rejects(result, /unawaited_statements/);
  assert.equal(counts.commit, 0); assert.equal(counts.rollback, 1); await db.close();
});
test('rollback failure quarantines the adapter; a later request cannot reuse the connection', async () => {
  const {db, counts} = fakeDriver({rollback: () => { throw Error('synthetic transport loss'); }});
  await assert.rejects(db.write(() => { throw Error('synthetic work error'); }), /rollback_failed/);
  await assert.rejects(db.read(tx => tx.get('SELECT 1')), /connection_closed/);
  assert.equal(counts.begin, 1); assert.equal(counts.clientClose, 1); await db.close(); assert.equal(counts.clientClose, 1);
});
test('foreign keys must be enabled on the actual transaction connection before any work', async () => {
  let work = false, rollback = false;
  const db = createAsyncDatabase({begin: async () => ({execute: async () => ({rows: [{foreign_keys: 0}]}), commit() { assert.fail(); }, rollback() { rollback = true; }, close() {}}), close() {}});
  await assert.rejects(db.write(() => { work = true; }), /foreign_keys_must_be_enabled/);
  assert.equal(work, false); assert.equal(rollback, true); await db.close();
});
test('remote factory rejects file replicas and embedded credentials before importing or connecting', async () => {
  for (const url of ['file:replica.sqlite', 'http://fictional.invalid', 'https://user:password@fictional.invalid', 'https://fictional.invalid?token=sentinel', 'https://fictional.invalid/a'])
    await assert.rejects(openRemoteDatabase({url, authToken: 'synthetic'}), /remote_origin_required/);
});
