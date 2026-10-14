import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {notificationPreferences} from './notification-preferences.js';
import {fixture} from '../database/test-fixture.js';
import {UncertainCommitError} from '../database/async-database.js';

const schema = `CREATE TABLE users(id TEXT PRIMARY KEY);
CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),status TEXT,challenge TEXT);
CREATE TABLE public_account_security(user_id TEXT PRIMARY KEY REFERENCES users(id),email_verified_at TEXT);
CREATE TABLE notification_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id),enabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE blocker_emails(key TEXT PRIMARY KEY,job_id TEXT REFERENCES jobs(id),last_error TEXT);
INSERT INTO users VALUES('legacy'),('unverified'),('verified');
INSERT INTO public_account_security VALUES('unverified',NULL),('verified','2026-01-01');
INSERT INTO jobs VALUES('uncertain','legacy','local_browser','Unconfirmed submission'),('other','verified','paused','fictional');
INSERT INTO blocker_emails VALUES('own','uncertain','failure'),('other1','other','failure'),('other2','other','failure');`;
for (const kind of ['native', 'libsql']) {
  test(kind + ': full GET/PUT preference slice is tenant-scoped and preserves protected job state', async t => {
    const {db} = await fixture(t, kind, schema);
    const before = await db.read(tx => tx.all('SELECT * FROM jobs ORDER BY id'));
    const request = (uid, method = 'GET', input) => notificationPreferences(db, {uid, method, input, configured: true});
    assert.deepEqual(await request('legacy'), {status: 200, body: {enabled: false, configured: true, emailVerificationRequired: false, failed: 1}});
    assert.equal((await request('legacy', 'PUT', {enabled: true, user_id: 'verified'})).body.enabled, true);
    assert.equal((await request('verified')).body.enabled, false);
    assert.equal((await request('verified')).body.failed, 2);
    assert.equal((await request('legacy', 'PUT', {enabled: false})).body.enabled, false);
    assert.deepEqual(await db.read(tx => tx.all('SELECT * FROM jobs ORDER BY id')), before);
    assert.equal((await db.read(tx => tx.get('SELECT COUNT(*) AS n FROM blocker_emails'))).n, 3);
  });
  test(kind + ': unverified users cannot enable mail; missing accounts and malformed input cannot write', async t => {
    const {db} = await fixture(t, kind, schema);
    const request = (uid, method = 'GET', input) => notificationPreferences(db, {uid, method, input, configured: true});
    assert.deepEqual((await request('unverified')).body, {enabled: false, configured: false, emailVerificationRequired: true, failed: 0});
    assert.equal((await request('unverified', 'PUT', {enabled: true})).status, 403);
    assert.equal((await request('unverified', 'PUT', {enabled: false})).status, 200);
    for (const uid of ['', 'missing']) assert.equal((await request(uid, 'PUT', {enabled: true})).status, 401);
    for (const input of [null, [], {}, {enabled: 1}, {enabled: 'true'}]) assert.equal((await request('legacy', 'PUT', input)).status, 400);
    assert.equal((await request('legacy', 'DELETE')).status, 405);
    assert.equal(await db.read(tx => tx.get('SELECT enabled FROM notification_preferences WHERE user_id=?', 'legacy')), undefined);
  });
  test(kind + ': failure after preference write rolls it back and does not leak driver details', async t => {
    const {db, path} = await fixture(t, kind, schema);
    const alter = new DatabaseSync(path); alter.exec('DROP TABLE blocker_emails'); alter.close();
    const result = await notificationPreferences(db, {uid: 'legacy', method: 'PUT', input: {enabled: true}});
    assert.equal(result.status, 503); assert.equal(result.body.code, 'database_unavailable');
    assert(!JSON.stringify(result).includes('blocker_emails'));
    assert.equal(await db.read(tx => tx.get('SELECT enabled FROM notification_preferences WHERE user_id=?', 'legacy')), undefined);
  });
}
test('uncertain response is not reported as success and asks for readback without automatic retry', async () => {
  let writes = 0;
  const result = await notificationPreferences({async write() { writes++; throw new UncertainCommitError(); }}, {uid: 'fictional', method: 'PUT', input: {enabled: true}});
  assert.equal(result.status, 503); assert.equal(result.body.code, 'database_commit_outcome_uncertain'); assert.equal(writes, 1);
});
