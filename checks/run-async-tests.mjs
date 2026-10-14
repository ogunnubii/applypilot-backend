import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {join, resolve, relative} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

// libSQL's native Windows addon can retain file mappings until process exit.
// Own fixture cleanup in the parent, after the test process has fully exited.
const root = mkdtempSync(join(tmpdir(), 'applypilot-async-suite-'));
try {
  const result = spawnSync(process.execPath, ['--import', './migration/test-network-guard.mjs', '--test', 'database/*.test.js', 'api/*.test.js', 'migration/turso-guard/*.test.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: {...process.env, APPLYPILOT_ASYNC_TEST_ROOT: root},
    stdio: 'inherit', windowsHide: true
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  const inside = relative(resolve(tmpdir()), resolve(root));
  if (!inside || inside.startsWith('..')) throw Error('invalid_fixture_cleanup_path');
  rmSync(root, {recursive: true, force: true});
}
