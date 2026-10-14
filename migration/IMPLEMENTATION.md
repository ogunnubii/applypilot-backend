# Migration preparation and operator handoff

**Current scope:** the user requires another public hosting app. The Windows
candidate below is not an accepted completed migration. Continue with
[HOSTED-MIGRATION.md](HOSTED-MIGRATION.md), which contains the asynchronous Turso
work, measured interface inventory, tested public-host candidate and remaining
host qualification gates. No replacement has been deployed or activated.

The earlier prepared candidate is a native Node/SQLite service on the existing Windows
PC. It has no hosting subscription and needs no new cloud account or upload service.
It depends on PC uptime and is **not activated**. It retains the original SQLite
transaction/trigger implementation. No Turso database port has been completed or
claimed. It remains available for review but does not satisfy public hosting.

## Candidate compatibility evidence

`turso-probe/` pins the official `@libsql/client` 0.18.0 with a lockfile. Three tests
check its documented remote-client interface and fictional in-memory libSQL data.
The remote client has no `.function()` or synchronous `.prepare()` API; the actual
preparation-function installer fails with `db.function is not a function`.
After importing the original duplicate/history trigger definitions, a queue update
fails with a missing application-defined SQL function. Foreign keys, rollback and
unique request IDs pass. See `turso-probe/compatibility.log` for the observed result.

This establishes an incompatibility with the current guard model, not that Turso
cannot support a rewritten application. A future cloud port would require an async
call graph and equivalent server-side SQL guards. Removing the triggers or relying
on periodic local SQLite uploads would not preserve the current safety contract.
No Turso account or remote database was called. Cloud transactions, quotas and
latency are not verified. [Official client documentation](https://docs.turso.tech/sdk/ts/reference)

## Executable deployment preparation

- `local-deployment.mjs preflight <configuration.private.json>` opens the restored
  database read-only, verifies the original backup manifest and first-activation
  table/file digests, and checks that every current/previous resume resolves.
  It refuses missing, changed or incomplete state and never initializes a blank DB.
- `storage-paths.js` maps the explicitly configured old upload root to the restored
  private directory when files are read. Stored resume paths and all ledger rows
  remain unchanged; path-based saved-answer fingerprints retain their original
  values. Current native paths are also accepted only inside that private root.
- `APPLYPILOT_BACKGROUND_TASKS=paused` stops discovery/worker startup and makes the
  server's funnel, answer-recovery, pipeline, drafting and notification callbacks
  return without work. Default behavior is unchanged outside this migration mode.
- `start-local-migration.ps1` defaults to preflight. Activation requires a separate
  approval file and existing identity configuration injected privately. It checks
  for Node 24 and Poppler. The launcher forces localhost:8080/127.0.0.1, one API lock,
  PC-only mode, disabled public signup and paused background tasks. It creates no
  credentials, does not read env files, and installs no Windows service/startup task.
- A stale runtime lock fails closed and requires operator review. Do not remove it
  until the recorded process is verified stopped; no automatic PID killing exists.
  After first activation, a private activation receipt permits ordinary subsequent
  ledger writes across restarts while continuing integrity/resume checks. That
  receipt is not a cryptographic defense against an administrator replacing files.
- `build-held-extension.mjs <new-directory>` builds an offline review copy for the
  same extension installation. Its hosted environment points to localhost while
  preserving the environment label, records, queue, device and pending receipts.
  Initialization pauses it; API requests and background ticks are blocked. It has
  no release switch and is not installed. A reviewed release after cutover approval
  is still required; do not install it as a second extension or wipe Chrome storage.

The private local data directory should be outside the checkout and cloud-sync
folders, with owner-only Windows ACLs and normal OS disk protection. It stores the
SQLite database plus current/previous PDFs and DOCX files. Windows durability here
means persistent local disk, not multi-machine replication or automatic backups.
The verified source bundle remains separate for rollback.

## Live Railway access evidence, relayed by the parent task

The parent inspected its supported authenticated Railway cloud-browser session:

| Item | Verified value |
| --- | --- |
| Volume | `44e1407f-d0bc-4fef-96e0-33f0644e1c13`, 500 MB, US West California |
| Mount | `/app/data` |
| DATABASE_PATH | `/app/data/applypilot.sqlite` |
| UPLOAD_DIR | `/app/data/resumes` |
| Current file inventory | Database approximately 6.4 MB; WAL approximately 4 MB; SHM approximately 32 KB; resumes directory; older approximately 128 KB backup |
| Supported export route | Railway web Console connects; Files browser offers Download |
| Backups page | No backups; managed backup features require Pro |

Only nonsecret path variables were individually revealed. These observations came
from the parent, not from this task accessing credentials or production files.
The original owner's task has no Railway CLI, connector or exposed dashboard tab.
The parent's supported Console/File route removes the need to expand CLI access.
No paid upgrade is needed for the manual procedure below. No export has occurred.

## Credential-bearing state and required handoff

Source schema inspection, without opening the real database, found:

- `users.password_hash`: salted scrypt password verifiers, credential material.
- `revoked_sessions.token_hash`: SHA-256 fingerprints of revoked session tokens;
  the schema does not persist raw session bearer tokens there.
- `auth_attempts`: authentication rate-limit buckets/counts/expiry.
- Applicant answers, drafts, cache, evidence and uploads: personal application
  data. Free-text contents cannot be classified from schema alone.

Provider keys and SESSION_SECRET/REGISTRATION_CODE are read from environment
configuration in the source, not dedicated database credential columns. This is
not a guarantee that arbitrary historical free text contains no sensitive values.

Therefore a full backup is a **credential-bearing private archive** even without
an env file. The current prohibition on copying credentials means the operator
must obtain explicit approval for full-state backup creation and transfer before
running it. It must not be printed, uploaded into chat/source control, copied to a
public URL, or silently transferred to Turso/another service. Prefer the user
downloading it directly through the authenticated Files UI into the approved
private local directory; any agent-assisted download also needs explicit approval.
Environment-secret provisioning is a separate later approval, not implied by
permission to copy the ledger. Do not read masked variables or browser tokens.

## Tested supported Console procedure — do not run yet

1. Coordinate the source write freeze with the original owner. Stop hosted work,
   Chrome helper writes and AP2 handoff writes; account for server timers and other
   writers. Keep uncertain intents and all pending receipt evidence. Freezing must
   not discard a possible submission or classify it as fresh.
2. After explicit approval for the credential-bearing copy, run `node --version`
   and `tar --version` in the supported Railway Console. The prepared program was
   tested with Node 24.21.0 and requires `node:sqlite.backup`; if unavailable, stop
   instead of using a raw live-file copy.
3. Paste the complete `railway-console-backup.sh` command into that Console. It uses
   the verified paths above, a read-only SQLite connection and SQLite's backup API;
   copies only PDF/DOCX uploads; compares all tables/schema/files; and creates a
   private `/tmp/applypilot-migration-<random>.tar.gz`. It imports no application
   code, starts no worker and does not update source rows. Its only success output
   is counts, the archive path and SHA-256. On error it prints a fixed error code,
   retains incomplete private output and provides no successful archive receipt.
4. Download only the reported verified archive through the existing Files browser,
   after the separate transfer approval. Never download only the base SQLite file:
   the current live WAL contains additional committed state. Do not treat the old
   small backup as current evidence. Keep the old Railway writer frozen.
5. Verify the archive SHA-256 in the private destination, extract into a new private
   directory, then run `state-snapshot.mjs verify <bundle>` and `restore <bundle>
   <new-private-runtime-directory>`. Keep the source backup separate and immutable.
6. Fill the local configuration with the verified manifest hash and private paths.
   Run preflight only. Compare protected histories/attempts/reservations, including
   the uncertain Supabase attempt, before preparing any cutover approval.

`build-console-backup.mjs` generates the exact self-contained shell command from
the tested snapshot implementation. `console-backup.test.mjs` executed that Node
program against synthetic uncheckpointed WAL data, archived/extracted it, compared
all state, and verified no row values appeared in output. This is an offline test;
the program has not been run in Railway or against real user data. The archive is
compressed, not encrypted; its private permissions and transfer route matter.

## Remaining approvals and technical gates

1. Approve this PC-hosted durable fallback and its uptime tradeoff, or require a
   separate larger cloud database redesign. No Render/Turso accounts were created.
2. Authorize full-state backup creation in Railway and the exact private download
   destination, including the password verifiers, token fingerprints and personal
   application files. Existing Console access suffices; no new token is needed.
3. Approve secure provisioning of existing SESSION_SECRET, REGISTRATION_CODE and
   enabled provider configuration on this PC. No secret may be copied into chat,
   Git, shell history or the example configuration files. No values were inspected.
4. Install a reviewed Poppler runtime for `pdftotext`/`pdftoppm`; neither executable
   was found on this task's PATH. The resume editor also needs a compatible local
   Playwright browser for its local PDF rendering. Employer preparation itself
   continues in Chrome; these runtimes have not been installed by this task.
5. Verify the actual Chrome helper installation and Stop state, retain its device
   and all pending receipts/attempts, then review the held extension build and a
   same-installation release. Coordinate AP2's exact trusted-origin update as well.
6. Approve the coordinated source freeze, first activation and origin transition.
   The example approval file has every approval false. A JSON flag is an operator
   record of real approval, not permission for an agent to grant approval itself.
   Background work stays paused; resuming preparation is another coordinated action.

There is no public tunnel, firewall change, persistent remote access, scheduled
task, paid resource, Railway deletion or automatic submission in this package.
No original checkout or installed extension was changed. The Supabase intent/crash
remains uncertain and protected; absent receipt evidence never authorizes a retry.

## Validation

The existing full suite passed 635 tests and all four follow-on UI checks with
external network fetches blocked. The synthetic startup smoke test verified
loopback health, no provider calls, no hosted worker and zero changes from paused
background callbacks. Deployment/snapshot/console/held-extension tests passed 16
of 17, with one sandbox-blocked hard-link fixture skipped. The three libSQL
compatibility probes passed. See the logs and `implementation-verification.json`.
