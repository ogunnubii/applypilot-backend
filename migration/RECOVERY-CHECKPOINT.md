# Online recovery checkpoint: guarded, not production-qualified

`railway-console-recovery.sh` replaces the earlier full-state console command for
an online recovery use case. It is **not a cutover snapshot** and does
not pause, restart or resume an application, worker or browser. Run only after the
deployment owner verifies the current paths and resource budget. This task has
not executed either script against production.

The generated shell reads cgroup v2 `memory.max` and `memory.current` before Node,
and again after Node exits before tar. Missing, nonnumeric or unbounded values
fail closed. Minimum available headroom is **268,435,456 bytes (256 MiB)**, and
the output filesystem must have at least **256 MiB available disk space** before
each phase. Do not lower these thresholds to make a resource preflight pass.
The earlier 96 MiB floor is superseded: independent Linux tests found substantial
hash-spool allocation in addition to process RSS. See
[LINUX-RECOVERY-RESOURCE-REVIEW.md](LINUX-RECOVERY-RESOURCE-REVIEW.md).
The revised budget remains a conservative admission check, not a reserved cgroup
budget or proof against concurrent growth.

The operator must pass three independently verified absolute paths:

```sh
sh railway-console-recovery.sh /verified/database.sqlite /verified/resumes /verified/output-parent
```

These are placeholders, not deployed path claims. The output parent must exist;
the script creates a unique private bundle beneath it. It no longer embeds source
or output paths. The revised generated program enforces the bounded database,
resume, metadata and scratch-space envelope described below.

## What is copied and checked

- Native `node:sqlite` online backup uses a read-only source connection and small
  batches (`rate:16`). The copied database retains every table and row, including
  uncertain attempts and evidence. It passes `quick_check`, foreign-key checking,
  schema hashing and format-1 sorted row-multiset hashing.
- Row hashes stream into a private on-disk SQLite B-tree, avoiding whole-table
  JavaScript arrays. File hashing uses 64 KiB buffers. Row JSON/hex hashing is
  chunked; SQLite still materializes one row. An 8 MiB SQLite row-length limit
  fails closed on larger rows. V8 flags are old-space24 MiB / semi-space1 MiB.
  These controls do not impose a hard process/cgroup RSS limit.
- Console resource limits admit database images of at most 8 MiB, 849,002 total
  rows (849,000 per table), at most 128 tables, 512 schema objects, 128 columns per
  table and 256 KiB schema text. The hash spool is capped at 96 MiB by SQLite
  `max_page_count`; bounds are checked before expensive hashing and while streaming.
  These are additional conservative input limits, not separately measured peaks
  for every allowed schema combination.
- Source WAL and SHM files are capped at 32 MiB and 1 MiB. Online backup is bounded
  to 4,096 progress steps and 60 seconds; a growing or persistently restarting
  source fails closed. A successful copied image is checked again before hashing.
- Unique referenced resume data is capped at 52 KiB, with bounded file/reference
  counts and path metadata. Growth during reading/copying fails closed. Runtime
  source/output growth and available disk checks are enforced within Node as well
  as at the shell phase boundaries. Offline library APIs retain their existing
  defaults; the generated console entrypoints explicitly require these limits.
- Reference metadata is limited to 1,024 rows, 64 unique files, 4 KiB per path,
  256 KiB combined reference bytes and 32 path components. Manifests are capped at
  1 MiB when the envelope is supplied. The shell rejects archives over 16 MiB before
  reporting success. That final archive-size check is not a kernel write ceiling;
  concurrent disk exhaustion still relies on failure handling and incomplete markers.
- All `applicants.resume_path` and `resume_previous.path` references are read from
  the copied DB. Each unique PDF/DOCX is confined to the verified resume root and
  checked for link/path aliases, source identity, size, modification metadata and
  four matching streamed hashes around copying. Missing, replaced or changed
  referenced files leave `INCOMPLETE`; no successful archive is reported.
- The manifest records DB start/end and per-file observation/copy intervals.
  Files are observed stable individually; DB plus filesystem is not atomic.
  Unreferenced files are omitted. Neither workflow freeze nor future freshness is
  inferred. The copied DB retains the original resume paths without rewriting.
- Node exits before tar, archive listing and SHA-256. Failed stages never print
  `backup_ready:true`; partial private artifacts are retained for diagnosis.
  No source row values are printed.

The snapshot verifier works offline after the live resume files disappear:
`node migration/state-snapshot.mjs verify-recovery <private-extracted-folder>`.
Use a trusted separately recorded archive SHA-256 to authenticate a transferred
bundle. A mutable manifest is not an independent authenticity proof. A recovery
bundle does not authorize starting a second active deployment or replaying work.

## Revised bounded program verification

Generated shell SHA-256:
`98571a4365b6694e025dd28f8e5395b1fd86d5508aeddeee6047e65fca17a49c`.
Exact revised inline Node program SHA-256:
`dee832626ade9f8d31802737c1eaa68d292f307598d39e3137e90a5840f11fbe`.

All four synthetic Windows Node 24.20 benchmark shapes passed with the revised
program: dense 849,000 payload rows, large ASCII text, large BLOB and two-byte text.
Each copied 52 KiB of referenced resume data and passed independent digests plus
offline verification after the synthetic live file was removed. Worst observed
Node peak was 67,899,392 bytes (64.754 MiB). This is not a Linux/cgroup measurement.
The raw synthetic results are in `benchmark-bounded-inline-recovery.log`.

The exact Node 24.20 combined suite passed **72 tests, zero failures**, with
**three existing Windows sandbox link-fixture skips** (75 total). The resource
rejection suite covers growth, row/schema/spool limits, missing
resource probes, free space, aggregate resume bounds and capped stream reads.
The combined recovery regressions are recorded in `recovery-bounded-resource-tests.log`.
The independent revised POSIX/cgroup qualification remains outstanding. Git Bash
could not start inside this Windows sandbox; no alternate access was attempted.

## Earlier Windows evidence, 2026-10-14

Before the Linux resource revision, the tested inline program SHA-256 was:
`1bdecbb3df43eab92b8fcb3a2c21cacf38ddf6ec30cb51a86634141e37129823`.
That earlier generated recovery shell SHA-256 was:
`c4ef8675cc356dd5ec8ee62fce7a6abf5a42a199105d43b4a225582ddbaf1667`.

Official Node24.20.0 Windows x64 was verified against its official ZIP checksum.
Four approximately6.5 MiB DB shapes (849,000 small rows; one large ASCII, binary,
or two-byte-string row) each included52 KiB referenced resume bytes. Two runs of
the same final inline program passed all eight copies, independent format-1
digests, reference counts/hashes and separate offline verification after the
synthetic live file was removed. Worst observed process peak: **63,848,448 bytes
(60.890625 MiB)**. Adding 32 MiB gives 92.890625 MiB. Actual deployment resource
qualification must be performed privately by its operator. Second-run details are in
`benchmark-final-inline-recovery.log`; first-run peak is recorded here.

That Node24.20.0 recovery/snapshot/console suite passed **29 tests**, with
**0 failures and3 skipped** Windows link-creation fixtures denied by the sandbox.
It includes a real independent SQLite connection writing during online backup,
retained uncertain evidence, tampering/missing-reference failures, concurrent
file replacement/deletion, full archive extraction/readback and secret-output
sentinels. The generated POSIX guard is structurally checked locally; POSIX shell
execution and Linux memory/page-cache/tar qualification remain the cloud worker's
responsibility. `rate` controls backup I/O, not RSS. Scratch B-tree file cache,
concurrent application growth, larger real rows/file inventories and Linux
accounting are not covered by Windows RSS measurements.

The previous whole-table serializer was unsafe:849,000 small rows reached about
889.5 MiB RSS with the default heap and aborted under a48 MiB heap. Its script
must not be used. `railway-console-backup.sh` now uses the streaming code too, but
still requires a coordinated complete writer freeze and is not the online
recovery command. No freeze has been inferred from a browser Stop setting.

This artifact has not been qualified or run on a production deployment. Active
workloads and billing limits must not be changed merely to pass a synthetic test.
