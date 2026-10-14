# Render + Turso implementation checkpoint

Latest checkpoint: [GUARD-IMPLEMENTATION.md](GUARD-IMPLEMENTATION.md) records the
182-test SQL guard and protected-history import prototype. [RECOVERY-CHECKPOINT.md](RECOVERY-CHECKPOINT.md)
supersedes the earlier console-backup memory assumptions and records its current
resource blocker. The sections below preserve the earlier two-API-slice results;
they do not imply the later guard prototype is integrated or production-ready.

The isolated `migration/render-turso-async` branch now has a shared asynchronous
database interface and two complete API slices wired into `server.js`:

- Notification preferences: authenticated GET and PUT, mailbox verification,
  account existence, tenant-scoped failure counts, preference write and readback.
- Professional experience: authenticated list/create/update/delete, ownership,
  explicit factual approval, validation, the 150-record limit, and existing draft
  refresh. Jobs with any `local_attempt_at` remain excluded from refresh. Other
  profiles and accounts are unchanged.

The current server still uses native SQLite. These routes use a dedicated
connection to the same existing database file. The original synchronous modules
and installers remain available to their unported callers. There is no remote
startup switch, local replication/cache, changed origin, deployment or cutover.
Oracle is excluded. Earlier alwaysdata/Oracle candidate sections in the older
checkpoint are superseded; preserved native-host files are historical artifacts.

## Transaction foundation

`database/async-database.js` exposes only `read(callback)` and `write(callback)`.
The callback receives asynchronous `get`, `all` and `run` methods. Operations are
serialized on each adapter, use the driver's transaction handle, and check foreign
keys on that actual connection before invoking application code. Database locks
remain authoritative across connections/processes. The native adapter uses
`BEGIN IMMEDIATE` for writes and zero busy timeout, so competing writes fail
instead of blocking the event loop while another asynchronous callback owns a
lock. Callbacks must contain database operations only.

Nested root calls and parallel statements are rejected. An escaped handle cannot
execute after its scope ends. Pending unawaited operations are drained and cause
rollback. SQL errors poison the current transaction even if application code
catches them. Rollback failure closes the adapter. A lost commit response raises
`database_commit_outcome_uncertain`, without rollback, write retry or a success
response. The API asks for readback; it does not retry a mutation.

Rows normalize integer and binary values across drivers; unsafe integer
conversion is rejected. Numeric column aliases use driver positions correctly.
SQL is developer-owned and bound parameters carry data. This deliberately
restricted first-stage interface accepts single SELECT/INSERT/UPDATE/DELETE/
CREATE/ALTER/DROP statements. It rejects transaction/PRAGMA control, comments
before the first keyword, CTE-leading statements and embedded semicolons. It is
not an arbitrary-SQL parser or a schema migration framework. `run` rejects
returned rows and rolls back; use `get`/`all` for RETURNING. The pinned local
libSQL driver's affected-row metadata for RETURNING is incomplete, so callers
must not infer affected counts from that path.

`database/libsql.js` owns an injected client, or explicitly creates a remote
HTTPS/libSQL client with the pinned `@libsql/client` 0.18.0 driver. It has no file,
sync, offline, environment-reading or automatic retry mode. No remote factory was
called with a real URL or credential during this work. The prior receipt
experiment now reuses this foundation but remains disconnected from submission
execution.

The [official SDK reference](https://docs.turso.tech/sdk/ts/reference) documents
write transactions as BEGIN IMMEDIATE and interactive transaction expiration.
The [official driver source](https://github.com/tursodatabase/libsql-client-ts)
and the installed pinned source informed the connection and error handling.

## Measured scope

| Measure | Completed or remaining |
| --- | --- |
| Bounded API slices selected this stage | 2 of 2 implemented and tested |
| HTTP method operations in those slices | 6 of 6 wired into native server |
| New scoped async SQL call sites | 13 (5 preferences, 8 experience) |
| Existing root modules still containing synchronous database calls | 49 of the original 49 |
| Remaining direct synchronous call sites | 847 versus baseline 852 |
| Existing explicit write-transaction sites still awaiting call-graph port | 41 of 41 |
| Custom SQL function interfaces awaiting remote guard redesign | 10 of 10 |
| Actual Render/Turso deployment or cloud test | 0 |

The inventory is lexical, not a completion percentage. Five root call sites were
replaced; remaining experience/account-policy calls stay for existing native
consumers. New checks and transactions add SQL that was not in the baseline.
The two slices do not imply two of the 49 modules are fully converted. See
`render-turso-inventory.json` and `render-turso-verification.json`.

## Actual validation

- `npm test`: 635 existing tests, four existing UI checks and 32 async tests pass.
- The 32 async tests use native SQLite, real local libSQL and the official HTTP
  driver with a synthetic fetch transport. They include FK rollback, independent
  reader isolation, writer exclusion, concurrent callers, invalid scopes,
  account boundaries, full CRUD, uncertain-attempt preservation and post-write
  failure rollback. Four HTTP-driver tests cover success, partial-write rollback,
  committed-but-lost acknowledgement and transaction expiry.
- Additional integration command: 12 tests pass (eight receipt, three
  compatibility, one actual native HTTP/auth/CORS/restart test). Both ported API
  slices retain state through server restart under the same signed session.
- `git diff --check` passes. Original checkout was read-only verified clean at
  `659d4c77cba5bca13cfbefbfa22574108d9ed16b` after testing.

Logs: `render-turso-full-regression.log`, `render-turso-async-tests.log` and
`render-turso-integration.log`. No provider or employer call occurred. All data
and identity values were fictional fixtures. Windows libSQL fixture files can
remain mapped until process exit; `checks/run-async-tests.mjs` owns deletion in
the parent after the test process exits, rather than skipping cleanup failures.

The initial default-sandbox package install failed DNS resolution; the scoped
approved install fetched the pinned package without scripts. Loopback HTTP tests
used scoped approved execution because the default sandbox restricts sockets.
Dependency audit also identified the already-existing dev-only source-map-js
1.2.1 advisory GHSA-68fv-2mgg-jv7q; this stage did not change that dependency.

## Remaining technical gates

No foundation atomicity test is currently failing. Live Turso latency, limits and
failure behavior remain unverified; the HTTP fixture exercises the driver and
synthetic transport, not a hosted service. Keep write callbacks short and free of
provider I/O; do not split a protected reservation across transactions to fit a
timeout.

The guard compatibility test still demonstrates `no such function:
same_application` on unchanged native triggers under libSQL. It passes by
asserting rejection, not by proving remote guard compatibility. All ten custom
function interfaces require a SQL-enforced redesign and adversarial raw-write
parity before any protected claims or submission path can be activated.

Async schema initialization, authentication/account flows, remaining repositories
and callers, claim/restart reconciliation, durable resume storage and complete
runtime integration remain unfinished. Next bounded stage is async account and
session repository parity plus their complete HTTP callers; do not add a remote
server switch until all startup dependencies are ported. Render account/Turso
resources, free-plan qualification, real service tests, approved production
backup/data transfer and cutover are separate, unperformed gates. Production and
the original execution/origins remain untouched.
