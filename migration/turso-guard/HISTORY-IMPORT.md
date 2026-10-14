# Verified protected-history projection

`importNativeHistory({client,databasePath,manifest,userId,batchSize})` is a trusted
offline installer for this inactive guard schema. It accepts a completed native
SQLite image and independently retained format-1 snapshot manifest. It must never
be pointed at an original or live database. No worker, provider, employer call,
account activation or remote runtime is started by the importer.

## Scope

The reviewed source inventory contains these 15 tables:

- Account/applicant scope: `users`, `applicants` (identifiers only).
- Job evidence: `jobs`, `events`, `autonomous_attempts`, `employer_receipts`,
  `unresolved_attempt_quarantines`, `application_archive`.
- Durable identities: `preparation_handoff_protections`,
  `company_application_activity`, `external_application_history`.
- Preparation history: `preparation_handoff_reservations`,
  `preparation_handoff_snapshots`.
- Employer barriers: `employer_security_holds`, `employer_limits`.

`HISTORY_SOURCE_INVENTORY` is the exact column allowlist. It excludes password and
session material, provider configuration, answers, job notes, applicant contact
fields and resume paths/content. This projection is not a backup: the independently
verified full source bundle must retain every table, row and referenced resume.

Raw allowlisted evidence, native outcomes and protective identities are stored
separately and immutably. An uncertain attempt never becomes a confirmed receipt.
Importing a receipt creates no guard claim, intent, permission or guard receipt.
Later outcomes survive subsequent snapshots and replay of an older source.

## Verification and failure behavior

The installer creates an immutable account import session before opening the
source. A pending session blocks claims, replay/reconciliation and preparation
exports/checks, including raw SQL preparation writes. Accounts with no session
remain explicitly unimported. A verified completion marks only
`history_import_scope='protected_history_projection'`, with its source hash.

The source file hash, schema, all table row-multiset digests, integrity, references
and account scope must verify. Schema/row verification and projection use the same
pinned readonly SQLite transaction. A private hashes-only disk spool avoids
whole-table arrays. Projection pages are limited to 100 rows and 1 MiB, with
256 KiB limits on each raw/plan record. Source identity, hash and WAL checks at
finalization reject concurrent changes even though the pinned view stays stable.

Each bounded batch atomically writes its raw evidence and derived protections.
An interrupted batch rolls back; prior batches remain protective. Replay checks
exact source, inventory, raw rows and every actual projection before completion.
Invalid identities, missing references, inconsistent receipts or noncanonical UTC
timestamps fail closed. Unsupported sources remain held rather than being omitted.

Start and completion each advance the preparation epoch, including empty imports.
An ordinary DML writer cannot forge completion: a permanent deny trigger blocks
completion inserts. After verifying every actual target row, the trusted installer
atomically drops that trigger, writes completion and reinstalls it. Rollback keeps
the hold and trigger; a lost commit response reports uncertainty without retrying.
Completed sessions reject additional inventory, raw evidence, state and applied
markers. Runtime DDL credentials must be separated before any real deployment;
this prototype does not supply that access-control boundary.

## Tests and limits

The integrated `node checks/run-async-tests.mjs` run passed **182 tests**, zero
failures or skips, including **31 importer tests**. External fetches were blocked.
Tests use synthetic native SQLite and local libSQL data, with injected rollback,
lost responses and concurrent WAL mutation. They cover forged completion/outcomes,
raw replacement, changed manifests, account isolation, aliases, hold chronology,
native-written receipts, later outcomes and empty-import epoch invalidation.
Evidence: `../guard-history-import-tests.log`.

Active imported quota holds conservatively remain permanent; their expiry evidence
is retained, but release is unimplemented. Native quota projection is checked
against synthetic native oracles. Unsupported identity forms and noncanonical
timestamps may reject legitimate source data and require explicit review.

The installer covers protected history, not complete native authorization. Focus,
campaign, consent, eligibility, raw native job-transition fences, executable
quarantine handling, authentication/session ports, durable resume hosting, runtime
DDL separation and full async startup remain deployment gates. Every repository
result continues to set `submission_allowed:false`.
