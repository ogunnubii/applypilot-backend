# Online recovery checkpoint: guarded, not production-qualified

`railway-console-recovery.sh` replaces the earlier full-state console command for
an online recovery use case. It is **not a cutover snapshot** and does
not pause, restart or resume an application, worker or browser. Run only after the
deployment owner verifies the current paths and resource budget. This task has
not executed either script against production.

The generated shell reads cgroup v2 `memory.max` and `memory.current` before Node,
and again after Node exits before tar. Missing, nonnumeric or unbounded values
fail closed. Minimum available headroom is **100,663,296 bytes (96 MiB)**.
Do not lower this threshold to make a resource preflight pass.
The threshold is a conservative Windows-derived floor, not a
Linux cgroup safety qualification or reservation against concurrent growth.

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

## Actual local evidence, 2026-10-14

Exact final inline program SHA-256:
`1bdecbb3df43eab92b8fcb3a2c21cacf38ddf6ec30cb51a86634141e37129823`.
Generated recovery shell SHA-256:
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

The exact Node24.20.0 recovery/snapshot/console suite passed **29 tests**, with
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
