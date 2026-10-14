import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {professionalExperience} from './professional-experience.js';
import {fixture} from '../database/test-fixture.js';
import {installExperience, saveExperience, experienceFor, deleteExperience} from '../experience-library.js';

const schema = `CREATE TABLE applicants(id TEXT PRIMARY KEY,user_id TEXT);
CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,applicant_id TEXT REFERENCES applicants(id),local_attempt_at TEXT);
CREATE TABLE public_fill_attempts(job_id TEXT PRIMARY KEY REFERENCES jobs(id),state TEXT,attempted_at TEXT);
CREATE TABLE professional_experience(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,applicant_id TEXT NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,title TEXT NOT NULL,details TEXT NOT NULL,approved_at TEXT NOT NULL,updated_at TEXT NOT NULL);
INSERT INTO applicants VALUES('profile','owner'),('other-profile','other'),('owner-second','owner');
INSERT INTO jobs VALUES('unattempted','owner','profile',NULL),('uncertain','owner','profile','2026-10-13T23:22:00Z'),('other','other','other-profile',NULL),('second','owner','owner-second',NULL);
INSERT INTO public_fill_attempts VALUES('unattempted','needs_review','recent'),('uncertain','needs_review','protected'),('other','needs_review','other'),('second','needs_review','second');`;
const input = {approved: true, title: 'Fictional project', details: 'Synthetic professional facts for this test only.'};

for (const kind of ['native', 'libsql']) {
  test(kind + ': complete experience CRUD matches native facts and preserves attempted/other-profile drafts', async t => {
    const {db} = await fixture(t, kind, schema);
    const original = new DatabaseSync(':memory:'); original.exec(schema); installExperience(original); t.after(() => original.close());
    const request = (method, data = {}) => professionalExperience(db, {uid: 'owner', applicant: 'profile', method, ...data});
    const result = await request('POST', {input}); assert.equal(result.status, 200); const id = result.body.id;
    const nativeId = saveExperience(original, 'owner', 'profile', input).id;
    const publicFacts = facts => facts.map(({title, details}) => ({title, details}));
    assert.deepEqual(publicFacts((await request('GET')).body.facts), publicFacts(experienceFor(original, 'owner', 'profile')));
    const edited = {...input, title: 'Updated fictional project'};
    assert.equal((await request('PUT', {id, input: edited})).status, 200); saveExperience(original, 'owner', 'profile', edited, nativeId);
    assert.deepEqual(publicFacts((await request('GET')).body.facts), publicFacts(experienceFor(original, 'owner', 'profile')));
    assert.deepEqual(await db.read(tx => tx.all('SELECT job_id,attempted_at FROM public_fill_attempts ORDER BY job_id')), [
      {job_id: 'other', attempted_at: 'other'}, {job_id: 'second', attempted_at: 'second'}, {job_id: 'unattempted', attempted_at: '1970-01-01'}, {job_id: 'uncertain', attempted_at: 'protected'}
    ]);
    assert.equal((await request('DELETE', {id})).status, 200); deleteExperience(original, 'owner', 'profile', nativeId);
    assert.deepEqual((await request('GET')).body.facts, experienceFor(original, 'owner', 'profile'));
  });
  test(kind + ': ownership, approved facts and cardinality checks precede writes', async t => {
    const {db} = await fixture(t, kind, schema);
    const request = data => professionalExperience(db, {uid: 'owner', applicant: 'profile', method: 'POST', input, ...data});
    assert.equal((await request({uid: ''})).status, 401);
    assert.equal((await request({uid: 'other'})).status, 404);
    for (const data of [null, {}, {...input, approved: false}, {...input, title: 'x'}, {...input, details: 'short'}]) assert.equal((await request({input: data})).status, 400);
    assert.equal((await request({method: 'PUT', id: 'missing'})).status, 400);
    const other = await request({uid: 'other', applicant: 'other-profile'});
    assert.equal((await request({method: 'PUT', id: other.body.id})).status, 400);
    assert.equal((await request({method: 'DELETE', id: other.body.id})).status, 400);
    await db.write(async tx => {
      for (let i = 0; i < 150; i++) await tx.run('INSERT INTO professional_experience VALUES(?,?,?,?,?,?,?)', 'fixture-' + i, 'owner', 'profile', input.title, input.details, 'at', 'at');
    });
    assert.equal((await request({})).status, 400);
    assert.equal((await request({method: 'PUT', id: 'fixture-0'})).status, 200);
    assert.equal((await db.read(tx => tx.get('SELECT COUNT(*) AS n FROM professional_experience WHERE user_id=?', 'owner'))).n, 150);
  });
  test(kind + ': failure refreshing drafts rolls back the professional fact as one operation', async t => {
    const {db, path} = await fixture(t, kind, schema);
    const fail = new DatabaseSync(path);
    fail.exec("CREATE TRIGGER synthetic_failure BEFORE UPDATE ON public_fill_attempts BEGIN SELECT RAISE(ABORT,'fictional driver error'); END"); fail.close();
    const result = await professionalExperience(db, {uid: 'owner', applicant: 'profile', method: 'POST', input});
    assert.equal(result.status, 503); assert(!JSON.stringify(result).includes('fictional driver error'));
    assert.equal((await db.read(tx => tx.get('SELECT COUNT(*) AS n FROM professional_experience'))).n, 0);
    assert.equal((await db.read(tx => tx.get('SELECT attempted_at FROM public_fill_attempts WHERE job_id=?', 'uncertain'))).attempted_at, 'protected');
  });
}
