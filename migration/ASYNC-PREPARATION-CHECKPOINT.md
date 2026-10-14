# Async preparation and mandatory history checkpoint

Historical checkpoint. [IMPORTED-RUNTIME-CHECKPOINT.md](IMPORTED-RUNTIME-CHECKPOINT.md)
records the subsequent native import integration, history/Next/receipt API wiring
and updated verification counts.

The isolated server now awaits both preparation handoff operations through the
shared async database adapter. Native SQLite remains the startup database. This
is the third complete API slice, following preferences and professional facts;
eight HTTP method operations are wired. No deployment or original checkout was
changed.

## Completed slice

`api/preparation-handoff.js` performs account validation, full native protection
projection, quota refresh, latest-snapshot validation and reservation in one write
transaction. It retains the native request/response contract and shares native
identity and quota policy functions. Reads are paged at 100 rows and reject
oversized or malformed projections. Compared with the old unbounded intermediate
reads, very large source projections can now fail conservatively before reaching
the public projection cap.

Reservations are persisted in the existing native reservation table. The existing
native SQL fences therefore reject queue, running, local-browser, attempt and
claimed-row insert paths after an async reservation. They are not replaced by a
repository-only check. Unknown receipts, edited identities, deleted tombstones,
external history, employer holds and later outcomes retain their native meaning.
An acknowledged replay is `rechecked`; a lost commit response remains uncertain
and needs a fresh ledger before reconciliation. Neither grants submission.

## Import enforcement

Every new claim, preparation snapshot and preparation check in the isolated SQL
guard now requires a verified history completion with no pending imports. Zero
import sessions is a blocked state, including raw INSERT, REPLACE and upsert.
Repository replay/reconciliation also fails closed. Unit fixtures now run the real
offline importer against complete, synthetic empty source images; they do not
forge completion records or disable the gate.

Attributable receipts from an existing intent remain recordable during a later
incomplete import. This preserves evidence without granting new work. A protected
history completion still covers only its reviewed projection, not authentication,
profiles, complete runtime tables or resumes.

`openRemoteDatabase` now rejects all remote runtime activation with
`database_remote_runtime_not_qualified` before constructing a client. There is no
configuration/argument bypass. The injected-client adapter remains available to
isolated tests and trusted tooling; this code boundary is not a substitute for
separate runtime database privileges. Full runtime import and all writer ports
must exist before enabling a remote startup path.

## Dependency map

| Dependency | Current evidence | Work still required |
| --- | --- | --- |
| Async transaction foundation | SQLite/local libSQL and synthetic official HTTP transport | Real remote transaction/persistence qualification |
| API slices | Preferences, professional facts and preparation ledger/reservation | Remaining APIs, background tasks and workers |
| Mandatory application guards | Native preparation reservations fence existing native job/attempt writes; isolated guard fences its own claim graph | Wire every remote application writer to equivalent guards; port all native transition policies |
| Import | Verified 15-source protected-history projection; missing/pending imports block claims | Complete runtime schema/data import, authority and count/hash verification, resume restoration |
| Authentication and consent | Existing native boundary retained | Async authentication/session, owner, Stop, focus, campaign, profile, consent and eligibility checks |
| Storage | Offline snapshot tooling with bounded recovery resource checks | Authorized consistent backup and durable cloud resume storage |
| Startup and deployment | Native startup only; remote factory closed | Async installers/schedulers, schema-version gates, privilege separation, Render/Turso account setup, end-to-end qualification |

The fresh source-only inventory is `async-preparation-inventory.json`: 49 root
modules still contain 847 direct synchronous database call sites, 41 explicit
write transactions and 10 registered SQL function interfaces. Retained native
implementations still serve other callers and parity tests, so this lexical count
does not decrease merely because an HTTP route now awaits an async repository.
The three API modules contain 22 scoped SQL call sites, including a paged query
helper. These are source counts, not a percentage-complete claim.

Next critical dependency: receipt reconciliation and native job-transition writers
must be ported with their persisted guards, then queue/claim, ownership, campaign
and scheduling paths. Merely swapping the connection or importing the protected
projection cannot qualify those paths.

## Verification

- `async-preparation-import-tests.log`: 199 passed, zero failures/skips. Includes
  14 new API/factory tests and two new import-enforcement tests; 34 importer tests
  in total. SQLite and local libSQL cover native parity, all native reservation
  fences, account isolation, paged history, quota rollback, races, reconnect and
  lost commit responses. External fetches were blocked.
- `native-preparation-regression.log`: 22 passed, zero failures/skips across
  native preparation, employer quota and full-text receipt suites.
- `async-preparation-api-regression.log`: 3 passed, zero failures/skips, covering
  live loopback API/auth/origin and bridge behavior. Only synthetic temporary databases and local test servers
  were used; background jobs were paused and external fetches blocked.

No employer action, provider call, credential read/change, production backup,
origin change, installed-extension update or cutover occurred.
