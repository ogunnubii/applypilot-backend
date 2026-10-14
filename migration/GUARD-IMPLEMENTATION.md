# SQL-enforced guard checkpoint

The remote-compatible duplicate, claim and receipt schema is implemented as an
inactive prototype in `turso-guard/`. The application still starts on native
SQLite. It has no remote execution switch and this prototype grants no employer
action. Every repository result explicitly sets `submission_allowed:false`.

Claims atomically insert raw identity, SQL-derived indexed identity, permanent
protection, intent and evidence. Only an acknowledged first commit returns
`fresh:true`. Committed-but-lost responses raise an uncertain-outcome error;
readback/replay is never fresh and does not grant another attempt. Identity,
protection, intent, receipt and event mutation fences reject direct replacement,
upsert and deletion, including with recursive triggers disabled. Unknown
protected identities block account claims. Receipt plus submitted event is
atomic and retains later interview/rejection/offer outcomes and original times.

The Unicode normalizer and indexed cache are checked in SQL without JavaScript
UDFs. Both native SQLite and local libSQL match the native oracle over 1,112,063
Unicode scalars, 2,039 complete examples, 103 annotation variants and 144 duplicate
pairs. A 10,000-identity lookup now uses a primary-key index (~0.135 ms measured),
replacing the ~2.3s scan. Imports still need bounded batches under a durable hold.

Full receipt evidence is now validated before insertion or idempotent replay,
without truncation. The SQL predicate matches the native English receipt grammar
and placeholder veto for valid UTF-8 text without NUL, bounded to 8,192 bytes.
Receipt query attribution independently preserves native retained parameters and
duplicate-key order instead of inheriting broader handoff tracking removal.

The isolated AP2 preparation repository requires the latest snapshot revision,
nonfuture age of at most five minutes and a matching current protection digest
on reservation and replay. It checks Stop, account-wide holds, owner, applicant
and identity and atomically writes immutable reservation metadata with the claim.
Paged, bounded projections reject incomplete or malformed protected history.
Accounts without a completed import explicitly state `native_history_imported:false`.
Verified imports identify only a `protected_history_projection`, with the source
snapshot hash; they do not claim runtime migration or account activation.

Generic preparation claims and preparation reconciliation now require the same
snapshot lifecycle. SQL binds each claim to an immutable check with the latest
revision, digest, identity, owner and applicant. An append-only state epoch and
server-clock age checks reject raw INSERT, REPLACE and upsert attempts after
Stop/resume, new protections, holds, external state events or a newer snapshot.
Claim, reservation, protection and event records still commit or roll back together.
The repository recomputes the SHA-256 digest. SQL cannot authenticate that hash
without a hash function, but independently enforces the current epoch and live
protection/hold checks even against fabricated matching digests. Its projection
byte estimate is deliberately conservative: 512 plus six times source bytes per
row, so some otherwise valid native projections are rejected rather than omitted.

The latest `node checks/run-async-tests.mjs` run passed **182 tests**, with zero
failures or skips (32 prior async API/database tests and 150 guard/import tests).
Receipt text has 10,774 native/local-libSQL differential comparisons, receipt
queries have 450 comparisons, 32 tests cover the preparation lifecycle, and
31 tests cover the protected-history importer.
Independent clients, preparation/submission races, restart, Stop, owner
boundaries, direct SQL, partial rollback and lost responses are covered.
An earlier `npm test` run passed 635 native tests, four UI checks and the
then-current 88 async tests. Eleven receipt/compatibility tests also passed.
Official HTTP-driver tests use a synthetic transport; there has been no live
Turso call. Logs: `guard-history-import-tests.log`, `guard-mandatory-snapshot-tests.log`, `guard-final-tests.log`, `guard-full-regression.log` and
`guard-receipt-integration.log`.

This is not full native parity. Unsupported URL forms fail closed. Receipt-path
aliases, focus/campaign/consent/profile/eligibility policy, full application-state
migration, native raw job-transition fences and quota expiry/release remain
unintegrated. The mandatory snapshot fence covers this isolated guard schema;
native production writers are not yet connected to it. The protected-history
importer is connected only to this inactive isolated schema.
Digest recomputation remains repository-owned, with independent SQL epoch and
live-protection enforcement. Runtime DDL administration remains outside this proof.

The trusted offline importer verifies a complete native SQLite image against its
independently retained format-1 manifest, then projects 15 reviewed source tables.
Verification and projection share one pinned readonly source transaction. A
hashes-only disk spool and bounded batches avoid whole-history arrays. Raw
allowlisted evidence and later outcomes remain immutable and separate from claims;
no receipt, intent or permission is inferred from uncertain history. Auth/session,
answers, profile contact fields and resume payloads are excluded from the projection.

An import session installs a durable account hold before reading the source.
Partial batches, changed sources, invalid identities or references, and uncertain
commit responses retain that hold until verified replay completes. Start and
completion advance the snapshot epoch, including empty imports. Pending imports
block all claim/replay/reconcile and preparation export/check paths. A permanent
SQL trigger denies ordinary completion writes; the trusted installer atomically
replaces it only during verified finalization. Completed sessions reject later
evidence inserts. Runtime DDL privileges must be separated before deployment.
Imported active quota holds remain permanent; noncanonical timestamps fail closed.
See `turso-guard/HISTORY-IMPORT.md` for the exact inventory and remaining gates.

The isolated checkout's native `receipt-sync.js` now validates and retains full
receipt text on both hosted and local paths, rejecting invalid encodings,
NUL, evidence over 8,192 UTF-8 bytes and nonaffirmative/placeholder evidence
before first write or replay. Twenty-five targeted native receipt, monitor,
label and unresolved-attempt tests pass with zero failures or skips, including
late contradictions, exact text retention, rollback, later outcome preservation
and unchanged attempt/protection records. See `native-receipt-fulltext-tests.log`.
The original checkout and deployed receipt path have not been changed.

The older async receipt prototype now shares the native full-text validator.
Twenty native/async receipt parity tests pass, including full evidence storage,
invalid replay rejection and later outcome preservation. The broader native
run passed 636 of 643 tests; seven local HTTP tests could not reach their
temporary servers inside the Windows sandbox. An approved loopback rerun of
those test files passed all 26 tests, including all seven previously blocked
cases. These were synthetic local servers, with external fetch disabled.
Evidence: `receipt-parity-fulltext-tests.log` and
`native-receipt-http-regression.log`. No live service was qualified.

The unchanged native trigger compatibility test still correctly rejects libSQL writes with
`no such function: same_application`; the new schema is separate, not installed
over those tables. Authentication/session repositories, the remaining async call
graph, durable resumes and the deployable Render/Turso runtime remain unfinished.

See `turso-guard/README.md` and `turso-guard/native-invariants.md` for exact proof
boundaries. Recovery-script qualification is in `RECOVERY-CHECKPOINT.md`.
