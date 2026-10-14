# Migration preparation and operator handoff

This package contains isolated migration prototypes and synthetic verification.
No replacement runtime has been deployed or activated. The requested public-host
candidate and its remaining gates are described in [HOSTED-MIGRATION.md](HOSTED-MIGRATION.md).
The earlier Windows Node/SQLite candidate remains available for review but depends
on PC uptime and does not satisfy the public-host requirement.

## Compatibility and prepared components

`turso-probe/` pins `@libsql/client` 0.18.0. The native guard installer requires
application-defined SQLite functions and synchronous statements that this client
does not expose. The unchanged native triggers reject the compatibility probe
with `no such function: same_application`. A cloud port therefore needs an async
call graph and equivalent SQL guards. Removing native protections or periodically
uploading SQLite files does not provide that equivalence.

The separate inactive `turso-guard/` prototype and its exact proof boundaries are
documented in [GUARD-IMPLEMENTATION.md](GUARD-IMPLEMENTATION.md). Local libSQL tests
and synthetic HTTP-driver tests do not qualify a live cloud service.

The prepared native fallback includes:

- `local-deployment.mjs preflight`: read-only restored-state verification against
  the backup manifest, including all referenced current and previous resumes.
  Missing or incomplete state fails closed; it does not initialize a blank DB.
- `storage-paths.js`: explicit old-to-restored upload-root mapping while preserving
  stored paths, ledger rows and path-dependent saved-answer fingerprints.
- `APPLYPILOT_BACKGROUND_TASKS=paused`: disabled discovery/worker startup and
  background callbacks in migration mode.
- `start-local-migration.ps1`: preflight by default; separate approval record and
  private identity provisioning before activation. It requires Node 24 and Poppler,
  binds loopback, uses a single API lock, disables public signup and pauses work.
  Stale runtime locks require operator review; there is no automatic process kill.
- `build-held-extension.mjs`: an offline held build for the same extension
  installation. It preserves records, device state and pending receipts while
  blocking requests and background ticks. It is not installed or released.

## Runtime discovery and private state

An operator must independently verify the actual database path, upload path,
persistent mount, running writers and supported authenticated export mechanism.
Source-code defaults are not evidence of deployed paths. Keep resource identifiers,
live inventories, access observations and private runtime measurements outside
source control. Do not infer access from a connected-computer indicator.

Schema inspection shows that a full-state backup can contain password verifiers,
revoked-session token fingerprints, authentication rate-limit records and personal
application data. Free-text contents may contain further sensitive material.
Environment provisioning is separate from database backup authorization.

Use only the operator-approved private destination and transfer route. Do not print
or publish archive contents, copy environment secrets into examples, or read masked
configuration and browser tokens. Keep local state outside source and cloud-sync
folders with restrictive permissions. Retain the verified source bundle separately
for rollback; persistent local disk is not replicated storage.

## Recovery and activation gates

Use [RECOVERY-CHECKPOINT.md](RECOVERY-CHECKPOINT.md) for the streaming online-recovery
procedure and its independently enforced memory preflight. The recovery script
requires explicit runtime paths and SQLite's backup API. Never substitute a raw
copy of a live base database: committed state can still reside in the WAL.

Recovery is distinct from cutover. An online database backup and upload scan cover
an interval and do not prove a coordinated atomic database/filesystem snapshot.
Synthetic Windows tests do not establish Linux cgroup memory behavior, supported
hosted access or a successful production backup.

Before any activation, the operator must:

1. Verify supported access and actual runtime paths, then obtain applicable
   authorization for credential-bearing backup creation and private transfer.
2. Produce and verify a WAL-consistent database backup and every referenced current
   or previous resume. Verify the archive hash and restored manifest privately.
3. Coordinate all source writers and preserve uncertain intents, pending receipts,
   attempts, reservations, outcomes and duplicate protections. Missing receipt
   evidence never grants permission to retry an uncertain attempt.
4. Compare the restored protected history and run preflight with no activation.
   Verify authentication/session continuity and privately provision only approved
   existing identity configuration.
5. Verify required local runtimes and the actual helper installation/Stop state.
   Review trusted origins, cookies, CORS and bridge behavior while preserving the
   same extension installation and device identity.
6. Obtain and record the coordinated activation/origin transition decision. An
   approval-file flag records a human decision; it cannot grant that decision.
   Resume background preparation only as a separately coordinated action.

No public tunnel, firewall change, persistent remote access, paid resource,
production deletion, application submission or original-checkout change is part
of this preparation package.

## Validation

The earlier native baseline passed 635 tests and four UI checks with external
fetches blocked. Synthetic startup smoke tests verified loopback health, paused
background behavior and no provider calls. The initial deployment/snapshot/console/
held-extension checks passed 16 of 17 tests, with one sandbox-blocked hard-link
fixture skipped. See `implementation-verification.json` for that checkpoint.

Newer recovery, receipt and SQL-guard results and their limitations are recorded
in [RECOVERY-CHECKPOINT.md](RECOVERY-CHECKPOINT.md) and
[GUARD-IMPLEMENTATION.md](GUARD-IMPLEMENTATION.md). These results do not claim
production access, a completed backup, full migration parity or cutover readiness.

