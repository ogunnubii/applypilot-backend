# Public hosting migration: implementation checkpoint

No production changes or credential transmission have occurred. The Windows-only
candidate is not a completed migration. This branch now contains an asynchronous
receipt repository for the Turso investigation and an inactive public Linux host
launcher that preserves the current SQLite database and protections.

## Render and Turso: actual scope and feasibility

`node migration/database-inventory.mjs` reproducibly inventories source without
opening a database. `database-inventory.json` records 852 direct `db.prepare` /
`db.exec` call sites across 49 modules, 41 explicit `BEGIN IMMEDIATE` transaction
sites, and 10 distinct JavaScript SQL functions. These are lexical source counts,
not a count of SQL statements or the full transitive caller graph.

An asynchronous rewrite is technically possible. A drop-in Turso replacement
that keeps the current trigger definitions and connection-local JavaScript
functions is not. The native libSQL fixture reproduces the missing
`same_application` function; the official remote SDK exposes neither the original
`.function` method nor its synchronous `.prepare` interface. Converting only
call-site syntax would leave duplicate and reservation guards broken.

The functions cover Unicode/company/role normalization, ATS URL aliases, JSON
identity comparison, SHA-256 identity retention and employer policy keys. Some
historical policy functions are retained even where current limits were relaxed.
The redesign must cover raw inserts/updates as well as API calls, including
identity edits, old deleted attempts, malformed-identity fail-closed behavior,
history imports, shared AP2 reservations and a worker restarting after a lost
response. Do not remove the triggers, use a periodic SQLite-file upload, or treat
an uncertain commit as permission to retry an application.

`turso-probe/async-transactions.mjs` implements an explicit async write transaction
scope with FK verification, rollback, safe integer handling, and an uncertain-
commit result without retries. `receipt-repository.mjs` ports both local and hosted
receipt reconciliation. Eight tests compare retained evidence to the existing
implementation and exercise rollback, invalid ownership/URLs, idempotency, later
outcomes, connection cleanup and lost commit responses. They use the official
pinned client with fictional in-memory libSQL data. No Turso credentials or cloud
calls are used. The repository is intentionally not imported by the app.

Remaining interface groups:

| Group | Scope still required |
| --- | --- |
| Connection and schema | Async initialization of `db.js` and all installers; versioned data import; no silent blank database |
| Call graph | All 49 database modules and their callers; async array predicates/callbacks must be rewritten explicitly |
| Atomic operations | All 41 transaction sites, scoped connection ownership, nested calls, no network work inside long write transactions |
| Database guards | Equivalent remote SQL constraints/triggers for all 10 function interfaces; adversarial raw-write parity |
| Claims and recovery | Concurrent guarded claims, no double dispatch, uncertain-response reconciliation and restart behavior |
| Durable resumes | Authenticated blob persistence, reference/hash integrity, atomic publish, prior-resume retention and deletion rules |
| Runtime integration | Authentication, API, discovery and paused startup; full regressions and cloud failure tests |

Planning estimate, not a measured completion percentage or delivery promise:
roughly 9–18 engineer-days for a complete reviewed Turso redesign: 2–4 for the
async call graph, 4–7 for guard/data migration and claims, 1–3 for durable uploads,
and 2–4 for integration/failure testing. These groups overlap; account access and
real cloud testing are additional unknowns. The completed receipt slice is one
bounded experiment, not evidence that the other 48 modules are ported.

[Turso SDK reference](https://docs.turso.tech/sdk/ts/reference) documents async
transactions. [Available extensions](https://docs.turso.tech/features/sqlite-extensions)
do not provide the application's JavaScript implementations.
[Render Free](https://render.com/docs/free) cannot attach a persistent disk and
loses local files on restart/redeploy/spin-down; its free Postgres expires after
30 days. It cannot safely host this unchanged SQLite application by itself.

## Public host candidate that retains the current database

**First candidate to qualify: alwaysdata Free.** The current official offer lists
1 GB SSD storage, 256 MB RAM, a quarter CPU, three days of backups and an
alwaysdata.net site address for personal use at zero monthly cost.
[Offer](https://www.alwaysdata.com/en/offers/)
The service documents Linux x64 and Node 24 availability.
[Architecture](https://help.alwaysdata.com/en/docs/technical-specifications/architecture/)
[Node configuration](https://help.alwaysdata.com/en/docs/web-hosting/languages/nodejs/configuration/)

This is a candidate, not a verified account or deployment. Confirm the free plan
and personal-use eligibility at signup. No account was created. The 256 MB limit
is a significant gate: measure peak resident memory during real-size PDF
extraction/rendering and resume edits plus the API. Do not disable those features
silently. Confirm disk use including code, dependencies, browser/PDF binaries,
WAL, retained resumes and backups fits the quota with growth headroom. A daily
provider file backup is not a substitute for our verified SQLite online snapshot.

The application's forms continue in the existing PC Chrome helper. The public
API/dashboard/database live on the hosting service. PC-only employer execution
does not remove the server's PDF-rendering dependencies.

**Larger free alternative if the small plan fails qualification:** an Oracle
Always Free VM with its durable block storage and public HTTPS reverse proxy.
The same native launcher supports an `oci` profile. Oracle lists Always Free
compute/block storage, but signup uses a payment card for identity verification,
capacity varies and idle accounts/resources can be reclaimed. No signup or card
action is authorized here. It requires explicit user choice and account approval.
[Oracle Free Tier](https://www.oracle.com/cloud/free/)

## Executable public-host artifacts

- `hosted-deployment.mjs preflight <config.private.json>` reads and verifies the
  restored database, every table/schema digest, original manifest and both current
  and previous resume files. It never creates a blank DB or changes protected rows.
- `hosted-config.example.json` requires an exact HTTPS public origin and the
  provider's listener IP/port. For alwaysdata, copy the IP and port shown in its
  site configuration; the example's loopback values are not runtime evidence.
- `hosted-deployment.mjs activate <config.private.json> <approval.private.json>`
  is a later authorized operator step. It requires Linux/Node 24, existing identity
  configuration, a verified local filesystem, a single API lock, and all bound
  approval attestations. It pauses background work and hosted employer workers,
  uses exact public/service origins, and keeps signup disabled.
- The filesystem check rejects NFS, CIFS, tmpfs, overlay and unknown filesystem
  types. An accepted local filesystem still needs provider evidence of persistence
  across redeploy/restart. Never bypass this check to use ephemeral hosting.
- `host-capability-probe.mjs <NEW-private-scratch-directory>` creates only synthetic
  fixtures. It checks WAL, FK enforcement, two-connection writer exclusion/read
  isolation, rollback/reopen, custom-function duplicate guards and Poppler presence.
  It never certifies TLS, disk durability or PDF/memory suitability by itself.
- `build-held-extension.mjs <NEW-review-directory> https://approved-host` prepares
  an uninstalled review copy for the exact target. It changes host permissions,
  dashboard matches and trusted-origin checks together. Existing records, device,
  pending evidence and `hosted` environment identity are retained. All API calls
  and ticks remain held; installing or releasing it is a separate coordinated step.
- `hosted-http.test.mjs` runs the real app only on loopback with synthetic data and
  a fictional public origin. It verifies exact CORS, login and session continuity
  across restart, with provider calls and workers blocked. It does not verify a
  real host's public TLS or Chrome installation.

No source `server.js` route, trigger or production extension file was changed in
this hosted follow-up. The original checkout remains separate. The full 635-test
app regression result from the preceding implementation still applies to that
unchanged app source; the new migration tests are reported separately.

## Backup destination and explicit gates

The regenerated `railway-console-backup.sh` now explicitly writes its private
bundle and archive inside **/app/data**, the volume verified by the parent. The
earlier commit's command defaulted to `/tmp`; do not confuse that with volume
persistence. Check sufficient free space for both the snapshot and archive first.
The script does not transmit/download data and has not run in Railway.

The user approval being requested by the parent covers creating a private full
backup within Railway and having the **user download it himself**. Do not treat
it as assistant transmission permission or as approval to provision another host.
The database includes salted password verifiers and private applicant content.
No credential values have been inspected. Coordinate source writer freeze and
verify the snapshot before treating it as a cutover source.

Before hosted activation, separately obtain/verify: chosen host account and free
plan; local durable storage and enough disk space; Node/Poppler/browser plus peak
memory tests; managed TLS and exact proxy listener; explicit sensitive-data import
and existing secret provisioning; verified backup; Chrome Stop state, same
extension installation and held evidence review; AP2 origin transition; source
freeze and explicit cutover authorization. Preserve the unresolved Supabase
attempt. Do not delete Railway or resume application preparation as part of this
checkpoint.

## Progress reporting

Percentages below apply to explicit bounded substeps, not to the total migration.
Passing local tests does not count as cloud deployment. See `hosted-verification.json`
for the completed checks and remaining gates. The full Render/Turso integration
is still incomplete and no hosted replacement is active.
