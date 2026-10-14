import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createClient} from '@libsql/client';
import {openNativeDatabase} from './native.js';
import {createLibsqlDatabase} from './libsql.js';

export async function fixture(t, kind, schema) {
  const suite = process.env.APPLYPILOT_ASYNC_TEST_ROOT;
  if (!suite || !relative(resolve(tmpdir()), resolve(suite)) || relative(resolve(tmpdir()), resolve(suite)).startsWith('..'))
    throw Error('Run fixtures through node checks/run-async-tests.mjs');
  const root = mkdtempSync(join(suite, 'fictional-'));
  const path = join(root, 'fixture.sqlite');
  const seed = new DatabaseSync(path);
  seed.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;' + schema);
  seed.close();
  const db = kind === 'native' ? openNativeDatabase(path) : createLibsqlDatabase(createClient({url: pathToFileURL(path).href, intMode: 'bigint', concurrency: 1}));
  t.after(async () => {
    await db.close();
  });
  return {db, path};
}
