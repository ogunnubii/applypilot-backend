# Railway replacement: compatibility review and offline restore preparation

Prepared 2026-10-14 UTC. No deployment or cutover has occurred.

Implementation follow-up: see `IMPLEMENTATION.md` for the tested native-Windows
fallback, compatibility probe, verified Railway paths, console backup procedure
and exact remaining approvals. That follow-up supersedes the earlier unresolved
path/access statements and code-only-review scope below.

## Decision

The current PC extension workflow can run without a hosted browser. `start.js:5`
supports `LOCAL_BROWSER_ONLY=true`, which skips `worker.js` but retains the API
and discovery loop. The original owner confirmed the selected forms need the
hosted API, database, resume, AI and discovery endpoints, not hosted Chromium.
Actual Chrome activation, helper authentication and its Stop state remain
unverified. Do not interpret this architectural finding as a successful PC run.

The least invasive replacement preserves Node 24, SQLite and a durable filesystem
on one machine. This Windows PC is a possible zero-hosting-charge target, subject
to uptime and an explicitly planned origin transition. A persistent VM would also
fit, but no eligible free VM/account was verified. Neither has been activated.

Render Free plus Turso is a candidate for a **separate database and storage port**,
not a ready migration. A Render deployment of the current app with local SQLite
is unsafe: its filesystem is ephemeral, it sleeps after 15 idle minutes, and free
instances cannot attach a persistent disk. Its own documentation excludes free
instances from production use. [Render free-service documentation](https://render.com/docs/free)

| Option | Compatibility and access status |
| --- | --- |
| Existing Windows PC, one local backend | Preserves SQLite semantics and files. PC must stay available; requires deliberate extension/dashboard origin continuity. No backend started here. |
| Persistent VM, one service replica | Closest cloud fit. A suitable free account, capacity and persistent disk have not been established. |
| Render Free + Turso + durable resume storage | Requires async database access, equivalent transactional guards, upload storage changes, and sleep/restart handling. Accounts and upload storage not verified. |
| Render Free + Neon | Postgres requires a larger SQL/schema/trigger port and the same upload-storage and sleep work. Neon has a free tier; account not verified. [Pricing](https://neon.com/pricing) |
| Existing Netlify Free account | Read-only connector confirmed the account, but found no matching ApplyPilot project. The current always-running server, timers, SQLite and files would need a serverless redesign. |

Turso lists a free plan, but free pricing does not establish application
compatibility or access to an account. [Turso pricing](https://turso.tech/pricing)

## Source and coordination

This is a code-only, independent clone of the original owner's checkout at
`659d4c77cba5bca13cfbefbfa22574108d9ed16b`, branch
`fix/extension-ready-forms`. Its tree is
`37117bb8a6d7d215a5cf01523c8aa481fa2c0d58`. The owner reports that tree is deployed
through merged PR 33/main `fa7ab0f2ff61d53f7fb14f00ac9d7f1768a30a73`, helper 0.6.38.
The initial review commit only added `migration/` files. The follow-up also adds
an opt-in resume-path alias and paused-background mode to the isolated runtime.

The owner's current reported state is: hosted preparation campaign stopped;
Chrome preparation campaign active, target 200, 20 unfinished, 17 selected,
4 ever prepared, 0 currently ready, 5 reported completed. This is a point-in-time
report, not an instruction to start or replay anything. Inform the owner before
any original execution or origin change. AP2 live preparation was paused separately.

The Supabase manual Submit intent followed by a crash on October 13 at 19:22 EDT
is **UNCERTAIN**. No receipt is established. An empty Gmail result does not prove
nonreceipt. Retain the attempt, quarantine, ownership and evidence; never import
it as a fresh application or retry it as part of migration.

## Dependencies that must survive

| Component | Current implementation | Migration requirement |
| --- | --- | --- |
| Authoritative ledger | `db.js`, native `node:sqlite` DatabaseSync, WAL, foreign keys, busy timeout | One authoritative writer; durable committed attempts and reservations before clients act. |
| Database location | `DATABASE_PATH`, default `./data/applypilot.sqlite`; Docker workdir `/app` | Reverify actual Railway volume mount and resolved path; defaults are not production evidence. |
| Resumes and versions | `UPLOAD_DIR`, default `./data/resumes`; paths stored in applicants and resume history | Preserve every current/previous PDF and DOCX and byte hash. Keep `/app/data/resumes` layout or explicitly validate a later path mapping. |
| PDF extraction | Docker installs `poppler-utils`; resume APIs use local files | Equivalent `pdftotext` support and authorized file access on the target. |
| Accounts/session revocation | `auth.js`, users and revoked_sessions tables | Retain account hashes, IDs and revocations. Preserve SESSION_SECRET through a later approved secret-provisioning flow. Do not extract browser tokens. |
| Registration/configuration | SESSION_SECRET, REGISTRATION_CODE, PUBLIC_ORIGIN, SERVICE_ORIGIN, DATABASE_PATH, UPLOAD_DIR | Keep existing values where identity depends on them; review origins deliberately. No secrets read or copied in this task. |
| Timers and provider work | `server.js` starts funnel, answer recovery, pipeline, drafting and notification timers; `start.js` schedules discovery | Importing the server is not a safe preview. Standby validation must not import server/db/worker or start timers. Free-host sleep needs explicit pause/resume behavior. |
| Browser ownership | Chrome extension local records, device owner, attempt/receipt retry queues | Update the same extension installation; preserve records and owner IDs. Do not wipe storage, switch tracked environments blindly or create a replacement device. |
| Cross-app preparation | `preparation-handoff.js`, AP2 origin bridge, revisions and persistent reservations | Fresh ledger and atomic reservation checks must still use the one authority; stale/failed checks hold work. |

Back up the whole schema and **all tables**, including future tables. A jobs-only
export would lose protections: events, external history/tombstones, employer
holds/limits, manual clicks, employer receipts, unresolved-attempt quarantines,
preparation reservations/snapshots, campaigns, continuation queues, applicant
answers/consents/provenance, account and session state must remain intact.

## Why a remote database needs a port

Current callers expect synchronous `.prepare().get/all/run`, `.exec()` and
connection-local JavaScript SQL functions. Explicit `BEGIN IMMEDIATE` transactions
surround submission intent, claims, receipt reconciliation, reservations, history,
campaigns and other state transitions.

The Turso TypeScript reference describes asynchronous operations. Its libSQL
client's write transactions map to `BEGIN IMMEDIATE`, with a five-second
interactive-transaction timeout. Embedded replicas send writes to the primary;
the newer sync package instead has explicit local-first push/pull. These are
different persistence contracts. [Turso SDK reference](https://docs.turso.tech/sdk/ts/reference)

Compatibility inference: changing only the connection URL cannot preserve the
current synchronous call graph or automatically install these JavaScript callbacks
on a remote database. Each guard needs a tested equivalent:

| Callback(s) | Protected behavior |
| --- | --- |
| `same_application` | Exact application identity, duplicate queue and attempt guards |
| `history_company`, `history_title` | Durable company/title matching, including deleted applications |
| `application_employer_key` | Employer limits and security holds scoped to an applicant |
| `application_company_keys`, `company_keys_overlap` | Company-policy identity matching |
| `company_policy_limit`, `company_policy_cutoff` | Existing compatibility functions referenced by schema |
| `preparation_identity_key`, `preparation_identity_match` | Cross-app identity, tombstones and persistent reservation fences |

Do not remove SQL triggers to make an import succeed. Do not replace authoritative
commits with periodic SQLite uploads or local-first background sync. The acceptance
suite for a future port must demonstrate single-winner concurrent claims,
idempotent receipt recovery, unknown outcomes after network loss, persistence over
restart, tenant isolation and unchanged uncertain-attempt protection. Network/provider
calls must remain outside transaction boundaries and no retry may repeat a Submit.

## Exact origin and extension work still needed

Current trusted origins include the Railway origin, `https://applypilot-jobs.pages.dev`,
`https://applypilot-jobs.netlify.app` and `http://localhost:8080` in specific contexts.
They are not interchangeable. The main dependencies are:

- `extension/background.js`: environment API/dashboard URLs and exact trusted origins;
  switching environments is refused when tracked records exist.
- `extension/manifest.json`: host permissions and content-script matches.
- `assistant-client.js`, `web/progress.js`, `web/setup.js`, `public-site.js`:
  Railway fallbacks or public links; check associated UI tests.
- `server.js`: exact CORS allowlist from PUBLIC_ORIGIN/SERVICE_ORIGIN and Pages;
  Authorization and X-ApplyPilot-Device headers.
- AP2 `static/preparation-bridge.js` and its backend trusted-origin constant:
  coordinate both sides and rerun strict bridge/origin tests.
- `package-extension.ps1` and the published extension download: update the existing
  installation, then verify version, persisted device ID, records and receipt retries.

The extension reads the signed dashboard session through its existing supported
bridge; this task did not access that session. A new origin needs the normal
user login flow. Do not copy cookies/tokens, broaden origins with wildcards or
point an extension at a blank database. A same-authority origin rebind must be
designed and tested before changing a tracked installation.

## Offline tool delivered here

`state-snapshot.mjs` uses only Node built-ins and imports no application runtime.
With Node 24.21.0, `node:sqlite.backup` captures committed WAL content. It records
schema and per-table row digests/counts and hashes each PDF/DOCX, checks foreign
keys/integrity, detects observed changes during capture, refuses an existing
destination, and verifies a restore into a new directory. It prints no row values.
Incomplete or altered bundles fail verification. Restore does not start the app,
rewrite paths or release any protection.

Syntax for a later authorized operator, with paths supplied privately:

```text
node migration/state-snapshot.mjs inspect <database>
node migration/state-snapshot.mjs snapshot <database> <resume-directory> <new-bundle-directory>
node migration/state-snapshot.mjs verify <bundle-directory>
node migration/state-snapshot.mjs restore <bundle-directory> <new-restore-directory>
```

No real database or resume was processed in this task. The tool is not encryption
or an authenticated signature scheme. A future bundle contains private account
and application data and must stay outside Git, with verified private filesystem
permissions (POSIX modes alone do not establish Windows ACLs). Its manifest also
contains relative resume filenames. The tool intentionally refuses non-PDF/DOCX
uploads and links; inventory and handle unexpected files separately without
loosening this policy blindly. It hashes rows in memory and is not validated for
large databases. A stable source freeze is still required for a real cutover.

The restore output is `database.sqlite` plus `resumes/` and `RESTORE-VERIFIED.json`.
It is not automatically the application's configured DATABASE_PATH. Do not launch
against the default path and accidentally create a fresh ledger. A partial restore
retains INCOMPLETE and must not be used.

## Later cutover sequence — not authorized or executed now

1. Select and verify the target account, durable database/storage, resource limits
   and normal access. For a remote DB, finish the port and its failure/concurrency
   tests first. Notify the original owner of the proposed execution/origin change.
2. Reverify production paths, deployed code/tree, service replicas and backup
   access without exposing secret values. Stop new campaigns and extension work;
   preserve pending receipt retries and unresolved intents. Do not click Submit.
3. Establish one explicit write freeze covering API timers, worker, Chrome helper,
   AP2 bridge and other writers. Keep all evidence. A stopped hosted campaign alone
   is insufficient because the Chrome campaign was reported active.
4. Take a WAL-aware authoritative backup with resume versions; retain its verified
   manifest privately. Do not copy only a live `.sqlite` file and omit its WAL.
5. Restore into a separate empty standby directory with no running app. Compare
   every table/schema/upload digest. Confirm the Supabase uncertain attempt and
   all reservation/receipt/hold counts and IDs survive; no record becomes fresh.
6. Provision approved configuration privately. Preserve identity secrets and data;
   use normal login on a new origin. Keep one API service replica and one authority.
   Preserve resume paths or prove the mapping before exposing file APIs.
7. Review and test coordinated exact origins, CORS, the dashboard bridge, the same
   extension's owner/records, the AP2 bridge, and rollback URLs. Repackage/update
   that extension installation. Do not start production tests that auto-queue work.
8. Switch only after the original owner/user approves the concrete target and
   transition. Keep the old writer frozen. First verify authenticated read paths,
   file hashes, counts and held attempts; application preparation is a separate
   controlled resumption. Keep Railway and its volume until validated retention
   and rollback requirements are met.

Rollback before any target writes can reselect the unchanged old authority after
stopping the target. Once target writes occur, never reactivate an older Railway
snapshot: first freeze both, preserve target evidence, and reconcile/copy the
latest authoritative state under a verified restore plan. Two writable authorities
would invalidate duplicate and attempt protections.

Do not run `start-local.ps1` as a migration shortcut: it can create credentials and
print a registration code. Do not build from a directory containing `.env*` files;
the existing `.dockerignore` only explicitly excludes `.env`. A future deployment
needs a reviewed clean build context/ignore policy.

## Validation and remaining blockers

See `verification.json` and `verification.log` for the actual local test run.
Tests use synthetic accounts, resumes and attempts only. The restore test uses the
real pure employer/company/handoff installers on the restored fixture to prove
guards remain enforceable. It preserves an uncertain intent without a receipt,
integer/blob data, future tables and resume path strings.

Remaining blockers: target account/storage choice; actual production volume paths;
controlled backup access; remote-database port if selected; exact-origin rebind for
the existing extension; usable PC browser control/activation verification. No
secrets, credentials, payments, production exports, provider calls, applications,
service deletion or cutover were performed.
